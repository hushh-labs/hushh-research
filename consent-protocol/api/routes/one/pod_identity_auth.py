"""Verify that a caller is a hussh pod -- the one place that check is written.

Extracted from ``agent_prompt.py`` when the heartbeat route became a second caller.
Duplicating it would have meant two copies of a security check that must agree
exactly; the second copy is where the ``email_verified`` clause, or the
allowed-service-account lookup, quietly goes missing.

What a verified pod identity proves, precisely
----------------------------------------------
The credential is a Google ID token minted from the instance metadata server,
audience-bound to this hub. Verifying it establishes that the caller holds the pod
runtime service account. BYOC additionally matches that account to the registry's
runtime identity for the asserted HusshID. The managed/simulation path instead
accepts a configured shared fleet account: there the header remains an assertion,
not independent owner proof. Neither path establishes workload attestation or
information/action permission; callers retain those route-specific checks.
Acceptance is gated by ``pod_hub_identity_auth_enabled``.

The cloud-neutral path
----------------------
Routes call :func:`verify_pod_request`. A request signed with the pod's own
Ed25519 key (``pod_request_signing``) is verified against the key the hub pulled
itself from the pod's recorded address (``pod_request_verifier``); that works on
every cloud and is owner-bound by construction. The Google ID token above remains
the transitional path, accepted only for a row that has never signed: the first
valid signature latches the row, and from then on a Google-only request from it is
refused. A present-but-invalid signature is refused outright, never downgraded.

Two placements (STANDBY-SYNC.md E4): routes are turn or write paths by default and
accept only the primary's key; a sync route passes ``sync_path=True`` to admit the
standby's key as well. A person with a standby or ``placement_epoch > 0`` is latched
to signed requests (adding a standby and every switch latch the row), so the Google
path never speaks for either placement.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import parse_qsl

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from hushh_mcp.runtime_settings import (
    pod_hub_allowed_service_account,
    pod_hub_expected_audience,
    pod_hub_identity_auth_enabled,
)
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER, VerifiedOwnerPod
from hushh_mcp.services.pod_placement_fence import row_epoch
from hushh_mcp.services.pod_request_signing import SIGNATURE_HEADER, VerifiedPod
from hushh_mcp.services.pod_request_verifier import (
    SignedOutcome,
    SignedRequest,
    SignedVerification,
    verify_signed_request,
)

logger = logging.getLogger(__name__)


async def verify_pod_request(
    request: Request,
    authorization: Optional[str],
    *,
    owner_bound: bool = False,
    registry: Any = None,
    store: Any = None,
    refresh: Any = None,
    standbys: Any = None,
    sync_path: bool = False,
) -> Optional[VerifiedPod]:
    """The verified pod behind this request, or None. Never raises.

    ``owner_bound`` demands evidence that distinguishes this pod from every other
    one: a valid signature, or (transitionally) a BYOC service account bound to the
    row. The managed fleet account never satisfies it. ``sync_path`` admits the
    standby placement's key; only standby-sync routes may pass it.
    """
    if not pod_hub_identity_auth_enabled():
        return None
    signed = await _verify_signature(
        request,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
        sync_path=sync_path,
    )
    if signed.outcome is SignedOutcome.VERIFIED:
        return signed.pod
    if signed.outcome is SignedOutcome.INVALID:
        return None
    google = await verify_pod_identity(request, authorization, owner_bound=owner_bound)
    if not google:
        return None
    pod = (
        VerifiedPod(google.hushh_id, service_account=google.service_account)
        if isinstance(google, VerifiedOwnerPod)
        else VerifiedPod(str(google))
    )
    if await _latched_to_signed(pod.hushh_id, signed.row, registry):
        logger.warning("pod_hub_auth.rejected_identity reason=signed_latch")
        return None
    return pod


async def _verify_signature(
    request: Request,
    *,
    registry: Any,
    store: Any,
    refresh: Any,
    standbys: Any = None,
    sync_path: bool = False,
) -> SignedVerification:
    """Run the signed path, or report UNSIGNED without touching body or registry."""
    if not str(request.headers.get(SIGNATURE_HEADER) or "").strip():
        return SignedVerification(SignedOutcome.UNSIGNED)
    try:
        signed_request = SignedRequest(
            headers=request.headers,
            method=request.method,
            path=request.url.path,
            query_pairs=parse_qsl(request.url.query, keep_blank_values=True),
            body=await request.body(),
        )
    except Exception as exc:  # noqa: BLE001 - an unreadable request is not a pod
        logger.info("pod_hub_auth.unreadable_signed_request %s", type(exc).__name__)
        return SignedVerification(SignedOutcome.INVALID)
    return await verify_signed_request(
        signed_request,
        aud=pod_hub_expected_audience(),
        registry=registry or _registry(),
        store=store or _identity_store(),
        refresh=refresh or _refresh_pod_key,
        standbys=standbys or _standby_store(),
        sync_path=sync_path,
    )


async def _latched_to_signed(hushh_id: str, row: Optional[dict], registry: Any) -> bool:
    """Whether this row has ever signed. An unreadable row counts as latched."""
    if not isinstance(row, dict) or str(row.get("hushh_id") or "") != hushh_id:
        try:
            row = await (registry or _registry()).get_by_hushh_id(hushh_id)
        except Exception as exc:  # noqa: BLE001 - cannot rule the latch out: refuse
            logger.warning("pod_hub_auth.latch_read_failed %s", type(exc).__name__)
            return True
    if str((row or {}).get("identity_mode") or "") == "signed":
        return True
    epoch = row_epoch(row)
    return epoch is None or epoch > 0  # a switched (or unreadable) epoch is latched


def _registry() -> Any:
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    return PersonalAgentRegistryRepo()


def _identity_store() -> Any:
    from hushh_mcp.services.pod_request_identity_store import (  # noqa: PLC0415
        PodRequestIdentityStore,
    )

    return PodRequestIdentityStore()


def _standby_store() -> Any:
    from hushh_mcp.services.personal_agent_standby_store import (  # noqa: PLC0415
        PersonalAgentStandbyStore,
    )

    return PersonalAgentStandbyStore()


async def _refresh_pod_key(row: dict) -> Any:
    from hushh_mcp.services.pod_key_collector import refresh_pod_key  # noqa: PLC0415

    return await refresh_pod_key(row)


async def verify_pod_identity(
    request: Request, authorization: Optional[str], *, owner_bound: bool = False
) -> str | VerifiedOwnerPod | None:
    """The pod's asserted HusshID once its token verifies, else None (transitional path).

    Returns None -- never raises -- for every failure mode, so each caller decides
    what a non-pod caller means for its own route. The prompt route falls through to
    consent-token auth; the heartbeat route, which has no non-pod caller, refuses.
    """
    if not pod_hub_identity_auth_enabled():
        return None
    allowed = pod_hub_allowed_service_account()
    if not allowed:
        logger.warning("pod_hub_auth.no_allowed_service_account configured; refusing")
        return None
    asserted = str(request.headers.get(POD_IDENTITY_HEADER) or "").strip()
    if not asserted or not authorization:
        return None

    token = authorization.removeprefix("Bearer ").strip()
    try:
        from google.auth.transport import requests as google_requests  # noqa: PLC0415
        from google.oauth2 import id_token as google_id_token  # noqa: PLC0415

        # AUDIENCE IS VERIFIED. Without it, `verify_oauth2_token` checks only that
        # Google signed the token -- so an ID token the pod SA minted for ANY other
        # service would be accepted here. A pod mints its hub token audience-bound
        # (`pod_hub_client._identity_token` passes `audience=self._base`) precisely
        # so a token cannot be replayed elsewhere; not checking `aud` on this side
        # threw that property away and left the whole check resting on the email.
        audience = pod_hub_expected_audience()
        if not audience:
            logger.warning("pod_hub_auth.no_expected_audience configured; refusing")
            return None
        claims = await run_in_threadpool(
            google_id_token.verify_oauth2_token,
            token,
            google_requests.Request(),
            audience,
        )
    except Exception as exc:  # noqa: BLE001 - an unverifiable token is simply not a pod
        logger.info("pod_hub_auth.verify_failed %s", type(exc).__name__)
        return None

    email = str(claims.get("email") or "")
    if not claims.get("email_verified"):
        logger.warning("pod_hub_auth.rejected_identity reason=email_unverified")
        return None

    if email == allowed and owner_bound:
        return None

    if email == allowed:
        # MANAGED / SIMULATION TIER. Every pod shares this one account -- which is
        # exactly what lets it hold no project roles -- so a match proves "a hussh pod
        # is calling" and never *which*. `asserted` is therefore returned unverified
        # here, as it always has been: both halves come from the same caller, so this
        # is a consistency check against misconfiguration, not a second independent
        # verification. Do not document it as one.
        logger.info("pod_hub_auth.accepted tier=managed asserted_agent_id=%s", asserted)
        return asserted

    # BYOC. The pod runs as an account in the OWNER's project, derived per person, so
    # the email is no longer fleet-shared and CAN distinguish one pod from another.
    # Binding it to the HusshID this caller asserts turns the header into a real
    # control for the first time: presenting user B's token no longer lets a caller
    # assert user A, because A's row records a different account.
    #
    # Reached only when the fleet account did not match, so the managed tier pays no
    # registry read on any call -- and BYOC pays one only on the path that would
    # otherwise have been an outright rejection.
    bound = await _bound_service_account(asserted)
    if bound and email == bound:
        logger.info("pod_hub_auth.accepted tier=byoc asserted_agent_id=%s", asserted)
        return VerifiedOwnerPod(asserted, email) if owner_bound else asserted

    logger.warning("pod_hub_auth.rejected_identity reason=email_not_bound")
    return None


async def _bound_service_account(hushh_id: str) -> Optional[str]:
    """The service account recorded for this HusshID's pod, if any.

    Returns None -- never raises -- on any failure. A registry hiccup must not become
    an authentication BYPASS, and it must not become an outage either: None simply
    means the caller is not recognised, which is the same fail-closed answer this
    function gives for an unknown pod.
    """
    if not hushh_id:
        return None
    try:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        row = await PersonalAgentRegistryRepo().get_by_hushh_id(hushh_id)
    except Exception as exc:  # noqa: BLE001 - an unreadable registry is not a pod
        logger.warning("pod_hub_auth.registry_read_failed %s", type(exc).__name__)
        return None
    metadata = (row or {}).get("backend_metadata")
    if not isinstance(metadata, dict):
        return None
    account = str(metadata.get("runtime_service_account") or "").strip()
    return account or None
