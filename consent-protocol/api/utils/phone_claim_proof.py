"""Signed phone proof decoding, with caller-supplied Firebase and execution ports."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)


async def _decode(normalized_token: str, app_factory, run_in_threadpool):
    try:
        from firebase_admin import auth as firebase_auth

        firebase_app = app_factory()
        decoded = await run_in_threadpool(
            lambda: firebase_auth.verify_id_token(
                normalized_token,
                app=firebase_app,
                check_revoked=True,
            )
        )
    except (asyncio.TimeoutError, ConnectionError) as exc:
        logger.warning("phone.transfer.proof_provider_unavailable")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PHONE_PROOF_SERVICE_UNAVAILABLE",
                "message": "Phone verification is temporarily unavailable. Please retry.",
            },
        ) from exc
    except Exception as exc:
        from firebase_admin import exceptions as firebase_errors
        from requests.exceptions import RequestException

        if isinstance(
            exc,
            (
                firebase_auth.CertificateFetchError,
                firebase_errors.UnavailableError,
                firebase_errors.InternalError,
                firebase_errors.DeadlineExceededError,
                RequestException,
            ),
        ):
            logger.warning("phone.transfer.proof_provider_unavailable")
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "PHONE_PROOF_SERVICE_UNAVAILABLE",
                    "message": "Phone verification is temporarily unavailable. Please retry.",
                },
            ) from exc
        logger.info("Phone claim token verification failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_PHONE_ID_TOKEN",
                "message": "The phone verification token is invalid or expired.",
            },
        ) from exc
    return decoded


async def verify_phone_claim_id_token(
    raw_token: str,
    *,
    app_factory,
    run_in_threadpool,
    refuse_foreign_review_mint,
    transfer: bool = False,
    proof_metadata: dict | None = None,
) -> tuple[str, str | None]:
    normalized_token = str(raw_token or "").strip()
    if not normalized_token:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_REQUIRED",
                "message": "A phone verification token is required.",
            },
        )

    decoded = await _decode(normalized_token, app_factory, run_in_threadpool)

    claims: dict[str, Any] = dict(decoded or {})
    if refuse_foreign_review_mint(claims):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_PHONE_ID_TOKEN",
                "message": "The phone verification token is invalid or expired.",
            },
        )
    firebase_claims = claims.get("firebase")
    sign_in_provider = (
        str(firebase_claims.get("sign_in_provider") or "").strip()
        if isinstance(firebase_claims, dict)
        else ""
    )
    if sign_in_provider != "phone":
        raise HTTPException(
            status_code=401,
            detail={
                "code": "PHONE_ID_TOKEN_PROVIDER_MISMATCH",
                "message": "The phone verification token must come from Firebase phone auth.",
            },
        )

    phone_number = str(claims.get("phone_number") or "").strip()
    if not phone_number:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER",
                "message": "The phone verification token does not contain a phone number.",
            },
        )

    phone_session_uid = str(claims.get("uid") or claims.get("sub") or "").strip() or None
    if transfer:
        from hushh_mcp.services.phone_transfer_service import require_fresh_sms_claims

        require_fresh_sms_claims(claims, phone_number)
        if proof_metadata is not None:
            # Authentication-event identity survives token refresh; a rotated JWT
            # must not turn one SMS proof into a second transferable claim.
            proof_metadata["event"] = f"{phone_session_uid}:{phone_number}:{claims['auth_time']}"
            proof_metadata["valid_until"] = claims["auth_time"] + 300
    return phone_number, phone_session_uid
