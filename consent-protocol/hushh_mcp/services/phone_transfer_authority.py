"""Phone possession, provider preflight and retired-authority boundaries."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from typing import Any

from fastapi import HTTPException
from google.auth.transport.requests import AuthorizedSession
from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services import account_firebase_mutations as mutations
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_phone_digest

logger = logging.getLogger(__name__)


class PhoneTransferInProgressError(RuntimeError):
    """Erasure cannot consume context owned by unsettled provider work."""


def assert_erasure_ready(conn: Any, user_id: str, table_exists: Any) -> None:
    """Caller holds exclusive lifecycle barriers, before any provider cleanup."""
    if (
        table_exists(conn, "account_phone_transfers")
        and conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM account_phone_transfers WHERE state='committed' AND (user_id=:owner OR previous_user_id=:owner OR proof_owner_id=:owner))"
            ),
            {"owner": user_id},
        ).scalar_one()
        is True
    ):
        raise PhoneTransferInProgressError("PHONE_TRANSFER_IN_PROGRESS")


def refuse(code: str, status: int = 409) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={
            "code": code,
            "message": {
                "PHONE_TRANSFER_CONFIRMATION_REQUIRED": "This number is linked to another account. Choose how to continue.",
                "PHONE_TRANSFER_STALE": "This transfer has changed. Request a fresh SMS code and try again.",
                "PHONE_TRANSFER_REAL_SMS_REQUIRED": "Use a real SMS verification code to transfer this number.",
                "PHONE_TRANSFER_PROVIDER_UNAVAILABLE": "Number transfer is temporarily unavailable. Check its progress before starting again.",
                "PHONE_TRANSFER_RECOVERY_REQUIRED": "Recover the previous account before changing its only sign-in method.",
            }.get(code, "Phone verification could not be completed. Please retry."),
        },
        headers={"Cache-Control": "private, no-store"},
    )


def proof_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def require_fresh_sms_claims(claims: dict[str, Any], phone: str) -> None:
    from api.utils.firebase_auth import carries_review_mint

    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", phone):
        raise refuse("PHONE_TRANSFER_REAL_SMS_REQUIRED", 403)
    if carries_review_mint(claims) or claims.get("trusted_device_id"):
        raise refuse("PHONE_TRANSFER_REAL_SMS_REQUIRED", 403)
    stamp = claims.get("auth_time")
    if (
        isinstance(stamp, bool)
        or not isinstance(stamp, (int, float))
        or not 0 <= time.time() - stamp <= 300
    ):
        raise refuse("PHONE_TRANSFER_STALE", 401)
    from hushh_mcp.services.phone_test_transport import _parse_phone_test_numbers

    configured = set().union(
        *(
            _parse_phone_test_numbers(os.getenv(key, ""))
            for key in (
                "HUSHH_UAT_PHONE_TEST_NUMBERS",
                "UAT_PHONE_TEST_NUMBERS",
                "HUSHH_PROD_PHONE_TEST_NUMBERS",
            )
        )
    )
    if phone in configured or os.getenv("FIREBASE_AUTH_EMULATOR_HOST"):
        raise refuse("PHONE_TRANSFER_REAL_SMS_REQUIRED", 403)


def check_provider(app: Any, phone: str, proof_uid: str) -> bool:
    """Check mutation authority and provider test configuration before any move."""
    from firebase_admin import auth

    from api.utils.firebase_admin import assert_firebase_identity_mutation_allowed

    try:
        assert_firebase_identity_mutation_allowed(app)
        uid = proof_uid
        user = auth.get_user(uid, app=app)
        if getattr(user, "phone_number", None) != phone:
            raise refuse("PHONE_TRANSFER_STALE")
        independent_signin = mutations.has_independent_signin(user)
        if not independent_signin:
            from hushh_mcp.services.account_deletion_lifecycle_service import (
                AccountDeletionLifecycleService,
            )

            with get_db_connection() as conn:
                # The provider identity and application owner differ after re-enrollment.
                from hushh_mcp.services.account_deletion_lifecycle_service import (
                    account_deletion_user_hash,
                )

                owner = (
                    conn.execute(
                        text(
                            "SELECT owner_id FROM account_generations WHERE identity_hash=:identity ORDER BY generation DESC LIMIT 1"
                        ),
                        {"identity": account_deletion_user_hash(uid)},
                    ).scalar_one_or_none()
                    or uid
                )
                if AccountDeletionLifecycleService._has_guarded_account_state_in_transaction(
                    conn, user_id=owner
                ):
                    raise refuse("PHONE_TRANSFER_RECOVERY_REQUIRED", 403)
        # Firebase fictional-number tokens are signed like ordinary phone tokens.
        # Inspect the provider configuration as well as the application's fixture list.
        with AuthorizedSession(app.credential.get_credential(), max_refresh_attempts=0) as session:
            session.trust_env = False
            response = session.get(
                f"https://identitytoolkit.googleapis.com/admin/v2/projects/{app.project_id}/config",
                timeout=4,
                allow_redirects=False,
                stream=True,
            )
            try:
                if response.status_code != 200:
                    raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
                import json

                body = bytearray()
                for chunk in response.iter_content(chunk_size=4096):
                    body.extend(chunk)
                    if len(body) > 262144:
                        raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503)
                config = json.loads(body)
                tests = ((config.get("signIn") or {}).get("phoneNumber") or {}).get(
                    "testPhoneNumbers"
                ) or {}
                if phone in tests:
                    raise refuse("PHONE_TRANSFER_REAL_SMS_REQUIRED", 403)
            finally:
                response.close()
        return independent_signin
    except HTTPException:
        raise
    except Exception:
        logger.warning("phone.transfer.provider_preflight_unavailable")
        raise refuse("PHONE_TRANSFER_PROVIDER_UNAVAILABLE", 503) from None


def assert_phone_admission(owner_id: str, claims: Any, *, get_db_connection: Any) -> None:
    if (claims.get("firebase") or {}).get("sign_in_provider") != "phone":
        return
    with get_db_connection() as conn:
        # Older installations have no transfers. Once installed, availability
        # failure must never restore a retired phone session through a cache.
        installed = conn.execute(
            text("SELECT to_regclass('public.account_phone_auth_fences') IS NOT NULL")
        ).scalar_one()
        if installed is not True:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
                    "message": "Sign in with your Google or Apple account.",
                },
                headers={"Cache-Control": "private, no-store"},
            )
        from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

        fenced = conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM account_phone_auth_fences WHERE identity_hash=:identity AND phone_digest=:phone)"
            ),
            {
                "identity": account_deletion_user_hash(
                    str(claims.get("uid") or claims.get("sub") or "")
                ),
                "phone": account_deletion_phone_digest(str(claims.get("phone_number") or "")),
            },
        ).scalar_one()
        if fenced is True:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "AUTH_PHONE_ACCESS_REVOKED",
                    "message": "Sign in with your Google or Apple account.",
                },
                headers={"Cache-Control": "private, no-store"},
            )

    # A phone proof is never a primary application identity: even before a
    # transfer, it must not read a previous owner's profile or enroll a device.
    raise HTTPException(
        status_code=403,
        detail={
            "code": "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
            "message": "Sign in with your Google or Apple account.",
        },
        headers={"Cache-Control": "private, no-store"},
    )
