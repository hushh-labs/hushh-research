"""Safe deletion failure responses; never reflects service error payloads."""

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from hushh_mcp.services.account_service import (
    ACCOUNT_DELETION_FAILED_CODE,
    ACCOUNT_DELETION_PAUSED_CODE,
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
    PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
)


def failure_response(user_id, result, *, logger, cleanup_provider_detail, files_pending):
    if not result["success"]:
        if result.get(
            "error_code"
        ) == "PHONE_TRANSFER_IN_PROGRESS" or "PHONE_TRANSFER_IN_PROGRESS" in str(
            result.get("error", "")
        ):
            return JSONResponse(
                status_code=409,
                content={
                    "code": ACCOUNT_DELETION_FAILED_CODE,
                    "detail": "Phone transfer is still in progress. Check its progress, then retry account deletion.",
                },
                headers={"Cache-Control": "private, no-store"},
            )
        if result.get("error_code") == PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                    "message": PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
                    **cleanup_provider_detail(result.get("cleanup_provider")),
                },
            )
        if result.get("error_code") == ACCOUNT_DELETION_PAUSED_CODE:
            # A deploy's release fence refused the erasure; it rolled back and
            # will succeed once the release ends.
            logger.warning("account.delete_paused user=%s reason=release_fence", user_id)
            return JSONResponse(
                status_code=503,
                content={"detail": "Account deletion paused", "code": ACCOUNT_DELETION_PAUSED_CODE},
            )
        pending_files = files_pending(result.get("error_code"))
        if pending_files is not None:
            # Preserve the exact safe refusal. Unverified uploads require
            # reconciliation; only a settled bounded batch invites continuation.
            return pending_files
        # SECURITY: do not reflect the internal error string in the HTTP response.
        # The service-layer error may include persona names, DB state, or persona IDs.
        logger.error("account.delete_failed user=%s error=%s", user_id, result.get("error"))
        # The erasure transaction raised and was rolled back, so the account is
        # normally still intact. The machine code lets clients keep the session
        # after confirming that through the tombstone-aware status route,
        # instead of treating a definite failure like a lost response.
        return JSONResponse(
            status_code=500,
            content={"detail": "Account deletion failed", "code": ACCOUNT_DELETION_FAILED_CODE},
        )
