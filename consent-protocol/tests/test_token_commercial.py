"""Tests for commercial / non-commercial consent token handshakes (issue #30).

Validates that:
- Tokens default to non-commercial when commercial flag is not provided.
- Commercial tokens carry the flag through validation and into the parsed
  HushhConsentToken object.
- The commercial flag is part of the signed payload, so tampering with it
  invalidates the signature.
- The require_commercial gate enforces that commercial-only operations
  reject non-commercial tokens and vice versa.
- Existing 5-field tokens (issued before this change) still validate as
  non-commercial without modification.
"""

from __future__ import annotations

import base64
import time

import pytest

from hushh_mcp.consent.token import _sign, issue_token, validate_token, validate_token_with_db
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX, ConsentScope
from hushh_mcp.services.consent_db import ConsentDBService

USER_ID = "user_test"
AGENT_ID = "agent_alpha"
SCOPE = ConsentScope.PKM_READ


# ---------------------------------------------------------------------------
# Default behavior: tokens are non-commercial unless asked
# ---------------------------------------------------------------------------


class TestDefaultNonCommercial:
    def test_issue_default_is_non_commercial(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE)
        assert token.commercial is False

    def test_validate_default_returns_non_commercial(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE)
        valid, _, parsed = validate_token(token.token, SCOPE)
        assert valid is True
        assert parsed is not None
        assert parsed.commercial is False


# ---------------------------------------------------------------------------
# Commercial tokens: the flag round-trips through issue/validate
# ---------------------------------------------------------------------------


class TestCommercialRoundTrip:
    def test_issue_commercial_sets_flag(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        assert token.commercial is True

    def test_validate_commercial_returns_flag(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        valid, _, parsed = validate_token(token.token, SCOPE)
        assert valid is True
        assert parsed is not None
        assert parsed.commercial is True

    def test_explicit_non_commercial_round_trip(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
        valid, _, parsed = validate_token(token.token, SCOPE)
        assert valid is True
        assert parsed is not None
        assert parsed.commercial is False


# ---------------------------------------------------------------------------
# Tamper resistance: the commercial flag is part of the signed payload
# ---------------------------------------------------------------------------


class TestCommercialTamperResistance:
    def test_tampered_commercial_appended_fails_signature(self) -> None:
        # Issue a non-commercial token, then forge a "commercial" suffix
        # without re-signing. Validation must reject this.
        token = issue_token(USER_ID, AGENT_ID, SCOPE)
        prefix, signed_part = token.token.split(":", 1)
        encoded, signature = signed_part.split(".")
        decoded = base64.urlsafe_b64decode(encoded.encode()).decode()
        forged = f"{decoded}|commercial"
        forged_encoded = base64.urlsafe_b64encode(forged.encode()).decode()
        forged_token = f"{prefix}:{forged_encoded}.{signature}"

        valid, reason, _ = validate_token(forged_token, SCOPE)
        assert valid is False
        assert reason == "Invalid signature"

    def test_tampered_commercial_stripped_fails_signature(self) -> None:
        # Issue a commercial token, then drop the "commercial" suffix
        # without re-signing. Validation must reject this.
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        prefix, signed_part = token.token.split(":", 1)
        encoded, signature = signed_part.split(".")
        decoded = base64.urlsafe_b64decode(encoded.encode()).decode()
        # Drop the trailing |commercial
        stripped = decoded.rsplit("|", 1)[0]
        stripped_encoded = base64.urlsafe_b64encode(stripped.encode()).decode()
        stripped_token = f"{prefix}:{stripped_encoded}.{signature}"

        valid, reason, _ = validate_token(stripped_token, SCOPE)
        assert valid is False
        assert reason == "Invalid signature"


# ---------------------------------------------------------------------------
# require_commercial gate: enforce monetization boundary
# ---------------------------------------------------------------------------


class TestRequireCommercialGate:
    def test_commercial_required_accepts_commercial_token(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        valid, reason, _ = validate_token(token.token, SCOPE, require_commercial=True)
        assert valid is True
        assert reason is None

    def test_commercial_required_rejects_non_commercial_token(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
        valid, reason, _ = validate_token(token.token, SCOPE, require_commercial=True)
        assert valid is False
        assert reason == "Commercial consent required for this operation"

    def test_non_commercial_required_accepts_non_commercial_token(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
        valid, reason, _ = validate_token(token.token, SCOPE, require_commercial=False)
        assert valid is True
        assert reason is None

    def test_non_commercial_required_rejects_commercial_token(self) -> None:
        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        valid, reason, _ = validate_token(token.token, SCOPE, require_commercial=False)
        assert valid is False
        assert reason == "Non-commercial consent required for this operation"

    def test_no_gate_accepts_either(self) -> None:
        commercial_token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        non_commercial_token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
        valid_a, _, _ = validate_token(commercial_token.token, SCOPE)
        valid_b, _, _ = validate_token(non_commercial_token.token, SCOPE)
        assert valid_a is True
        assert valid_b is True

    @pytest.mark.asyncio
    async def test_db_backed_commercial_gate_accepts_commercial_token(self, monkeypatch) -> None:
        async def _active(self, user_id: str, scope: str, agent_id: str) -> bool:
            return True

        monkeypatch.setattr(ConsentDBService, "is_token_active", _active)

        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
        valid, reason, parsed = await validate_token_with_db(
            token.token,
            SCOPE,
            require_commercial=True,
        )

        assert valid is True
        assert reason is None
        assert parsed is not None
        assert parsed.commercial is True

    @pytest.mark.asyncio
    async def test_db_backed_commercial_gate_rejects_non_commercial_token(
        self, monkeypatch
    ) -> None:
        async def _active(self, user_id: str, scope: str, agent_id: str) -> bool:
            raise AssertionError("DB revocation lookup should not run after local gate rejection")

        monkeypatch.setattr(ConsentDBService, "is_token_active", _active)

        token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
        valid, reason, parsed = await validate_token_with_db(
            token.token,
            SCOPE,
            require_commercial=True,
        )

        assert valid is False
        assert reason == "Commercial consent required for this operation"
        assert parsed is None


# ---------------------------------------------------------------------------
# Backward compatibility: legacy 5-field tokens still validate
# ---------------------------------------------------------------------------


class TestBackwardCompatibility:
    def test_legacy_five_field_token_validates_as_non_commercial(self) -> None:
        # Hand-craft a token in the original 5-field shape, signed with the
        # current key. This simulates a token issued before this change.
        issued_at = int(time.time() * 1000)
        expires_at = issued_at + 3600 * 1000
        raw = f"{USER_ID}|{AGENT_ID}|{SCOPE.value}|{issued_at}|{expires_at}"
        signature = _sign(raw)
        encoded = base64.urlsafe_b64encode(raw.encode()).decode()
        legacy_token = f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"

        valid, reason, parsed = validate_token(legacy_token, SCOPE)
        assert valid is True
        assert reason is None
        assert parsed is not None
        assert parsed.commercial is False

    def test_legacy_token_rejects_commercial_required_gate(self) -> None:
        issued_at = int(time.time() * 1000)
        expires_at = issued_at + 3600 * 1000
        raw = f"{USER_ID}|{AGENT_ID}|{SCOPE.value}|{issued_at}|{expires_at}"
        signature = _sign(raw)
        encoded = base64.urlsafe_b64encode(raw.encode()).decode()
        legacy_token = f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"

        valid, reason, _ = validate_token(legacy_token, SCOPE, require_commercial=True)
        assert valid is False
        assert reason == "Commercial consent required for this operation"

    def test_seven_field_payload_rejected(self) -> None:
        # Defense in depth: any payload that does not match the documented
        # 5-field or 6-field shape is rejected outright.
        issued_at = int(time.time() * 1000)
        expires_at = issued_at + 3600 * 1000
        raw = f"{USER_ID}|{AGENT_ID}|{SCOPE.value}|{issued_at}|{expires_at}|commercial|extra"
        signature = _sign(raw)
        encoded = base64.urlsafe_b64encode(raw.encode()).decode()
        weird_token = f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"

        valid, reason, _ = validate_token(weird_token, SCOPE)
        assert valid is False
        assert "Malformed" in (reason or "")

    def test_six_field_with_unknown_marker_rejected(self) -> None:
        issued_at = int(time.time() * 1000)
        expires_at = issued_at + 3600 * 1000
        raw = f"{USER_ID}|{AGENT_ID}|{SCOPE.value}|{issued_at}|{expires_at}|paid"
        signature = _sign(raw)
        encoded = base64.urlsafe_b64encode(raw.encode()).decode()
        weird_token = f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"

        valid, reason, _ = validate_token(weird_token, SCOPE)
        assert valid is False
        assert "Malformed" in (reason or "")
