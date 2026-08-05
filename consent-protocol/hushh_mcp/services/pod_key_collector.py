"""Hub-side collection of a pod's public key -- the step that finishes provisioning.

A pod provisioned automatically off phone verification has no public key at
creation time, because the pod generates its own inside its runtime and Hushh only
ever sees the public half. ``provision()`` therefore stops at ``connecting``. This
module is what moves it to ``provisioned``: the hub fetches the key from the pod
and records it, then the standing ``pkm.read`` is minted.

THE DIRECTION IS THE SECURITY PROPERTY. The hub PULLS, from the URL it wrote into
``backend_metadata`` itself when it created the Cloud Run service. That address
comes from the Cloud Run API response, never from a caller. So there is no
asserted identity to verify and none to forge: whatever answers that URL is, by
construction, that user's pod. A pushed registration would have needed the hub to
answer "which pod is calling?", and with a fleet-wide shared service account it
cannot -- an ID token proves fleet membership only.

Everything here is best-effort by design. A pod that is still booting, has been
reaped, or cannot be reached simply leaves the row in ``connecting``, which is the
honest state for it, and the next call tries again. Nothing raises into the
caller: this runs behind a status read and a background sweep, neither of which
should fail because a pod is slow.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

_PUBLIC_KEY_PATH = "/pod/public-key"
_TIMEOUT_SECONDS = 5.0

# Only a row in this state is waiting on a key. 'provisioning' has not been handed
# a host yet and 'provisioned' already has a key -- fetching for either would be
# work with no possible effect.
_COLLECTABLE_STATUS = "connecting"


def _pod_url(row: dict) -> Optional[str]:
    """The pod's URL as the HUB recorded it. Never taken from a request."""
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict):
        return None
    url = str(metadata.get("url") or "").strip().rstrip("/")
    # Refuse anything that is not plainly an HTTPS origin. This value is written by
    # our own backend adapter, so a non-HTTPS value means something upstream is
    # wrong -- and a URL is the one input here that decides who we hand a fetch to.
    if not url.startswith("https://"):
        return None
    return url


def _identity_token(audience: str) -> Optional[str]:
    """An ID token for the pod's audience, from the hub's own runtime identity.

    Pods are ``internal`` ingress and grant ``run.invoker`` to the hub's runtime
    service account, so the hub authenticates as itself -- no shared secret exists
    or is needed in either direction.
    """
    try:
        import google.auth.transport.requests
        import google.oauth2.id_token

        request = google.auth.transport.requests.Request()
        return google.oauth2.id_token.fetch_id_token(request, audience)
    except Exception as exc:  # noqa: BLE001 - unauthenticated fetch is simply refused
        logger.info("pod_key_collector.identity_token_failed %s", type(exc).__name__)
        return None


async def fetch_pod_public_key(row: dict, *, session: Any = None) -> Optional[dict[str, str]]:
    """Ask the pod for its public key. None on any failure -- never raises."""
    url = _pod_url(row)
    if not url:
        return None

    if session is None:
        import requests as session  # noqa: PLC0415 - deferred so tests can inject

    token = await run_in_threadpool(_identity_token, url)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    try:
        response = await run_in_threadpool(
            lambda: session.get(
                f"{url}{_PUBLIC_KEY_PATH}", headers=headers, timeout=_TIMEOUT_SECONDS
            )
        )
    except Exception as exc:  # noqa: BLE001 - a pod that is still booting is not an error
        logger.info("pod_key_collector.unreachable %s", type(exc).__name__)
        return None

    if getattr(response, "status_code", 0) != 200:
        logger.info("pod_key_collector.non_200 status=%s", getattr(response, "status_code", 0))
        return None

    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        logger.info("pod_key_collector.unparsable_body")
        return None
    if not isinstance(body, dict):
        return None

    public_key = str(body.get("podPublicKey") or "").strip()
    key_id = str(body.get("podKeyId") or "").strip()
    if not public_key or not key_id:
        logger.info("pod_key_collector.incomplete_payload")
        return None

    payload = {"podPublicKey": public_key, "podKeyId": key_id}
    wrapping = str(body.get("podKeyWrappingAlg") or "").strip()
    if wrapping:
        payload["podKeyWrappingAlg"] = wrapping
    return payload


async def collect_pod_key_if_pending(
    row: Optional[dict],
    *,
    service: Any = None,
    session: Any = None,
    allow_rotation: bool = False,
) -> Optional[str]:
    """Try to finish provisioning for ``row``. Returns the new status, or None.

    None means "nothing changed", which covers every uninteresting case: no row,
    a row not waiting on a key, a pod that is not up yet, a refused key. Callers
    treat None as "carry on with what you already had".

    ``allow_rotation`` widens what is collectable: a ``provisioned`` row is also
    re-fetched, and a DIFFERENT key rotates the record instead of being refused.
    This is safe precisely because of the pull direction -- the fetch goes to the
    URL the hub recorded at service creation, so a new key at that address means
    the pod restarted, not that someone is impersonating it. The cheap poll path
    (``/status``) keeps the default; the reconcile sweep passes True so restarted
    pods converge instead of drifting from the registry forever.
    """
    if not isinstance(row, dict):
        return None
    status_now = str(row.get("status") or "").strip()
    collectable = {_COLLECTABLE_STATUS, "provisioned"} if allow_rotation else {_COLLECTABLE_STATUS}
    if status_now not in collectable:
        return None
    user_id = str(row.get("user_id") or "").strip()
    if not user_id:
        return None

    payload = await fetch_pod_public_key(row, session=session)
    if payload is None:
        return None

    if service is None:
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

        service = PersonalAgentProvisioningService(registry=PersonalAgentRegistryRepo())

    try:
        result = await service.attach_pod_public_key(
            user_id=user_id,
            pod_public_key_b64=payload["podPublicKey"],
            pod_key_id=payload["podKeyId"],
            allow_rotation=allow_rotation,
            **(
                {"pod_key_wrapping_alg": payload["podKeyWrappingAlg"]}
                if "podKeyWrappingAlg" in payload
                else {}
            ),
        )
    except Exception:
        # On the default path this includes the deliberate refusal to rebind an
        # already-recorded key. Logged, not raised: the row stays where it is and
        # the caller's own answer is unaffected.
        logger.exception("pod_key_collector.attach_failed")
        return None

    status = str(result.get("status") or "").strip() or None
    logger.info(
        "pod_key_collector.attached status=%s rotated=%s", status, bool(result.get("rotated"))
    )
    return status


async def refresh_pod_key(
    row: Optional[dict],
    *,
    service: Any = None,
    session: Any = None,
) -> Optional[str]:
    """Reconcile-sweep entry: re-pull a pod's key and rotate the record if it moved.

    Exists so the sweep never has to remember the rotation flag -- the intent is in
    the name. Same return contract as :func:`collect_pod_key_if_pending`.
    """
    return await collect_pod_key_if_pending(
        row, service=service, session=session, allow_rotation=True
    )
