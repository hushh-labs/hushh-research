"""Request-memory phone proofs for a separately authenticated owner's device action."""

import hashlib
import math
import time
from typing import Any

from starlette.concurrency import run_in_threadpool

from hushh_mcp.services.phone_recovery_state import refuse
from hushh_mcp.services.phone_test_transport import (
    _configured_phone_test_numbers,
    _create_uat_phone_test_verification_id,
    _phone_test_enabled,
    validate_phone_test_confirmation,
)


def fixture_challenge(phone: str) -> str | None:
    if _phone_test_enabled() and phone in _configured_phone_test_numbers():
        return _create_uat_phone_test_verification_id(phone)
    return None


async def verify(
    user_id: str,
    operation: str,
    phone: str,
    created_at: float,
    *,
    phone_id_token: str | None,
    test_code: str | None,
) -> str:
    if bool(phone_id_token) == bool(test_code):
        raise refuse("DEVICE_ACTION_PROOF_REQUIRED", 403)
    if test_code:
        challenge = fixture_challenge(phone)
        if not challenge:
            raise refuse("DEVICE_ACTION_REAL_SMS_REQUIRED", 403)
        validate_phone_test_confirmation(user_id, phone, challenge, test_code)
        # Fixture proof is deliberately scoped to this authenticated owner's
        # operation, never promoted to a Firebase JWT or account authority.
        event = f"device-fixture:{user_id}:{operation}"
    else:
        event = await _signed_event(phone_id_token or "", phone, created_at)
    return hashlib.sha256(event.encode()).hexdigest()


async def _signed_event(token: str, phone: str, created_at: float) -> str:
    from api.utils.firebase_admin import get_firebase_auth_app
    from api.utils.firebase_auth import refuse_foreign_review_mint
    from api.utils.phone_claim_proof import verify_phone_claim_id_token
    from hushh_mcp.services.phone_transfer_authority import assert_real_sms_provider

    metadata: dict[str, Any] = {}
    actual, uid = await verify_phone_claim_id_token(
        token,
        app_factory=get_firebase_auth_app,
        run_in_threadpool=run_in_threadpool,
        refuse_foreign_review_mint=refuse_foreign_review_mint,
        transfer=True,
        proof_metadata=metadata,
    )
    # Firebase auth_time is an integer second. A refreshed JWT retains the same
    # event, and the UNIQUE SQL digest consumes that event across device actions.
    if actual != phone or not uid or metadata["valid_until"] - 300 < math.ceil(created_at):
        raise refuse("DEVICE_ACTION_FRESH_SMS_REQUIRED", 403)
    await run_in_threadpool(assert_real_sms_provider, get_firebase_auth_app(), phone)
    if metadata["valid_until"] <= time.time():
        raise refuse("DEVICE_ACTION_FRESH_SMS_REQUIRED", 403)
    return metadata["event"]
