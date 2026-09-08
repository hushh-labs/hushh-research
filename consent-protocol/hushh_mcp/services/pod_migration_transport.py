"""How the hub reaches the two pods, and what it is allowed to see on the way.

TWO TOKENS, ONE REQUEST
-----------------------
Every call carries two Google-signed ID tokens for the same hub identity:

``Authorization``
    audience = the pod's Cloud Run URL. **Cloud Run** validates this against the
    service's IAM policy before the request reaches the pod process. It answers
    "may this caller invoke this service".

``X-Hussh-Hub-Proof``
    audience = ``hussh-pod-migration:<hushh_id>``. The **pod** validates this.
    It answers "was this call meant for THIS person's agent". A proof minted for
    one pod is useless at another, which a URL audience could not give us --
    every pod in a fleet would accept a URL-audience token shaped like any other.

The second one exists because the first is a property of the platform's config,
and platform config is exactly what a misconfiguration changes.

WHAT THIS MODULE MAY NOT DO
---------------------------
It moves a bundle it cannot open. There is no decryption path here and there
must never be one: the moment the hub can read a migration bundle, "hushh does
not read this pod" stops being true for the one minute that matters most. The
verification the hub performs is a hash comparison, which needs no key at all --
that is not a limitation worked around, it is the design.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_EXPORT_TIMEOUT_SECONDS = 180.0
_IMPORT_TIMEOUT_SECONDS = 300.0


class PodMigrationTransportError(RuntimeError):
    """A pod could not be reached, or refused. Carries only bounded diagnostics."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def hub_proof_audience(hushh_id: str) -> str:
    """The audience the pod will check. One definition, imported by both sides.

    Re-deriving this string on the hub would make the two ends agree by
    coincidence rather than by construction, and a one-character drift would
    show up as a 403 with no obvious cause.
    """
    from api.routes.one.pod_migration import hub_proof_audience as pod_side

    return str(pod_side(hushh_id))


def _mint_id_token(audience: str) -> Optional[str]:
    """A Google-signed ID token for the hub's own identity, for one audience."""
    try:
        import google.auth.transport.requests  # noqa: PLC0415
        import google.oauth2.id_token  # noqa: PLC0415

        request = google.auth.transport.requests.Request()
        token = google.oauth2.id_token.fetch_id_token(request, audience)
        return str(token) if token else None
    except Exception as exc:  # noqa: BLE001 - an unauthenticated call is simply refused
        logger.info("pod_migration_transport.token_failed %s", type(exc).__name__)
        return None


def _headers(
    pod_url: str, hushh_id: str, *, minter: Any = None, proof_audience: Optional[str] = None
) -> dict[str, str]:
    mint = minter or _mint_id_token
    invoke = mint(pod_url)
    proof = mint(proof_audience or hub_proof_audience(hushh_id))
    if not invoke or not proof:
        # Refuse rather than send a half-authenticated request. A call missing
        # the proof would be rejected by the pod as a 403, which reads like a
        # misconfigured allowlist and sends an operator looking in the wrong
        # project entirely.
        raise PodMigrationTransportError(
            "HUB_IDENTITY_UNAVAILABLE",
            "the hub could not mint its own identity token for this pod",
        )
    return {
        "Authorization": f"Bearer {invoke}",
        "X-Hussh-Hub-Proof": f"Bearer {proof}",
        "Content-Type": "application/json",
    }


def _post(
    pod_url: str,
    path: str,
    hushh_id: str,
    payload: dict[str, Any],
    *,
    timeout: float,
    session: Any = None,
    minter: Any = None,
    proof_audience: Optional[str] = None,
) -> dict[str, Any]:
    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        client = requests

    url = f"{pod_url.rstrip('/')}{path}"
    try:
        response = client.post(
            url,
            json=payload,
            headers=_headers(pod_url, hushh_id, minter=minter, proof_audience=proof_audience),
            timeout=timeout,
            allow_redirects=False,
        )
    except PodMigrationTransportError:
        raise
    except Exception as exc:  # noqa: BLE001 - an unreachable pod is not a 500
        raise PodMigrationTransportError(
            "POD_UNREACHABLE", f"the pod did not answer ({type(exc).__name__})"
        ) from None

    status = int(getattr(response, "status_code", 0) or 0)
    if status != 200:
        # Error bodies may contain owner information or credentials. In
        # particular a redirect must never forward the custom hub proof header.
        raise PodMigrationTransportError(
            f"POD_REFUSED_{status}", f"the pod refused the request (HTTP {status})"
        )
    try:
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("invalid response shape")
    except Exception:  # noqa: BLE001 - parser errors can quote the response
        raise PodMigrationTransportError(
            "POD_RESPONSE_INVALID", "the pod returned an invalid response"
        ) from None
    return body


def fence_for_erasure(
    *, pod_url: str, payload: dict[str, Any], session: Any = None, token_minter: Any = None
) -> dict[str, Any]:
    """Carry the hub's exact reserved attempt; never a general migration proof."""
    from api.routes.one.pod_migration import erasure_proof_audience

    result = _post(
        pod_url,
        "/pod/migration/erasure/fence",
        payload["hushhId"],
        payload,
        timeout=60,
        session=session,
        minter=token_minter,
        proof_audience=erasure_proof_audience(payload),
    )
    if result != {"status": "fenced", **payload}:
        raise PodMigrationTransportError(
            "POD_RESPONSE_INVALID", "erasure fence acknowledgement mismatch"
        )
    return result


def export_from(
    *,
    pod_url: str,
    hushh_id: str,
    recipient_public_key: str,
    recipient_key_id: str,
    session: Any = None,
    token_minter: Any = None,
) -> dict[str, Any]:
    """Ask the SOURCE pod to seal its log for the destination.

    Returns the envelope plus the source's receipt (head sha, record count). The
    envelope is ciphertext; the receipt is coordinates. The hub holds both and
    can read only the second.

    ``token_minter`` overrides how the two audience-bound ID tokens are obtained.
    Default is ADC (``_mint_id_token``), which is right when the hub calls this in
    a Cloud Run context that has a metadata server. An operator driving the
    rehearsal from a shell has no metadata server, so it passes a minter backed by
    its service-account key -- see ``make_operator_token_minter``.
    """
    return _post(
        pod_url,
        "/pod/migration/export",
        hushh_id,
        {
            "recipientPublicKey": recipient_public_key,
            "recipientKeyId": recipient_key_id,
        },
        timeout=_EXPORT_TIMEOUT_SECONDS,
        session=session,
        minter=token_minter,
    )


def import_into(
    *,
    pod_url: str,
    hushh_id: str,
    bundle: dict[str, Any],
    session: Any = None,
    token_minter: Any = None,
) -> dict[str, Any]:
    """Hand the DESTINATION pod the sealed bundle and let it rebuild its chain.

    A longer timeout than the export because the destination replays every
    record through the ordinary append path, one compare-and-swap at a time --
    which is the same slowness that makes the resulting head trustworthy.

    ``token_minter`` overrides the ID-token source exactly as ``export_from``.
    """
    return _post(
        pod_url,
        "/pod/migration/import",
        hushh_id,
        {"bundle": bundle},
        timeout=_IMPORT_TIMEOUT_SECONDS,
        session=session,
        minter=token_minter,
    )


def make_operator_token_minter(service_account_info: dict[str, Any]) -> Any:
    """A token minter backed by a service-account key, for driving from a shell.

    ADC's ``fetch_id_token`` needs a metadata server. An operator running the
    migration rehearsal has none, so it mints the two audience-bound ID tokens
    directly from its service-account key with ``IDTokenCredentials``, which is
    the same identity the hub would use -- so the pod's invoker binding and
    hub-caller allowlist see the caller they already expect, not a new one.

    Kept as a factory taking parsed key info (not an env read) so it is unit
    testable with fake info and so the operator harness owns where the key comes
    from (``load_operator_credentials`` decodes ``GCP_DEPLOY_SA_KEY_B64``).
    """
    from google.auth.transport.requests import Request  # noqa: PLC0415
    from google.oauth2 import service_account  # noqa: PLC0415

    def _mint(audience: str) -> Optional[str]:
        try:
            creds = service_account.IDTokenCredentials.from_service_account_info(
                service_account_info, target_audience=audience
            )
            creds.refresh(Request())
            return str(creds.token) if creds.token else None
        except Exception as exc:  # noqa: BLE001 - a mint failure is a refused call
            logger.info("pod_migration_transport.operator_token_failed %s", type(exc).__name__)
            return None

    return _mint
