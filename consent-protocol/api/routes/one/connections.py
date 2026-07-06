"""Trusted Connections routes.

Seed endpoint only, for now. Writes to the generalized trusted_connections graph
via TrustedConnectionsService. Mirrors the SOS seed topology (new user -> seed
set) but is a SEPARATE call — the SOS /api/one/location/seed-trusted path and
one_location_network_connections are untouched.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from api.middleware import require_vault_owner_token
from hushh_mcp.services.trusted_connections_service import (
    TrustedConnectionsError,
    TrustedConnectionsService,
)

router = APIRouter(prefix="/api/one", tags=["One Trusted Connections"])


def _service() -> TrustedConnectionsService:
    return TrustedConnectionsService()


def _user_id(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _seed_dev_user_ids() -> list[str]:
    """Configured accounts to seed into the trusted graph (reuses SOS list)."""
    raw = str(os.getenv("SOS_SEED_DEV_USER_IDS", "") or "")
    return [item.strip() for item in raw.split(",") if item.strip()]


@router.post("/connections/seed-trusted")
async def seed_trusted_connections(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Seed the current user's trusted graph with configured accounts.

    Idempotent; gated server-side on the user having zero active trusted edges.
    """
    try:
        return {"result": _service().seed_new_user(_user_id(token_data), _seed_dev_user_ids())}
    except TrustedConnectionsError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "TRUSTED_SEED_FAILED", "message": "Seed failed."},
        ) from exc
