"""Execute one reviewed Drive write (share or trash) after the owner confirms it in Chat."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from api.middleware import require_vault_owner_token, verify_user_id_match
from hushh_mcp.one_adk.drive_write_tools import execute_reviewed_drive_action
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_write_adapter import DriveWriteError

router = APIRouter(prefix="/api/one/drive", tags=["One Drive"])


class DriveReviewedAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=256)
    directive_id: str = Field(pattern=r"^dir_[0-9a-f]{32}$")
    action: Literal["share", "trash"]
    arguments: dict[str, Any]
    confirmed: StrictBool


@router.post("/reviewed-actions/execute")
async def execute_reviewed_action(
    body: DriveReviewedAction, token: dict = Depends(require_vault_owner_token)
):
    verify_user_id_match(token["user_id"], body.user_id)
    if body.confirmed is not True:
        raise HTTPException(status_code=400, detail="Confirm the exact change before continuing.")
    try:
        return await execute_reviewed_drive_action(
            owner_id=token["user_id"],
            conversation_id=body.conversation_id,
            directive_id=body.directive_id,
            action=body.action,
            arguments=body.arguments,
        )
    except ActionDirectiveAuthorityError:
        raise HTTPException(
            status_code=409, detail="This review changed or expired. Ask One to prepare it again."
        ) from None
    except DriveWriteError as error:
        if error.outcome_unknown:
            raise HTTPException(
                status_code=502,
                detail="Drive did not confirm the change. Check Drive before trying again.",
            ) from None
        if str(error) == "invalid_argument":
            raise HTTPException(status_code=422, detail="This change is invalid.") from None
        raise HTTPException(
            status_code=409, detail="Drive refused this change or the file is unavailable."
        ) from None
    except DriveOAuthError as error:
        raise HTTPException(
            status_code=401 if error.status_code in {401, 409} else 403,
            detail="Reconnect Google Drive, then ask One again.",
        ) from None
    except Exception:
        raise HTTPException(
            status_code=503, detail="Drive is unavailable. No automatic retry was made."
        ) from None
