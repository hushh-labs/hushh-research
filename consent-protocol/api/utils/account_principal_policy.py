"""Application-owner lifecycle and phone admission policy."""

from typing import Any, Mapping

from fastapi import HTTPException


def require_independent_phone_signin(claims: Mapping[str, Any], *, required: bool) -> None:
    if required and (claims.get("firebase") or {}).get("sign_in_provider") == "phone":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
                "message": "Sign in with your Google or Apple account to open your vault.",
            },
        )


def admit_phone_principal(owner_id: str, claims: Mapping[str, Any]) -> None:
    try:
        from hushh_mcp.services.phone_transfer_service import assert_phone_admission

        assert_phone_admission(owner_id, claims)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={"code": "AUTH_SESSION_STATUS_UNAVAILABLE"},
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None


def assert_account_not_deleted(uid: str, *, logger) -> None:
    """Fail closed before any authenticated handler can bootstrap user state."""
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionInProgressError,
        AccountDeletionLifecycleService,
    )

    try:
        deleted = AccountDeletionLifecycleService.is_tombstoned(uid)
    except AccountDeletionInProgressError:
        raise HTTPException(
            status_code=423,
            detail={
                "code": "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
                "message": "Account deletion is in progress.",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "2"},
        ) from None
    except Exception as exc:
        logger.error(
            "firebase.account_deletion_status_unavailable error=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "AUTH_SESSION_STATUS_UNAVAILABLE",
                "message": "Authentication status is temporarily unavailable",
            },
            headers={"Cache-Control": "private, no-store", "Retry-After": "3"},
        ) from None
    if deleted:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "AUTH_ACCOUNT_NOT_FOUND",
                "account_lifecycle": "deleted",
                "message": "Account information has been deleted",
            },
            headers={"Cache-Control": "private, no-store"},
        )
