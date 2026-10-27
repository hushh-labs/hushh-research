"""Non-authorizing recovery navigation and confirmed own-device action routes."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services import device_action_service, phone_recovery_continuation
from hushh_mcp.services.phone_recovery_state import refuse


class RecoveryRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            try:
                return await original(request)
            except RequestValidationError:
                # Default validation details can reflect complete OTP/JWT inputs.
                return JSONResponse(
                    status_code=422,
                    content={"detail": {"code": "PHONE_RECOVERY_INVALID_REQUEST"}},
                    headers={"Cache-Control": "private, no-store"},
                )

        return handler


router = APIRouter(route_class=RecoveryRoute)


class RecoveryContinuationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["recover", "delete", "revoke"]
    phone_number: str = Field(min_length=8, max_length=32)


class DeviceActionPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    continuation_id: UUID | None = None


class DeviceActionConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    confirmed: Literal[True]
    phone_id_token: str | None = Field(default=None, min_length=1, max_length=20_000)
    test_code: str | None = Field(default=None, min_length=1, max_length=16)

    @field_validator("confirmed", mode="before")
    @classmethod
    def literal_confirmation(cls, value):
        if value is not True:
            raise ValueError("explicit confirmation is required")
        return value

    @model_validator(mode="after")
    def exactly_one_phone_proof(self):
        if bool(self.phone_id_token) == bool(self.test_code):
            raise ValueError("exactly one phone proof is required")
        return self


async def require_recovery_signin(authorization: str | None, owner: str) -> None:
    from api.routes import account

    claims = await run_in_threadpool(
        account._recent_federated_claims, authorization, owner, require_recent=False
    )
    if account.carries_review_mint(claims) or claims.get("trusted_device_id"):
        raise refuse("PHONE_RECOVERY_INDEPENDENT_SIGN_IN_REQUIRED", 403)


async def recovery_owner(
    response: Response,
    authorization: str | None = Header(None),
    owner: str = Depends(require_firebase_auth_read_only),
) -> str:
    response.headers["Cache-Control"] = "private, no-store"
    await require_recovery_signin(authorization, owner)
    return owner


@router.post("/phone/recovery/continuations")
async def create_continuation(
    payload: RecoveryContinuationRequest, owner: str = Depends(recovery_owner)
):
    return await phone_recovery_continuation.create(owner, payload.action, payload.phone_number)


@router.get("/phone/recovery/continuations/{continuation_id}")
async def read_continuation(continuation_id: UUID, owner: str = Depends(recovery_owner)):
    return await phone_recovery_continuation.read(owner, str(continuation_id))


@router.post("/trusted-devices/{device_id}/revoke/prepare")
async def prepare_device_action(
    device_id: str,
    payload: DeviceActionPrepareRequest,
    owner: str = Depends(recovery_owner),
):
    return await device_action_service.prepare(
        owner, device_id, str(payload.continuation_id) if payload.continuation_id else None
    )


@router.post("/trusted-devices/{device_id}/revoke/confirm")
async def confirm_device_action(
    device_id: str,
    payload: DeviceActionConfirmRequest,
    owner: str = Depends(recovery_owner),
):
    from api.routes import account

    return await device_action_service.confirm(
        owner,
        device_id,
        str(payload.operation_id),
        phone_id_token=payload.phone_id_token,
        test_code=payload.test_code,
        revoke=account._revoke_trusted_device,
    )


@router.get("/trusted-devices/revocations/{operation_id}")
async def read_device_action(operation_id: UUID, owner: str = Depends(recovery_owner)):
    from api.routes import account

    return await device_action_service.status(
        owner, str(operation_id), reconcile=account._settle_trusted_device_revocation
    )


@router.post("/trusted-devices/revocations/{operation_id}/cancel")
async def cancel_device_action(operation_id: UUID, owner: str = Depends(recovery_owner)):
    return await device_action_service.cancel(owner, str(operation_id))
