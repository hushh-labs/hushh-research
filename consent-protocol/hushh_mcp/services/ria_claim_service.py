"""RIA claim-by-phone: resolve an office number to SEC claim targets and claim one.

Flow: lookup (phone → firm + advisers) → OTP possession proof → evaluate (this
backend asserts ``phone_otp`` upstream only after verifying possession itself)
→ complete (auto-provision the RIA profile from the SEC record).

The OTP proves the claimant can answer the firm's Form ADV number — firm
affiliation, not identity. A claim that reaches only ``provisional`` is stored
with ``verification_status='submitted'`` so no verified-only gate opens.

Demo/test passcode path: mirrors the ``HUSHH_UAT_PHONE_TEST_*`` design in
``api/routes/account.py`` — an env allowlist of numbers accepts a fixed code so
no SMS is ever sent to a real firm's line. Never enabled in production
(enforced by ``validate_regulated_runtime_configuration``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from typing import Any

from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService
from hushh_mcp.services.ria_identity_client import (
    RIAIdentityClient,
    RIAIdentityNotConfiguredError,
    RIAIdentityRequestError,
    RIAIdentityUnavailableError,
)

logger = logging.getLogger(__name__)

CLAIM_PROVIDER_LABEL = "ria_identity_claim"
_CLAIM_TEST_VERIFICATION_PREFIX = "ria-claim-test:"
_CLAIM_TICKET_PREFIX = "ria-claim-ticket.v1"
_CLAIM_TICKET_TTL_SECONDS = 15 * 60


def _clean_env(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _runtime_environment() -> str:
    return (_clean_env("ENVIRONMENT") or _clean_env("HUSHH_DEPLOY_ENV")).lower()


def _is_production_environment() -> bool:
    return _runtime_environment() in {"prod", "production"}


def normalize_nanp_phone(raw: str) -> str:
    """Reduce any phone formatting to a 10-digit NANP national number, or ''."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10 or digits[0] in {"0", "1"}:
        return ""
    return digits


def mask_phone_digits(digits10: str) -> str:
    if len(digits10) != 10:
        return "•••"
    return f"••• ••• {digits10[-4:]}"


def claim_test_numbers() -> set[str]:
    raw = _clean_env("RIA_CLAIM_TEST_NUMBERS")
    if not raw:
        return set()
    return {
        normalized
        for normalized in (normalize_nanp_phone(part) for part in re.split(r"[,;\n]+", raw))
        if normalized
    }


def claim_test_code() -> str:
    return _clean_env("RIA_CLAIM_TEST_CODE")


def claim_test_enabled() -> bool:
    """Fixed-code claim OTP: never in production, and only when configured."""
    if _is_production_environment():
        return False
    return bool(claim_test_numbers() and claim_test_code())


def _challenge_key() -> str:
    return (
        _clean_env("RIA_CLAIM_TEST_CHALLENGE_SECRET")
        or _clean_env("APP_SIGNING_KEY")
        or claim_test_code()
    )


def create_test_verification_id(digits10: str) -> str:
    digest = hmac.new(
        _challenge_key().encode("utf-8"),
        f"{_CLAIM_TEST_VERIFICATION_PREFIX}{digits10}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{_CLAIM_TEST_VERIFICATION_PREFIX}{digest}"


def is_valid_test_verification_id(digits10: str, verification_id: str) -> bool:
    expected = create_test_verification_id(digits10)
    return secrets.compare_digest(str(verification_id or "").strip(), expected)


def verify_test_possession(digits10: str, verification_id: str, verification_code: str) -> bool:
    """True only when the test path is enabled, the number is allowlisted, and
    both the challenge and the fixed code match (constant-time)."""
    if not claim_test_enabled():
        return False
    if digits10 not in claim_test_numbers():
        return False
    if not is_valid_test_verification_id(digits10, verification_id):
        return False
    return secrets.compare_digest(str(verification_code or "").strip(), claim_test_code())


def _ticket_key() -> str:
    return _clean_env("APP_SIGNING_KEY") or _challenge_key()


def _ticket_signature(user_id: str, digits10: str, expires_epoch: int) -> str:
    return hmac.new(
        _ticket_key().encode("utf-8"),
        f"{_CLAIM_TICKET_PREFIX}|{user_id}|{digits10}|{expires_epoch}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def mint_claim_ticket(user_id: str, digits10: str) -> str:
    expires_epoch = int(time.time()) + _CLAIM_TICKET_TTL_SECONDS
    return (
        f"{_CLAIM_TICKET_PREFIX}:{expires_epoch}:"
        f"{_ticket_signature(user_id, digits10, expires_epoch)}"
    )


def validate_claim_ticket(ticket: str, user_id: str, digits10: str) -> bool:
    parts = str(ticket or "").strip().split(":")
    if len(parts) != 3 or parts[0] != _CLAIM_TICKET_PREFIX:
        return False
    try:
        expires_epoch = int(parts[1])
    except ValueError:
        return False
    if expires_epoch < int(time.time()):
        return False
    expected = _ticket_signature(user_id, digits10, expires_epoch)
    return secrets.compare_digest(parts[2], expected)


def title_case_name(value: str | None) -> str:
    """SEC records shout in caps; render "REGINALD TROY MAXFIELD" as a name."""
    text = str(value or "").strip()
    if not text:
        return ""
    small = {"llc", "lp", "llp", "pc", "pa", "ltd", "inc"}
    words = []
    for word in text.split():
        cleaned = word.strip(",.").lower()
        if cleaned in small:
            words.append(word.replace(word.strip(",."), cleaned.upper()))
        else:
            words.append(word.capitalize())
    return " ".join(words)


def _shape_firm(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    address_raw = raw.get("address")
    address: dict[str, Any] = address_raw if isinstance(address_raw, dict) else {}
    return {
        "crd": raw.get("crd"),
        "name": raw.get("name"),
        "dba": raw.get("dba"),
        "sec_number": raw.get("secNumber"),
        "registration_status": raw.get("registrationStatus"),
        "city": address.get("city"),
        "state": address.get("state"),
        "phone": raw.get("phone"),
        "website": raw.get("website"),
        "advisory_employees": raw.get("advisoryEmployees"),
        "aum": raw.get("aum"),
        "num_accounts": raw.get("numAccounts"),
        "report_url": raw.get("reportUrl"),
    }


def _shape_candidate(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "individual_crd": raw.get("individualCrd"),
        "name": raw.get("name"),
        "firm_crd": raw.get("firmCrd"),
        "firm_name": raw.get("firmName"),
        "title": raw.get("title"),
        "branch_city": raw.get("branchCity"),
        "branch_state": raw.get("branchState"),
        "has_disclosures": raw.get("hasDisclosures"),
        "profile_url": raw.get("profileUrl"),
        "reasons": raw.get("reasons") if isinstance(raw.get("reasons"), list) else [],
        "claimable": raw.get("claimable", True),
    }


def _shape_roster_entry(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "individual_crd": raw.get("individualCrd"),
        "name": raw.get("name"),
        "branch_city": raw.get("branchCity"),
        "branch_state": raw.get("branchState"),
        "has_disclosures": raw.get("hasDisclosures"),
        "profile_url": raw.get("profileUrl"),
    }


class RIAClaimService:
    """Orchestrates lookup, possession-gated evaluation, and profile build."""

    def __init__(
        self,
        *,
        client: RIAIdentityClient | None = None,
        iam_service: RIAIAMService | None = None,
    ) -> None:
        self._client = client or RIAIdentityClient()
        self._iam_service = iam_service or RIAIAMService()

    @staticmethod
    def _map_upstream_error(exc: Exception) -> RIAIAMPolicyError:
        if isinstance(exc, RIAIdentityNotConfiguredError):
            return RIAIAMPolicyError(
                "Profile claiming is not available in this environment yet.",
                status_code=503,
            )
        if isinstance(exc, RIAIdentityUnavailableError):
            return RIAIAMPolicyError(
                "The adviser registry is temporarily unavailable. Try again shortly.",
                status_code=503,
            )
        if isinstance(exc, RIAIdentityRequestError):
            return RIAIAMPolicyError(str(exc), status_code=400)
        return RIAIAMPolicyError("Profile claim failed.", status_code=500)

    async def lookup(self, phone_raw: str) -> dict[str, Any]:
        digits10 = normalize_nanp_phone(phone_raw)
        if not digits10:
            return {
                "outcome": "invalid_phone",
                "next_step": "none",
                "phone": None,
                "firm": None,
                "firms": [],
                "candidates": [],
                "current_adviser_count": None,
            }
        try:
            payload = await self._client.claim_lookup(digits10)
        except (
            RIAIdentityNotConfiguredError,
            RIAIdentityUnavailableError,
            RIAIdentityRequestError,
        ) as exc:
            raise self._map_upstream_error(exc) from exc

        meta_raw = payload.get("meta")
        meta: dict[str, Any] = meta_raw if isinstance(meta_raw, dict) else {}
        firms_value = payload.get("firms")
        firms_raw: list[Any] = firms_value if isinstance(firms_value, list) else []
        candidates_value = payload.get("candidates")
        candidates_raw: list[Any] = candidates_value if isinstance(candidates_value, list) else []
        return {
            "outcome": meta.get("outcome"),
            "next_step": meta.get("nextStep"),
            "person_next_step": meta.get("personNextStep"),
            "confidence": meta.get("confidence"),
            "phone": digits10,
            "phone_masked": mask_phone_digits(digits10),
            "firm": _shape_firm(meta.get("firmClaim") or payload.get("firmClaim")),
            "firms": [shaped for shaped in (_shape_firm(f) for f in firms_raw) if shaped],
            "candidates": [_shape_candidate(c) for c in candidates_raw if isinstance(c, dict)],
            "current_adviser_count": meta.get("currentAdviserCount"),
            "roster_error": meta.get("rosterError"),
            "attribution": payload.get("attribution"),
        }

    def start_otp(self, user_id: str, phone_raw: str) -> dict[str, Any]:
        digits10 = normalize_nanp_phone(phone_raw)
        if not digits10:
            raise RIAIAMPolicyError("Enter a valid US phone number.", status_code=400)
        _ = user_id
        if claim_test_enabled() and digits10 in claim_test_numbers():
            return {
                "eligible": True,
                "delivery": "test_code",
                "verification_id": create_test_verification_id(digits10),
                "code_length": len(claim_test_code()),
                "phone_masked": mask_phone_digits(digits10),
            }
        return {
            "eligible": False,
            "delivery": "none",
            "reason": "otp_delivery_unavailable",
            "phone_masked": mask_phone_digits(digits10),
        }

    async def evaluate_with_possession(
        self,
        *,
        user_id: str,
        phone_digits: str,
        claim_type: str,
        firm_crd: int,
        individual_crd: int | None = None,
    ) -> dict[str, Any]:
        """Called only after the route has proven possession of the number."""
        try:
            payload = await self._client.claim_evaluate(
                phone=phone_digits,
                claim_type=claim_type,
                firm_crd=firm_crd,
                individual_crd=individual_crd,
                assert_phone_otp=True,
            )
        except (
            RIAIdentityNotConfiguredError,
            RIAIdentityUnavailableError,
            RIAIdentityRequestError,
        ) as exc:
            raise self._map_upstream_error(exc) from exc

        roster_raw = payload.get("roster") if isinstance(payload.get("roster"), list) else None
        return {
            "claim_ticket": mint_claim_ticket(user_id, phone_digits),
            "claim_type": payload.get("claimType"),
            "provisional": bool(payload.get("provisional")),
            "profile_verified": bool(payload.get("profileVerified")),
            "verification_level": payload.get("verificationLevel"),
            "satisfied": payload.get("satisfied") or [],
            "missing": payload.get("missing") or [],
            "explanation": payload.get("explanation"),
            "roster_unlocked": bool(payload.get("rosterUnlocked")),
            "roster": (
                [_shape_roster_entry(r) for r in roster_raw if isinstance(r, dict)]
                if roster_raw is not None
                else None
            ),
            "current_adviser_count": payload.get("currentAdviserCount"),
            "firm": _shape_firm(payload.get("firm")),
        }

    async def complete(
        self,
        *,
        user_id: str,
        phone_digits: str,
        claim_type: str,
        firm_crd: int,
        individual_crd: int | None = None,
    ) -> dict[str, Any]:
        """Authoritative re-evaluation, then auto-build the RIA profile."""
        if claim_type == "individual" and individual_crd is None:
            raise RIAIAMPolicyError("Pick which adviser you are before claiming.", status_code=400)
        try:
            payload = await self._client.claim_evaluate(
                phone=phone_digits,
                claim_type=claim_type,
                firm_crd=firm_crd,
                individual_crd=individual_crd,
                assert_phone_otp=True,
            )
        except (
            RIAIdentityNotConfiguredError,
            RIAIdentityUnavailableError,
            RIAIdentityRequestError,
        ) as exc:
            raise self._map_upstream_error(exc) from exc

        provisional = bool(payload.get("provisional"))
        profile_verified = bool(payload.get("profileVerified"))
        verification_level = str(payload.get("verificationLevel") or "none")
        if not provisional and not profile_verified:
            raise RIAIAMPolicyError(
                "This claim could not be granted with the evidence available.",
                status_code=403,
            )

        firm = _shape_firm(payload.get("firm")) or {}
        firm_name = str(firm.get("name") or "").strip()
        roster_value = payload.get("roster")
        roster_raw: list[Any] = roster_value if isinstance(roster_value, list) else []
        person_name = ""
        if claim_type == "individual" and individual_crd is not None:
            for entry in roster_raw:
                if isinstance(entry, dict) and entry.get("individualCrd") == individual_crd:
                    person_name = str(entry.get("name") or "").strip()
                    break
            if not person_name:
                raise RIAIAMPolicyError(
                    "The selected adviser is not on this firm's current roster.",
                    status_code=400,
                )

        if claim_type == "individual":
            legal_name = person_name
            display_name = title_case_name(person_name)
            crd_number = str(individual_crd)
        else:
            legal_name = firm_name
            display_name = title_case_name(firm_name)
            crd_number = str(firm_crd)
        if not display_name:
            raise RIAIAMPolicyError(
                "The SEC record for this claim is missing a usable name.",
                status_code=502,
            )

        reference_metadata = {
            "provider": CLAIM_PROVIDER_LABEL,
            "claim_type": claim_type,
            "phone": phone_digits,
            "firm_crd": firm_crd,
            "individual_crd": individual_crd,
            "verification_level": verification_level,
            "satisfied": payload.get("satisfied") or [],
            "missing": payload.get("missing") or [],
            "evidence_ledger": payload.get("evidenceLedger") or [],
            "scope_note": payload.get("scopeNote"),
        }

        profile = await self._iam_service.claim_ria_profile_from_identity(
            user_id,
            claim_type=claim_type,
            verification_level=verification_level,
            phone_e164=f"+1{phone_digits}",
            display_name=display_name,
            legal_name=legal_name,
            crd_number=crd_number,
            firm_name=firm_name or None,
            firm_crd=str(firm_crd),
            firm_website=firm.get("website"),
            firm_sec_number=firm.get("sec_number"),
            reference_metadata=reference_metadata,
        )
        logger.info(
            json.dumps(
                {
                    "event": "ria.claim_completed",
                    "claim_type": claim_type,
                    "verification_level": verification_level,
                    "firm_crd": firm_crd,
                }
            )
        )
        return {
            "status": "claimed",
            "claim_type": claim_type,
            "verification_level": verification_level,
            "profile_verified": profile_verified,
            "provisional": provisional,
            "profile": profile,
        }
