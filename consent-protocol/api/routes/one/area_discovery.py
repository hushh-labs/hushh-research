"""Owner opt-in and bounded postal-area discovery; no GPS or private PKM fields."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services import area_discovery as service
from hushh_mcp.services.area_discovery_policy import MAX_PAGES, AreaDiscoveryError

router = APIRouter(prefix="/api/one/area-discovery", tags=["Area discovery"])
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class AreaPreference(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    postalCode: str | None = Field(default=None, max_length=5)
    expectedRevision: int = Field(ge=0, le=9_007_199_254_740_991)
    consentVersion: str = Field(max_length=80)
    adultConfirmed: bool = False


async def _respond(work):
    try:
        result = await asyncio.wait_for(work, timeout=25)
    except AreaDiscoveryError as exc:
        raise HTTPException(
            exc.status_code, {"code": exc.code, "message": str(exc)}, headers=NO_STORE
        ) from None
    except Exception:
        # Do not log ZIP codes, identities, requests, tokens or SQL values.
        raise HTTPException(
            503,
            {
                "code": "AREA_UNAVAILABLE",
                "message": "Area discovery is temporarily unavailable. Refresh before retrying.",
            },
            headers=NO_STORE,
        ) from None
    return JSONResponse(result, headers=NO_STORE)


@router.get("/me")
async def read_preference(uid: str = Depends(require_firebase_auth_read_only)):
    return await _respond(service.preference(uid))


@router.put("/me")
async def save_preference(
    body: AreaPreference, uid: str = Depends(require_firebase_auth_read_only)
):
    return await _respond(
        service.choose_preference(
            uid,
            enabled=body.enabled,
            postal_code=body.postalCode,
            expected_revision=body.expectedRevision,
            consent_version=body.consentVersion,
            adult_confirmed=body.adultConfirmed,
        )
    )


class AreaSearch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    postalCode: str = Field(pattern=r"^[0-9]{5}$")
    page: int = Field(default=1, ge=1, le=MAX_PAGES)


@router.post("/search")
async def search_area(body: AreaSearch, uid: str = Depends(require_firebase_auth_read_only)):
    return await _respond(service.search(uid, postal_code=body.postalCode, page=body.page))
