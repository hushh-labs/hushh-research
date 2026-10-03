"""The owner's "sync now" for their standby agent (docs/future/personal-agent/STANDBY-SYNC.md).

Hub-only and owner-scoped: the Firebase identity names the person, so a caller can
only ever bring their OWN standby level. The hub ferries ciphertext it cannot open;
the typed outcome is all this route returns. Same prefix as ``runtime.py``, kept in
its own module so that file does not grow.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter

router = APIRouter(prefix="/api/one/runtime", tags=["One runtime configuration"])


@router.post("/standby/sync")
@limiter.limit(RateLimits.CONSENT_REQUEST)
async def sync_standby_now(
    request: Request, firebase_uid: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    """Bring the caller's OWN standby agent level now; the typed outcome (STANDBY-SYNC.md)."""
    from hushh_mcp.services.pod_standby_sync import sync_standby_on_demand

    return (await sync_standby_on_demand(firebase_uid)).to_dict()


__all__ = ["router"]
