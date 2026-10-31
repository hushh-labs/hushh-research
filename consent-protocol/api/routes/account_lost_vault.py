"""Deletion-only wire models and read-only phone comparison.

The existing account route remains the binding and erasure authority. A match
issues no credential and final deletion must independently reread the binding.
"""

import hmac
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services.account_deletion_inventory_review import review_lost_vault_deletion
from hushh_mcp.services.user_identifier_service import normalize_phone_identifier

logger = logging.getLogger(__name__)
router = APIRouter()


class LostVaultDeleteProofRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: Literal["phone", "provider"]
    phone_id_token: str | None = Field(default=None, min_length=1, max_length=20_000)
    continuation_id: UUID | None = None


class LostVaultDeleteRequest(LostVaultDeleteProofRequest):
    reviewed_inventory_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    accept_local_erasure: StrictBool = False


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


async def _verify_lost_vault_deletion_proofs(
    payload: LostVaultDeleteProofRequest, authorization: str | None, firebase_uid: str
) -> None:
    """Apply the same provider and linked-phone proof to review and deletion."""
    from api.routes import account

    claims = await run_in_threadpool(account._recent_federated_claims, authorization, firebase_uid)
    phone, providers = await account._lost_vault_deletion_options(firebase_uid)
    provider = str((claims.get("firebase") or {}).get("sign_in_provider") or "")
    if provider not in providers:
        raise HTTPException(status_code=401, detail={"code": "ACCOUNT_DELETE_REAUTH_REQUIRED"})
    if phone:
        if payload.method != "phone" or not payload.phone_id_token:
            raise HTTPException(
                status_code=403, detail={"code": "ACCOUNT_DELETE_PHONE_PROOF_REQUIRED"}
            )
        await account._verify_lost_vault_phone_proof(payload.phone_id_token, phone)
    elif payload.method != "provider" or payload.phone_id_token:
        raise HTTPException(status_code=403, detail={"code": "ACCOUNT_DELETE_METHOD_UNAVAILABLE"})
    if payload.continuation_id:
        from hushh_mcp.services.phone_recovery_continuation import require_ready

        await require_ready(firebase_uid, str(payload.continuation_id), action="delete")


@router.post("/delete-lost-vault/review")
async def review_lost_vault_account_deletion(
    payload: LostVaultDeleteProofRequest,
    response: Response,
    authorization: str | None = Header(None),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
):
    """Review only safe inventory metadata before the final confirmation."""
    response.headers["Cache-Control"] = "private, no-store"
    await _verify_lost_vault_deletion_proofs(payload, authorization, firebase_uid)
    try:
        return await review_lost_vault_deletion(firebase_uid)
    except Exception:
        logger.exception("account.delete_review_unavailable user=%s", firebase_uid)
        raise HTTPException(
            status_code=503,
            detail={"code": "ACCOUNT_DELETE_REVIEW_UNAVAILABLE"},
            headers={"Cache-Control": "private, no-store"},
        ) from None


@router.post("/delete-lost-vault")
async def delete_lost_vault_account(
    payload: LostVaultDeleteRequest,
    authorization: str | None = Header(None),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
):
    """Erase the entire account after fresh identity proof without unlocking the vault."""
    await _verify_lost_vault_deletion_proofs(payload, authorization, firebase_uid)
    if payload.accept_local_erasure and payload.reviewed_inventory_sha256 is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "ACCOUNT_DELETE_CLEANUP_REVIEW_REQUIRED"},
        )
    from api.routes import account

    return await account._perform_account_deletion(
        firebase_uid,
        target="both",
        reviewed_inventory_sha256=payload.reviewed_inventory_sha256,
        accept_local_erasure=payload.accept_local_erasure,
    )
