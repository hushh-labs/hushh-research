"""Phone-proven deletion of the account holding a verified number."""

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from api.routes.account_phone_recovery import (
    DeviceActionConfirmRequest,
    RecoveryRoute,
    recovery_owner,
)
from hushh_mcp.services import phone_linked_deletion

# RecoveryRoute keeps OTP and JWT inputs out of validation error bodies.
router = APIRouter(prefix="/api/account", tags=["Account"], route_class=RecoveryRoute)


class LinkedDeletionPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phone_number: str = Field(min_length=8, max_length=32)


class LinkedDeletionConfirmRequest(DeviceActionConfirmRequest):
    phone_number: str = Field(min_length=8, max_length=32)


async def _delete_holder(owner: str, admission_check):
    from hushh_mcp.services.account_service import AccountService

    # The existing full-account erasure; this route already checked authority.
    return await AccountService().delete_account(
        owner, target="both", admission_check=admission_check
    )


@router.post("/phone/linked-account/deletions")
async def prepare_linked_deletion(
    payload: LinkedDeletionPrepareRequest, owner: str = Depends(recovery_owner)
):
    return await phone_linked_deletion.prepare(owner, payload.phone_number)


@router.post("/phone/linked-account/deletions/confirm")
async def confirm_linked_deletion(
    payload: LinkedDeletionConfirmRequest, owner: str = Depends(recovery_owner)
):
    return await phone_linked_deletion.confirm(
        owner,
        str(payload.operation_id),
        payload.phone_number,
        phone_id_token=payload.phone_id_token,
        test_code=payload.test_code,
        delete=_delete_holder,
    )


@router.get("/phone/linked-account/deletions/{operation_id}")
async def read_linked_deletion(operation_id: UUID, owner: str = Depends(recovery_owner)):
    return await phone_linked_deletion.status(owner, str(operation_id))


@router.post("/phone/linked-account/deletions/{operation_id}/cancel")
async def cancel_linked_deletion(operation_id: UUID, owner: str = Depends(recovery_owner)):
    return await phone_linked_deletion.cancel(owner, str(operation_id))
