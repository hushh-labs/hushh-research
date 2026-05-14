"""
Mobile-to-protocol consent state synchronisation endpoint.

Cross-Platform Sync Engine by Abdul Gaffar — Beast Mode initiative.

POST /sync/consent-state

Accepts a batch of consent state updates from an authenticated mobile
device, resolves conflicts with Last-Writer-Wins, and applies approved
updates to the database.

Authentication layers
---------------------
1. Firebase bearer token   — verifies the user's identity (existing infra)
2. X-Pairing-Token header  — verifies the request originates from a
                             device that was explicitly paired by that user

Both layers must be satisfied; a missing or invalid pairing token returns
401 even if the Firebase token is valid.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status

from api.middleware import require_firebase_auth
from utils.sync_engine import (
    ConsentSyncRequest,
    ConsentSyncResponse,
    ConsentSyncUpdate,
    PairingTokenError,
    PairingTokenManager,
    sync_processor,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["Mobile Sync"])

_LABEL = "Cross-Platform Sync Engine by Abdul Gaffar"

# ---------------------------------------------------------------------------
# Pairing token manager (uses server signing key)
# ---------------------------------------------------------------------------

_signing_key_raw = os.getenv("APP_SIGNING_KEY", "")
_PAIRING_MANAGER = PairingTokenManager(
    signing_key=_signing_key_raw.encode() if _signing_key_raw else b"dev-only-key",
    max_age_seconds=int(os.getenv("PAIRING_TOKEN_MAX_AGE_SECONDS", "86400")),
)


# ---------------------------------------------------------------------------
# Stub DB helpers — replace with real ConsentDBService calls in production
# ---------------------------------------------------------------------------


async def _fetch_server_state_stub(consent_id: str) -> Optional[int]:
    """
    Stub: returns None (no server record) for all consent IDs.

    Replace with a real DB query in production::

        return await db.get_consent_updated_at(consent_id)
    """
    return None


async def _apply_update_stub(update: ConsentSyncUpdate) -> None:
    """
    Stub: logs the update without writing to the DB.

    Replace with real DB writes in production::

        await db.upsert_consent_state(update.consent_id, update.action, update.updated_at)
    """
    logger.info(
        "[%s] (stub) would apply consent_id=%s action=%s brand_id=%s",
        _LABEL,
        update.consent_id,
        update.action.value,
        update.brand_id,
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post(
    "/consent-state",
    response_model=None,
    summary="Push a batch of consent state updates from a mobile device",
)
async def sync_consent_state(
    body: ConsentSyncRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    x_pairing_token: str = Header(
        ...,
        alias="X-Pairing-Token",
        description="Device pairing token issued after Firebase sign-in",
    ),
) -> dict:
    """
    Accept a batch of consent state changes from a paired mobile device.

    **Authentication:** Firebase bearer token + X-Pairing-Token header.

    **Conflict resolution:** Last-Writer-Wins on ``updated_at`` (ms).
    Server state wins on ties — conservative policy that prevents stale
    mobile state from overwriting a more recent server-side revocation.

    Signed: Cross-Platform Sync Engine by Abdul Gaffar
    """
    # Layer 2 auth: validate pairing token against the Firebase-verified UID
    try:
        _PAIRING_MANAGER.validate_token(
            x_pairing_token,
            expected_uid=firebase_uid,
            expected_device_id=body.device_id,
        )
    except PairingTokenError as exc:
        logger.warning("[%s] pairing token invalid uid=%s: %s", _LABEL, firebase_uid, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired pairing token: {exc}",
        ) from exc

    response: ConsentSyncResponse = await sync_processor.process_batch(
        updates=body.updates,
        fetch_server_state=_fetch_server_state_stub,
        apply_update=_apply_update_stub,
    )

    return {
        "sync_id": response.sync_id,
        "processed": response.processed,
        "applied": response.applied,
        "skipped": response.skipped,
        "engine": response.engine,
        "results": [
            {
                "consent_id": r.consent_id,
                "brand_id": r.brand_id,
                "action": r.action.value,
                "applied": r.applied,
                "reason": r.reason,
            }
            for r in response.results
        ],
    }
