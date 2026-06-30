"""PKM privacy boundary proof for extended PII key sanitization.

Canonical attach point:
    hushh_mcp.services.pkm_agent_lab_service.PKMAgentLabService._strip_pii_from_payload_keys
    -> called by PKMAgentLabService._sanitize_candidate_payload
    -> reachable via POST /api/pkm/agent-lab/structure (vault-owner surface)

These tests prove:
- Extended PII key patterns (SSN, card numbers, account numbers, dollar amounts,
  currency-suffixed values, email addresses) are stripped from candidate payloads.
- No consent or data-boundary regression: legitimate PKM domain keys pass through
  the sanitizer without modification.
- The sanitizer recurses into nested dicts and lists so PII cannot survive by
  being buried in a sub-structure.
- _sanitize_candidate_payload calls _strip_pii_from_payload_keys on the raw
  LLM payload (not skipping it), proving the old stub no-op path is closed.
"""

from __future__ import annotations

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _strip(payload):
    """Convenience wrapper around the method under test."""
    return PKMAgentLabService._strip_pii_from_payload_keys(payload)


# ---------------------------------------------------------------------------
# class TestPiiKeySanitizationPkmPrivacy
# ---------------------------------------------------------------------------


class TestPiiKeySanitizationPkmPrivacy:
    """Prove extended PII key sanitization with no consent or data-boundary regression."""

    # -- SSN patterns --

    def test_ssn_dash_key_stripped(self):
        """Key formatted as SSN with dashes (123-45-6789) must be removed."""
        payload = {"123-45-6789": "some_value", "safe_key": "ok"}
        result = _strip(payload)
        assert "123-45-6789" not in result
        assert result["safe_key"] == "ok"

    def test_ssn_underscore_key_stripped(self):
        """Key formatted as SSN with underscores (123_45_6789) must be removed."""
        payload = {"123_45_6789": "value", "domain": "health"}
        result = _strip(payload)
        assert "123_45_6789" not in result
        assert result["domain"] == "health"

    # -- Dollar / currency-amount patterns --

    def test_dollar_amount_key_stripped(self):
        """Key containing a dollar amount ($50000) must be removed."""
        payload = {"$50000": True, "entity_count": 3}
        result = _strip(payload)
        assert "$50000" not in result
        assert result["entity_count"] == 3

    def test_dollar_with_space_key_stripped(self):
        """Key containing '$ 1000' (space after dollar sign) must be removed."""
        payload = {"$ 1000": True, "has_portfolio": True}
        result = _strip(payload)
        assert "$ 1000" not in result
        assert result["has_portfolio"] is True

    def test_currency_suffixed_number_key_stripped(self):
        """Key with format '100_dollars' must be removed."""
        payload = {"100_dollars": "balance_leak", "tag": "finance"}
        result = _strip(payload)
        assert "100_dollars" not in result
        assert result["tag"] == "finance"

    def test_usd_suffixed_key_stripped(self):
        """Key containing a USD-suffixed number must be removed."""
        payload = {"50_usd": True, "last_sync": "2024-01-15"}
        result = _strip(payload)
        assert "50_usd" not in result
        assert result["last_sync"] == "2024-01-15"

    # -- Large numeric sequence (account / card numbers) --

    def test_five_digit_sequence_key_stripped(self):
        """Key containing 5+ consecutive digits must be removed."""
        payload = {"account_12345678": True, "domain_count": 2}
        result = _strip(payload)
        assert "account_12345678" not in result
        assert result["domain_count"] == 2

    def test_card_number_key_stripped(self):
        """Key that is a long (16-digit) numeric sequence must be removed."""
        long_digit_key = "1234567812345678"
        payload = {long_digit_key: "card_data", "has_cards": True}
        result = _strip(payload)
        assert long_digit_key not in result
        assert result["has_cards"] is True

    # -- Email address patterns --

    def test_email_key_stripped(self):
        """Key that is an email address must be removed."""
        payload = {"user@example.com": "email_leak", "domain": "identity"}
        result = _strip(payload)
        assert "user@example.com" not in result
        assert result["domain"] == "identity"

    def test_email_key_with_plus_stripped(self):
        """Key with plus-addressing email must be removed."""
        payload = {"user+tag@corp.io": "value", "flag": True}
        result = _strip(payload)
        assert "user+tag@corp.io" not in result
        assert result["flag"] is True

    # -- Recursive traversal --

    def test_pii_key_in_nested_dict_stripped(self):
        """PII keys nested inside sub-dicts must be removed recursively."""
        payload = {"financial": {"123-45-6789": "ssn_val", "currency": "USD"}}
        result = _strip(payload)
        assert "123-45-6789" not in result["financial"]
        assert result["financial"]["currency"] == "USD"

    def test_pii_key_in_list_items_stripped(self):
        """PII keys inside list-element dicts must be removed recursively."""
        payload = {"records": [{"$99999": True, "ok_key": "x"}, {"$1234": True, "flag": True}]}
        result = _strip(payload)
        for item in result["records"]:
            assert "$99999" not in item
            assert "$1234" not in item
        assert result["records"][0]["ok_key"] == "x"

    # -- Legitimate PKM keys pass through (no regression) --

    def test_safe_presence_flags_key_passes(self):
        """The 'presence_flags' key must not be stripped."""
        payload = {"presence_flags": {"has_finance": True}}
        result = _strip(payload)
        assert "presence_flags" in result

    def test_safe_domain_key_passes(self):
        """The 'domain' key must not be stripped."""
        payload = {"domain": "financial", "entity_count": 5}
        result = _strip(payload)
        assert result["domain"] == "financial"
        assert result["entity_count"] == 5

    def test_safe_last_synced_key_passes(self):
        """ISO-8601 timestamp values at safe keys must pass through unchanged."""
        payload = {"last_synced": "2024-01-15T12:00:00Z"}
        result = _strip(payload)
        assert result["last_synced"] == "2024-01-15T12:00:00Z"

    def test_safe_composite_keys_pass(self):
        """Keys like 'asset_count', 'top_level_scope_path' must not be stripped."""
        payload = {
            "asset_count": 10,
            "top_level_scope_path": "finance.portfolio",
            "has_portfolio": True,
        }
        result = _strip(payload)
        assert result == payload

    def test_empty_payload_returns_empty_dict(self):
        """An empty dict input must produce an empty dict output."""
        assert _strip({}) == {}

    def test_non_dict_scalar_passes_through(self):
        """Scalar values (str, int, bool) must be returned unchanged."""
        assert _strip("plain string") == "plain string"
        assert _strip(42) == 42
        assert _strip(True) is True

    # -- _sanitize_candidate_payload wires in the sanitizer --

    def test_sanitize_candidate_payload_strips_pii_keys(self):
        """_sanitize_candidate_payload must call the PII key stripper on dict payloads."""
        # Build a raw dict payload that contains a PII key.
        pii_payload = {"123-45-6789": "leaked_ssn", "summary": "clean"}
        result = PKMAgentLabService._sanitize_candidate_payload(
            value=pii_payload,
            message="test message",
            intent_frame={},
            merge_decision={},
            target_domain="financial",
        )
        # The PII key must have been stripped by _strip_pii_from_payload_keys.
        assert "123-45-6789" not in result
        assert result.get("summary") == "clean"

    def test_sanitize_candidate_payload_passes_safe_keys(self):
        """_sanitize_candidate_payload must not strip safe PKM keys from a dict payload."""
        safe_payload = {"presence_flags": {"has_finance": True}, "entity_count": 7}
        result = PKMAgentLabService._sanitize_candidate_payload(
            value=safe_payload,
            message="test message",
            intent_frame={},
            merge_decision={},
            target_domain="financial",
        )
        assert result.get("presence_flags") == {"has_finance": True}
        assert result.get("entity_count") == 7
