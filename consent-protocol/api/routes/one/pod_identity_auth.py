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

        claims = await run_in_threadpool(
            google_id_token.verify_oauth2_token, token, google_requests.Request()
        )
    except Exception as exc:  # noqa: BLE001 - an unverifiable token is simply not a pod
        logger.info("pod_hub_auth.verify_failed %s", type(exc).__name__)
        return None

    if str(claims.get("email") or "") != allowed or not claims.get("email_verified"):
        logger.warning("pod_hub_auth.rejected_identity email_matches=false")
        return None
    logger.info("pod_hub_auth.accepted asserted_agent_id=%s", asserted)
    return asserted
