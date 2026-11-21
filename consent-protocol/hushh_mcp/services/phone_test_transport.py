"""Environment-gated recorded phone transport; existing UAT/prod contracts retained."""

import hashlib
import hmac
import os
import re
import secrets

from fastapi import HTTPException

from hushh_mcp.services.dev_reviewer_phone_transport import (
    configured_dev_reviewer_phone_transport,
)

SYNTHETIC_PHONE_PATTERN = re.compile(r"^\+1[2-9]\d{2}55501\d{2}$")
_SIMULATION_PHONE_PREFIX = "+120255501"


def _clean_env(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _runtime_environment() -> str:
    return (_clean_env("ENVIRONMENT") or _clean_env("HUSHH_DEPLOY_ENV")).lower()


def _is_truthy_env(name: str) -> bool:
    return _clean_env(name).lower() in {"1", "true", "yes", "on", "enabled"}


def _is_uat_environment() -> bool:
    return _runtime_environment() == "uat"


def _is_dev_environment() -> bool:
    return _runtime_environment() == "dev" or _clean_env("HUSHH_DEPLOY_ENV").lower() == "dev"


def _normalize_phone_number(raw_phone: str) -> str:
    cleaned = re.sub(r"[^\d+]", "", str(raw_phone or "").strip())
    if cleaned.startswith("00"):
        cleaned = f"+{cleaned[2:]}"
    if cleaned and not cleaned.startswith("+"):
        cleaned = f"+{cleaned}"
    if cleaned.count("+") > 1 or ("+" in cleaned[1:]):
        return ""
    return cleaned


def _parse_phone_test_numbers(raw: str) -> set[str]:
    """Parse a comma/semicolon/newline-separated list of phone numbers.

    No synthetic-range check here — UAT and production allowlists may still
    contain legacy routable numbers until Secret Manager rotation (Phases 2+3).
    The reserved-range guard lives in _configured_dev_phone_test_numbers() only.
    """
    if not raw:
        return set()
    return {
        normalized
        for normalized in (_normalize_phone_number(part) for part in re.split(r"[,;\n]+", raw))
        if normalized
    }


def _configured_uat_phone_test_numbers() -> set[str]:
    raw = _clean_env("HUSHH_UAT_PHONE_TEST_NUMBERS") or _clean_env("UAT_PHONE_TEST_NUMBERS")
    return _parse_phone_test_numbers(raw)


def _configured_prod_phone_test_numbers() -> set[str]:
    return _parse_phone_test_numbers(_clean_env("HUSHH_PROD_PHONE_TEST_NUMBERS"))


def _configured_dev_phone_test_numbers() -> set[str]:
    """Return dev simulation numbers, enforcing the synthetic-range contract.

    Only numbers matching +1[2-9]xx55501xx are accepted here — real routable
    numbers in a dev simulation allowlist are an operator mistake that should
    fail loud rather than be silently narrowed.
    """
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    if not simulation_permitted():
        return set()
    raw = _clean_env("HUSHH_DEV_PHONE_TEST_NUMBERS")
    numbers = _parse_phone_test_numbers(raw)
    outside = {n for n in numbers if not SYNTHETIC_PHONE_PATTERN.match(n)}
    if outside:
        raise RuntimeError(
            "HUSHH_DEV_PHONE_TEST_NUMBERS may only contain reserved fictitious "
            f"numbers (+1[2-9]xx55501xx); refused {sorted(outside)}"
        )
    return numbers


def _configured_dev_phone_test_code() -> str:
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    return _clean_env("HUSHH_DEV_PHONE_TEST_CODE") if simulation_permitted() else ""


def _dev_phone_code_is_optional() -> bool:
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    if not simulation_permitted():
        return False
    return bool(
        _configured_dev_phone_test_numbers() and not _clean_env("HUSHH_DEV_PHONE_TEST_CODE")
    )


def _phone_test_expected_code(phone: str) -> tuple[str, bool]:
    """Return (expected_code, is_optional) for a phone number.

    Dev synthetic numbers: optional when no HUSHH_DEV_PHONE_TEST_CODE is set,
    otherwise use the dev code.
    UAT numbers that appear in the dev merged set: always use the UAT code
    (the reserved-range guard on the dev allowlist never applies to UAT numbers).
    """
    dev_numbers = _configured_dev_phone_test_numbers()
    if dev_numbers and phone in dev_numbers:
        if _dev_phone_code_is_optional():
            return ("", True)
        return (_configured_dev_phone_test_code(), False)
    # Phone is from the UAT allowlist (merged into dev lane or on real UAT).
    uat_code = _configured_uat_phone_test_code()
    if uat_code:
        return (uat_code, False)
    return (_configured_phone_test_code(), False)


def _isolated_phone_fixture_enabled() -> bool:
    """Local recorded SMS transport; ordinary auth/challenge/claim checks still run."""
    return (
        _runtime_environment() in {"development", "local", "test"}
        and _clean_env("ONE_PUBLIC_PROFILE_FIXTURE_MODE") == "true"
        and _clean_env("DB_HOST") in {"localhost", "127.0.0.1"}
        and _clean_env("DB_NAME").startswith("hushh_profile_fixture_")
        and not _clean_env("DB_UNIX_SOCKET")
    )


def _configured_phone_test_numbers() -> set[str]:
    environment = _runtime_environment()
    dev_numbers = _configured_dev_phone_test_numbers()
    if dev_numbers:
        # On the dev simulation lane, also include the operator-curated UAT
        # allowlist so the founder's standing +1 989 898 9894 / 000000 pair
        # remains reachable without touching the reserved-range guard.
        return dev_numbers | _configured_uat_phone_test_numbers()
    if environment == "uat" or _isolated_phone_fixture_enabled():
        return _configured_uat_phone_test_numbers()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_numbers()
    return set()


def _configured_uat_phone_test_code() -> str:
    return _clean_env("HUSHH_UAT_PHONE_TEST_CODE") or _clean_env("UAT_PHONE_TEST_CODE")


def _configured_prod_phone_test_code() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CODE")


def _configured_prod_phone_test_challenge_secret() -> str:
    return _clean_env("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET")


def _configured_phone_test_code() -> str:
    dev_code = _configured_dev_phone_test_code()
    if dev_code:
        return dev_code
    environment = _runtime_environment()
    if environment == "uat" or _isolated_phone_fixture_enabled():
        return _configured_uat_phone_test_code()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_code()
    return ""


def _phone_test_enabled() -> bool:
    if _runtime_environment() == "production":
        return bool(
            _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED")
            and _configured_prod_phone_test_numbers()
            and _configured_prod_phone_test_code()
            and _configured_prod_phone_test_challenge_secret()
        )
    if _configured_dev_phone_test_numbers():
        return bool(_configured_dev_phone_test_code() or _dev_phone_code_is_optional())
    return bool(_configured_phone_test_numbers() and _configured_phone_test_code())


def _phone_test_challenge_key() -> str:
    if _is_dev_environment():
        return (
            _clean_env("HUSHH_DEV_PHONE_TEST_CHALLENGE_SECRET")
            or _clean_env("APP_SIGNING_KEY")
            or _configured_dev_phone_test_code()
        )
    environment = _runtime_environment()
    if environment == "production" and _is_truthy_env("HUSHH_PROD_PHONE_TEST_ENABLED"):
        return _configured_prod_phone_test_challenge_secret()
    return (
        _clean_env("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET")
        or _clean_env("APP_SIGNING_KEY")
        or _configured_uat_phone_test_code()
    )


def phone_test_transport_readiness() -> str | None:
    """Advisory configuration availability; never issues or verifies a challenge."""
    if _runtime_environment() not in {"dev", "uat", "production"} and not _is_dev_environment():
        return None
    return "healthy" if _phone_test_enabled() and _phone_test_challenge_key() else "unavailable"


def _create_uat_phone_test_verification_id(phone_number: str) -> str:
    digest = hmac.new(
        _phone_test_challenge_key().encode("utf-8"),
        phone_number.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"uat-test-phone:{digest}"


def _is_valid_uat_phone_test_verification_id(phone_number: str, verification_id: str) -> bool:
    expected = _create_uat_phone_test_verification_id(phone_number)
    return secrets.compare_digest(str(verification_id or "").strip(), expected)


def create_phone_test_challenge(owner: str, phone: str) -> str | None:
    dev = configured_dev_reviewer_phone_transport()
    if dev is not None and dev.admits(owner, phone):
        return dev.issue()
    if _phone_test_enabled() and phone in _configured_phone_test_numbers():
        return _create_uat_phone_test_verification_id(phone)
    return None


def validate_phone_test_confirmation(owner: str, phone: str, challenge: str, code: str) -> str:
    dev = configured_dev_reviewer_phone_transport()
    if dev is not None and dev.admits(owner, phone):
        if not dev.verifies(challenge, code):
            raise HTTPException(
                status_code=401, detail={"code": "DEV_REVIEWER_PHONE_INVALID_PROOF"}
            )
        return "dev_reviewer_test_phone_claim"
    if not _phone_test_enabled() or phone not in _configured_phone_test_numbers():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "UAT_PHONE_TEST_NOT_ALLOWLISTED",
                "message": "This phone number is not allowlisted for UAT test verification.",
            },
        )
    if not _is_valid_uat_phone_test_verification_id(phone, challenge):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "UAT_PHONE_TEST_INVALID_CHALLENGE",
                "message": "The UAT phone verification challenge is invalid.",
            },
        )
    expected_code, optional_code = _phone_test_expected_code(phone)
    if not optional_code and not secrets.compare_digest(code.strip(), expected_code):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "UAT_PHONE_TEST_INVALID_CODE",
                "message": "The UAT phone verification code is invalid.",
            },
        )
    return "uat_test_phone_claim"


def _require_phone_verification_owner(expected_user_id: str | None, firebase_uid: str) -> None:
    if expected_user_id is not None and expected_user_id != firebase_uid:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PHONE_VERIFICATION_ACCOUNT_CHANGED",
                "message": "Your signed-in account changed. Start phone verification again.",
            },
        )
