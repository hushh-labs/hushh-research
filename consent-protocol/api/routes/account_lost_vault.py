"""Deletion-only wire models and read-only phone comparison.

The existing account route remains the binding and erasure authority. A match
issues no credential and final deletion must independently reread the binding.
"""

import hmac
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services.user_identifier_service import normalize_phone_identifier

router = APIRouter()


class LostVaultDeleteRequest(BaseModel):
    method: Literal["phone", "provider"]
    phone_id_token: str | None = Field(default=None, min_length=1, max_length=20_000)


class LostVaultDeletePhoneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phone_number: str = Field(min_length=1, max_length=64)


@router.post("/delete-lost-vault/phone")
async def validate_lost_vault_deletion_phone(
    payload: LostVaultDeletePhoneRequest,
    response: Response,
    authorization: str | None = Header(None),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
):
    """Compare an entered number with this owner's binding; issue no authority."""
    response.headers["Cache-Control"] = "private, no-store"
    # The existing account module owns both the binding resolver and final erasure.
    from api.routes import account

    try:
        claims = await run_in_threadpool(
            account._recent_federated_claims, authorization, firebase_uid
        )
        phone, providers = await account._lost_vault_deletion_options(firebase_uid)
        provider = str((claims.get("firebase") or {}).get("sign_in_provider") or "")
        if provider not in providers:
            raise HTTPException(status_code=401, detail={"code": "ACCOUNT_DELETE_REAUTH_REQUIRED"})
        if not phone:
            raise HTTPException(
                status_code=409, detail={"code": "ACCOUNT_DELETE_METHOD_UNAVAILABLE"}
            )
        candidate = payload.phone_number.strip()
        normalized = normalize_phone_identifier(candidate) if candidate.startswith("+") else None
        if normalized is None:
            raise HTTPException(status_code=422, detail={"code": "ACCOUNT_DELETE_PHONE_INVALID"})
        if not hmac.compare_digest(normalized, phone):
            raise HTTPException(status_code=403, detail={"code": "ACCOUNT_DELETE_PHONE_MISMATCH"})
        return {"valid": True}
    except HTTPException as exc:
        exc.headers = {**(exc.headers or {}), "Cache-Control": "private, no-store"}
        raise
