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
from urllib.parse import urlsplit

import asyncpg

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService
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


class RIAClaimEmailError(RIAIAMPolicyError):
    """A claim email-verification precondition failed; carries a stable code."""

    def __init__(self, message: str, *, code: str, status_code: int = 409) -> None:
        super().__init__(message, status_code=status_code)
        self.code = code


# Consumer mailbox providers can never prove firm affiliation.
FREE_MAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "msn.com",
        "yahoo.com",
        "ymail.com",
        "icloud.com",
        "me.com",
        "mac.com",
        "proton.me",
        "protonmail.com",
        "pm.me",
        "aol.com",
        "zoho.com",
        "gmx.com",
        "mail.com",
    }
)

# Common two-label public suffixes so "firm.co.uk" is not reduced to "co.uk".
_MULTI_PART_SUFFIXES = frozenset(
    {
        "co.uk",
        "org.uk",
        "ac.uk",
        "gov.uk",
        "com.au",
        "net.au",
        "org.au",
        "co.nz",
        "co.in",
        "com.sg",
        "com.hk",
        "co.jp",
        "com.br",
        "com.mx",
        "co.za",
    }
)


def registrable_domain(host: str) -> str:
    """Reduce a hostname to its registrable domain (small-suffix heuristic)."""
    labels = [label for label in str(host or "").strip().lower().strip(".").split(".") if label]
    if len(labels) < 2:
        return ".".join(labels)
    if len(labels) >= 3 and ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def firm_website_host(website: str | None) -> str:
    """Extract the bare host from a Form ADV website value ('' when unusable)."""
    value = str(website or "").strip().lower()
    if not value:
        return ""
    if "://" not in value:
        value = f"https://{value}"
    try:
        host = urlsplit(value).hostname or ""
    except ValueError:
        return ""
    if host.startswith("www."):
        host = host[len("www.") :]
    return host


def email_domain(email: str) -> str:
    value = str(email or "").strip().lower()
    if "@" not in value:
        return ""
    return value.rsplit("@", 1)[1]


def is_free_mail_domain(domain: str) -> bool:
    return registrable_domain(domain) in FREE_MAIL_DOMAINS


def email_matches_firm_domain(email: str, website: str | None) -> bool:
    """True when the address's registrable domain is the firm website's.

    Server-side gate that must pass BEFORE any email evidence is asserted
    upstream, even though the evaluator also checks the domain itself.
    """
    alias_domain = email_domain(email)
    host = firm_website_host(website)
    if not alias_domain or not host:
        return False
    if is_free_mail_domain(alias_domain):
        return False
    return registrable_domain(alias_domain) == registrable_domain(host)


def mask_email(email: str) -> str:
    value = str(email or "").strip().lower()
    if "@" not in value:
        return "•••"
    local, domain = value.rsplit("@", 1)
    lead = local[0] if local else "•"
    return f"{lead}•••@{domain}"


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
        "total_employees": raw.get("totalEmployees"),
        "street1": address.get("street1"),
        "street2": address.get("street2"),
        "zip": address.get("zip"),
        "registration_type": raw.get("registrationType"),
        "report_url": raw.get("reportUrl"),
        "form_adv_pdf_url": raw.get("formAdvPdfUrl"),
        "form_crs_url": raw.get("formCrsUrl"),
        # States the firm has notice-filed in: the public "licensed in" list.
        "notice_filed_states": [
            str(item.get("jurisdiction"))
            for item in (raw.get("noticeFilings") or [])
            if isinstance(item, dict) and item.get("jurisdiction")
        ],
        "registrations": [
            {
                "jurisdiction": item.get("secJurisdiction"),
                "status": item.get("status"),
                "effective_date": item.get("effectiveDate"),
            }
            for item in (raw.get("registrations") or [])
            if isinstance(item, dict)
        ],
        "brochures": [
            {
                "name": item.get("name"),
                "date_submitted": item.get("dateSubmitted"),
                "url": item.get("url"),
            }
            for item in (raw.get("brochures") or [])
            if isinstance(item, dict) and item.get("url")
        ],
    }


def _shape_advisor_record(raw: dict[str, Any] | None) -> dict[str, Any]:
    """The public regulatory record we can put on a claimed profile.

    Every field here is published on adviserinfo.sec.gov. Disclosure *events*
    are deliberately reduced to a flag and a count rather than parsed detail:
    the element shape is unverified, and a profile should link to the SEC record
    rather than restate someone's disciplinary history from a guessed schema.
    """
    individual: dict[str, Any] = raw if isinstance(raw, dict) else {}
    employments = individual.get("currentEmployments")
    current = employments[0] if isinstance(employments, list) and employments else {}
    if not isinstance(current, dict):
        current = {}
    branches = current.get("branches")
    branch = branches[0] if isinstance(branches, list) and branches else {}
    if not isinstance(branch, dict):
        branch = {}
    disclosures = individual.get("disclosures")
    return {
        "crd": individual.get("crd"),
        "other_names": [str(n) for n in (individual.get("otherNames") or []) if n],
        "registered_since": current.get("registrationBeginDate"),
        "exams": [
            {
                "code": item.get("code"),
                "name": item.get("name"),
                "date": item.get("date"),
            }
            for item in (individual.get("exams") or [])
            if isinstance(item, dict) and item.get("code")
        ],
        "registered_states": [
            {
                "state": item.get("state"),
                "scope": item.get("regScope"),
                "status": item.get("status"),
                "date": item.get("regDate"),
            }
            for item in (individual.get("registeredStates") or [])
            if isinstance(item, dict) and item.get("state")
        ],
        "previous_firms": [
            {
                "firm_name": item.get("firmName"),
                "firm_crd": item.get("firmCrd"),
                "from": item.get("from"),
                "to": item.get("to"),
            }
            for item in (individual.get("previousEmployments") or [])
            if isinstance(item, dict) and item.get("firmName")
        ],
        "branch": {
            "city": branch.get("city"),
            "state": branch.get("state"),
            "street1": branch.get("street1"),
            "zip": branch.get("zip"),
            "private_residence": branch.get("privateResidence"),
        }
        if branch
        else None,
        "has_disclosures": bool(individual.get("hasDisclosures")),
        "disclosure_count": len(disclosures) if isinstance(disclosures, list) else 0,
        "report_url": individual.get("reportUrl"),
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
        identity_service: ActorIdentityService | None = None,
    ) -> None:
        self._client = client or RIAIdentityClient()
        self._iam_service = iam_service or RIAIAMService()
        self._identity_service = identity_service or ActorIdentityService()

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

        # Pull the adviser's full public record so the profile is built from the
        # regulator's own data instead of asking the person to type it. Best
        # effort: a claim must never fail because enrichment did.
        advisor_record: dict[str, Any] = {}
        if claim_type == "individual" and individual_crd is not None:
            try:
                fetched = await self._client.advisor_record(individual_crd)
                advisor_record = _shape_advisor_record(fetched.get("individual"))
            except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
                # A claim must never fail because the profile could not be
                # enriched. Any upstream fault, timeout, or shape change leaves
                # the person claimed with a thinner profile rather than blocked.
                logger.info("ria.claim_enrichment_skipped error=%s", type(exc).__name__)

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
            # The snapshot the profile was built from, kept for provenance.
            "firm_record": firm,
            "advisor_record": advisor_record,
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
            # Regulator facts, straight from the public record.
            regulator="SEC" if firm.get("registration_type") == "sec" else "State",
            regulator_status=firm.get("registration_status"),
            disclosures_url=(advisor_record.get("report_url") or firm.get("report_url")),
            certifications=[
                str(exam.get("code"))
                for exam in advisor_record.get("exams", [])
                if exam.get("code")
            ],
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
        branch = advisor_record.get("branch") or {}
        # What the regulator publishes, so the screen can show the person what
        # was filled in for them rather than an empty profile.
        facts = {
            "crd_number": crd_number,
            "regulator": "SEC" if firm.get("registration_type") == "sec" else "State",
            "regulator_status": firm.get("registration_status"),
            "registered_since": advisor_record.get("registered_since"),
            "branch_city": branch.get("city"),
            "branch_state": branch.get("state"),
            "exams": advisor_record.get("exams", []),
            "registered_states": advisor_record.get("registered_states", []),
            "previous_firms": advisor_record.get("previous_firms", []),
            "notice_filed_states": firm.get("notice_filed_states", []),
            "aum": firm.get("aum"),
            "num_accounts": firm.get("num_accounts"),
            "firm_website": firm.get("website"),
            "report_url": advisor_record.get("report_url") or firm.get("report_url"),
            "has_disclosures": advisor_record.get("has_disclosures"),
        }
        await self._record_claim_enrichment(user_id, facts)
        return {
            "status": "claimed",
            "claim_type": claim_type,
            "verification_level": verification_level,
            "profile_verified": profile_verified,
            "provisional": provisional,
            "profile": profile,
            "facts": facts,
        }

    async def _load_claim_context(self, user_id: str) -> dict[str, Any] | None:
        """Latest persisted claim snapshot plus the profile row it belongs to."""
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT
                      p.id AS ria_profile_id,
                      p.display_name,
                      p.legal_name,
                      p.finra_crd,
                      p.verification_status,
                      e.reference_metadata
                    FROM ria_verification_events e
                    JOIN ria_profiles p ON p.id = e.ria_profile_id
                    WHERE p.user_id = $1
                      AND e.provider = $2
                    ORDER BY e.checked_at DESC
                    LIMIT 1
                    """,
                    normalized_user_id,
                    CLAIM_PROVIDER_LABEL,
                )
        except asyncpg.UndefinedTableError:
            return None
        if row is None:
            return None
        metadata_raw = row["reference_metadata"]
        metadata: dict[str, Any] = {}
        if isinstance(metadata_raw, dict):
            metadata = metadata_raw
        elif isinstance(metadata_raw, str):
            try:
                parsed = json.loads(metadata_raw)
                metadata = parsed if isinstance(parsed, dict) else {}
            except ValueError:
                metadata = {}
        return {
            "ria_profile_id": str(row["ria_profile_id"]),
            "display_name": str(row["display_name"] or ""),
            "legal_name": str(row["legal_name"] or ""),
            "crd_number": str(row["finra_crd"] or ""),
            "verification_status": str(row["verification_status"] or ""),
            "metadata": metadata,
        }

    @staticmethod
    def _check_claim_email_domain(email: str, firm_record: dict[str, Any]) -> None:
        """Fail closed unless the address sits on the claimed firm's own domain."""
        domain = email_domain(email)
        if not domain:
            raise RIAClaimEmailError(
                "Enter a valid work email.",
                code="EMAIL_INVALID",
                status_code=422,
            )
        if is_free_mail_domain(domain):
            raise RIAClaimEmailError(
                "Use your work email at the firm.",
                code="EMAIL_DOMAIN_MISMATCH",
            )
        if not email_matches_firm_domain(email, firm_record.get("website")):
            raise RIAClaimEmailError(
                "This email doesn't match your firm's website domain.",
                code="EMAIL_DOMAIN_MISMATCH",
            )

    async def prepare_email_verification(self, user_id: str, email: str) -> dict[str, Any]:
        """Server-side domain gate for /claim/email/start.

        Validates the address against the *persisted* firm record before any
        alias ceremony begins; nothing the browser asserts is trusted.
        """
        context = await self._load_claim_context(user_id)
        if context is None or not context["metadata"]:
            raise RIAClaimEmailError(
                "Claim your profile before verifying a work email.",
                code="CLAIM_CONTEXT_MISSING",
            )
        email_normalized = str(email or "").strip().lower()
        firm_record_raw = context["metadata"].get("firm_record")
        firm_record: dict[str, Any] = firm_record_raw if isinstance(firm_record_raw, dict) else {}
        self._check_claim_email_domain(email_normalized, firm_record)
        return {
            "email": email_normalized,
            "email_masked": mask_email(email_normalized),
            "firm_name": title_case_name(firm_record.get("name")) or None,
        }

    async def upgrade_with_email_evidence(self, user_id: str, *, email: str) -> dict[str, Any]:
        """Re-evaluate the persisted claim with a verified work-email alias.

        The profile is only ever upgraded through
        ``claim_ria_profile_from_identity`` (same-identity re-claim, which
        never downgrades), and only when the evaluator itself answers
        ``verificationLevel == "verified"``. On any other outcome nothing is
        written and the stored status stays exactly as it was.
        """
        context = await self._load_claim_context(user_id)
        if context is None or not context["metadata"]:
            raise RIAClaimEmailError(
                "Claim your profile before verifying a work email.",
                code="CLAIM_CONTEXT_MISSING",
            )
        metadata = context["metadata"]
        firm_record_raw = metadata.get("firm_record")
        firm_record: dict[str, Any] = firm_record_raw if isinstance(firm_record_raw, dict) else {}
        email_normalized = str(email or "").strip().lower()
        self._check_claim_email_domain(email_normalized, firm_record)

        verified_alias: str | None = None
        for alias in await self._identity_service.list_verified_email_aliases(user_id):
            if str(alias.get("verification_status") or "").strip().lower() != "verified":
                continue
            if alias.get("revoked_at") is not None:
                continue
            alias_email = str(alias.get("email_normalized") or alias.get("email") or "").lower()
            if alias_email == email_normalized:
                verified_alias = alias_email
                break
        if not verified_alias:
            raise RIAClaimEmailError(
                "Verify this email before it can be used as claim evidence.",
                code="EMAIL_ALIAS_NOT_VERIFIED",
            )

        phone_digits = normalize_nanp_phone(str(metadata.get("phone") or ""))
        claim_type = str(metadata.get("claim_type") or "")
        try:
            firm_crd = int(metadata.get("firm_crd") or 0)
        except (TypeError, ValueError):
            firm_crd = 0
        individual_crd_raw = metadata.get("individual_crd")
        try:
            individual_crd = int(individual_crd_raw) if individual_crd_raw is not None else None
        except (TypeError, ValueError):
            individual_crd = None
        display_name = context["display_name"] or title_case_name(context["legal_name"])
        if not phone_digits or claim_type not in {"individual", "firm"} or firm_crd <= 0:
            raise RIAClaimEmailError(
                "The stored claim snapshot is incomplete. Re-claim your profile first.",
                code="CLAIM_CONTEXT_MISSING",
            )
        if not display_name:
            raise RIAClaimEmailError(
                "The stored claim snapshot is incomplete. Re-claim your profile first.",
                code="CLAIM_CONTEXT_MISSING",
            )

        try:
            payload = await self._client.claim_evaluate(
                phone=phone_digits,
                claim_type=claim_type,
                firm_crd=firm_crd,
                individual_crd=individual_crd,
                # Possession of the filed number was proven at original claim
                # time and lives in the persisted evidence ledger.
                assert_phone_otp=True,
                extra_evidence=[{"signal": "domain_email", "email": verified_alias}],
            )
        except (
            RIAIdentityNotConfiguredError,
            RIAIdentityUnavailableError,
            RIAIdentityRequestError,
        ) as exc:
            raise self._map_upstream_error(exc) from exc

        verification_level = str(payload.get("verificationLevel") or "none")
        current_status = context["verification_status"]
        if verification_level != "verified":
            # No status write without the evaluator's verified answer.
            return {
                "verified": current_status in {"verified", "active", "finra_verified"},
                "verification_status": current_status,
                "verification_level": verification_level,
                "satisfied": payload.get("satisfied") or [],
                "missing": payload.get("missing") or [],
            }

        fresh_firm = _shape_firm(payload.get("firm")) or {}
        firm = {
            **firm_record,
            **{key: value for key, value in fresh_firm.items() if value not in (None, "", [])},
        }
        advisor_record_raw = metadata.get("advisor_record")
        advisor_record: dict[str, Any] = (
            advisor_record_raw if isinstance(advisor_record_raw, dict) else {}
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
            "evidence_upgrade": "domain_email",
            "firm_record": firm,
            "advisor_record": advisor_record,
        }

        legal_name = context["legal_name"] or display_name
        crd_number = context["crd_number"] or (
            str(individual_crd) if claim_type == "individual" and individual_crd else str(firm_crd)
        )
        firm_name = str(firm.get("name") or "").strip() or None

        profile = await self._iam_service.claim_ria_profile_from_identity(
            user_id,
            claim_type=claim_type,
            verification_level=verification_level,
            phone_e164=f"+1{phone_digits}",
            display_name=display_name,
            legal_name=legal_name,
            crd_number=crd_number,
            firm_name=firm_name,
            firm_crd=str(firm_crd),
            firm_website=firm.get("website"),
            firm_sec_number=firm.get("sec_number"),
            reference_metadata=reference_metadata,
            regulator="SEC" if firm.get("registration_type") == "sec" else "State",
            regulator_status=firm.get("registration_status"),
            disclosures_url=(advisor_record.get("report_url") or firm.get("report_url")),
            certifications=[
                str(exam.get("code"))
                for exam in advisor_record.get("exams", [])
                if isinstance(exam, dict) and exam.get("code")
            ],
        )
        logger.info(
            json.dumps(
                {
                    "event": "ria.claim_email_upgrade",
                    "claim_type": claim_type,
                    "verification_level": verification_level,
                    "firm_crd": firm_crd,
                }
            )
        )
        return {
            "verified": True,
            "verification_status": str(profile.get("verification_status") or "verified"),
            "verification_level": verification_level,
            "profile": profile,
        }

    async def _record_claim_enrichment(self, user_id: str, facts: dict[str, Any]) -> None:
        """Stage the claim's regulator facts in the user's knowledge planes.

        The encrypted PKM blob is BYOK — only the owner's unlocked vault can
        write it, so the client does that from the done screen. Here the server
        writes the planes it legitimately owns: the append-only audit event
        (the staged facts a vault session can materialize), the sanitized
        discovery flag, and the durable setup mirror that marks the RIA
        capability finished. Each block is best-effort in isolation: a claim
        must never fail, and one plane must never block another.
        """
        try:
            from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

            await get_pkm_service().record_mutation_event(
                user_id=user_id,
                domain="ria",
                operation_type="attribute_inference",
                path_set=["regulator_profile"],
                source_agent=CLAIM_PROVIDER_LABEL,
                confidence=1.0,
                metadata={"regulator_profile": facts},
            )
        except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
            logger.info("ria.claim_pkm_event_skipped error=%s", type(exc).__name__)

        try:
            from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

            await get_pkm_service().update_domain_summary(
                user_id, "ria", {"has_regulator_profile": True}
            )
        except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
            logger.info("ria.claim_pkm_summary_skipped error=%s", type(exc).__name__)

        try:
            from hushh_mcp.services.vault_keys_service import VaultKeysService

            vault_keys = VaultKeysService()
            state = await vault_keys.get_pre_vault_state(user_id)
            capability_ids = [str(v) for v in (state.get("setupCapabilityIds") or [])]
            if "ria" not in capability_ids:
                await vault_keys.update_pre_vault_state(
                    user_id=user_id,
                    setup_capability_ids=sorted({*capability_ids, "ria"}),
                )
        except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
            logger.info("ria.claim_setup_mirror_skipped error=%s", type(exc).__name__)
