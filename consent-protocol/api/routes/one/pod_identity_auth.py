"""Verify that a caller is a hussh pod -- the one place that check is written.

Extracted from ``agent_prompt.py`` when the heartbeat route became a second caller.
Duplicating it would have meant two copies of a security check that must agree
exactly; the second copy is where the ``email_verified`` clause, or the
allowed-service-account lookup, quietly goes missing.

What a verified pod identity proves, precisely
----------------------------------------------
The credential is a Google ID token minted from the instance metadata server,
audience-bound to this hub. Verifying it establishes that the caller holds the pod
runtime service account. It does NOT establish WHICH user's pod is calling: every
pod in the fleet runs as that same account, which is exactly what lets the account
hold no project roles at all. The pod therefore asserts its own ``HUSSH_ID`` in a
header, and that assertion is trustworthy only as far as the pod is.

That is the ``logical`` tier's stated trust level, and it is why acceptance is
gated OFF by default (``pod_hub_identity_auth_enabled``). Turned on where pods hold
real holdings, one compromised pod could speak for another user's HusshID.
Cryptographic per-pod identity is the attested ``dedicated`` tier (M5).
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from hushh_mcp.runtime_settings import (
    pod_hub_allowed_service_account,
    pod_hub_expected_audience,
    pod_hub_identity_auth_enabled,
)
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER

logger = logging.getLogger(__name__)


async def verify_pod_identity(request: Request, authorization: Optional[str]) -> Optional[str]:
    """The pod's asserted HusshID once its token verifies, else None.

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
        return asserted

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
