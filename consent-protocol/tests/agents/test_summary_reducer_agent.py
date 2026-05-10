"""Tests for SummaryReducerAgent — three-layer PII defense."""

from hushh_mcp.agents.summary_reducer.reducer import (
    _REDACTED,
    SummaryProjection,
    SummaryReducerAgent,
)

# ---------------------------------------------------------------------------
# Layer 1: pre_process (The Blindfold)
# ---------------------------------------------------------------------------


def test_pre_process_redacts_balance_value():
    data = {"balance": 50000, "domain": "financial"}
    result = SummaryReducerAgent.pre_process(data)
    assert result["balance"] == _REDACTED
    assert result["domain"] == "financial"


def test_pre_process_redacts_holdings():
    data = {"holdings": [{"ticker": "AAPL", "shares": 100}], "risk_profile": "moderate"}
    result = SummaryReducerAgent.pre_process(data)
    assert result["holdings"] == _REDACTED
    assert result["risk_profile"] == _REDACTED


def test_pre_process_redacts_ssn():
    data = {"ssn": "123-45-6789", "name": "John"}
    result = SummaryReducerAgent.pre_process(data)
    assert result["ssn"] == _REDACTED
    assert result["name"] == "John"


def test_pre_process_redacts_token_and_secret():
    data = {"token": "abc123", "secret": "s3cr3t", "label": "safe"}
    result = SummaryReducerAgent.pre_process(data)
    assert result["token"] == _REDACTED
    assert result["secret"] == _REDACTED
    assert result["label"] == "safe"


def test_pre_process_is_case_insensitive_on_key():
    data = {"Balance": 9999, "HOLDINGS": [], "safe_key": True}
    result = SummaryReducerAgent.pre_process(data)
    assert result["Balance"] == _REDACTED
    assert result["HOLDINGS"] == _REDACTED
    assert result["safe_key"] is True


def test_pre_process_recurses_into_nested_dicts():
    data = {
        "profile": {
            "balance": 75000,
            "name": "Alice",
            "nested": {"password": "secret123", "city": "NY"},
        }
    }
    result = SummaryReducerAgent.pre_process(data)
    assert result["profile"]["balance"] == _REDACTED
    assert result["profile"]["name"] == "Alice"
    assert result["profile"]["nested"]["password"] == _REDACTED
    assert result["profile"]["nested"]["city"] == "NY"


def test_pre_process_recurses_into_lists():
    data = {
        "items": [
            {"balance": 100, "label": "a"},
            {"balance": 200, "label": "b"},
        ]
    }
    result = SummaryReducerAgent.pre_process(data)
    assert result["items"][0]["balance"] == _REDACTED
    assert result["items"][0]["label"] == "a"
    assert result["items"][1]["balance"] == _REDACTED
    assert result["items"][1]["label"] == "b"


def test_pre_process_preserves_safe_scalar_values():
    data = {"has_portfolio": True, "entity_count": 3, "domain": "financial"}
    result = SummaryReducerAgent.pre_process(data)
    assert result == data


def test_pre_process_does_not_modify_non_dict_input():
    assert SummaryReducerAgent.pre_process("string") == "string"
    assert SummaryReducerAgent.pre_process(42) == 42
    assert SummaryReducerAgent.pre_process(None) is None


# ---------------------------------------------------------------------------
# Layer 2: validate_output (Structural Validation)
# ---------------------------------------------------------------------------


def test_validate_output_accepts_valid_projection():
    raw = {
        "presence_flags": {"has_portfolio": True},
        "counts": {"entity_count": 5},
        "freshness_markers": {"last_updated": "2026-05-10T00:00:00Z"},
        "sanctioned_capability_flags": {"can_view_summary": True},
    }
    result = SummaryReducerAgent.validate_output(raw)
    assert result["presence_flags"] == {"has_portfolio": True}
    assert result["counts"] == {"entity_count": 5}
    assert result["freshness_markers"] == {"last_updated": "2026-05-10T00:00:00Z"}
    assert result["sanctioned_capability_flags"] == {"can_view_summary": True}


def test_validate_output_strips_extra_fields():
    raw = {
        "presence_flags": {"has_data": True},
        "counts": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
        "raw_portfolio_value": 999999,
        "secret_field": "leaked_data",
    }
    result = SummaryReducerAgent.validate_output(raw)
    assert "raw_portfolio_value" not in result
    assert "secret_field" not in result
    assert result["presence_flags"] == {"has_data": True}


def test_validate_output_returns_empty_projection_on_invalid_input():
    result = SummaryReducerAgent.validate_output("not a dict")
    assert result == SummaryProjection().model_dump()


def test_validate_output_returns_empty_projection_on_none():
    result = SummaryReducerAgent.validate_output(None)
    assert result["presence_flags"] == {}
    assert result["counts"] == {}


def test_validate_output_fills_missing_fields_with_defaults():
    raw = {"presence_flags": {"has_events": True}}
    result = SummaryReducerAgent.validate_output(raw)
    assert result["presence_flags"] == {"has_events": True}
    assert result["counts"] == {}
    assert result["freshness_markers"] == {}
    assert result["sanctioned_capability_flags"] == {}


# ---------------------------------------------------------------------------
# Layer 3: post_process (The Guardrails)
# ---------------------------------------------------------------------------


def test_post_process_removes_dollar_amount_keys():
    summary = {
        "presence_flags": {"account_$50000": True, "has_portfolio": True},
        "counts": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "account_$50000" not in result["presence_flags"]
    assert result["presence_flags"].get("has_portfolio") is True


def test_post_process_removes_ssn_pattern_keys():
    summary = {
        "presence_flags": {"ssn_123-45-6789": True, "has_identity": True},
        "counts": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "ssn_123-45-6789" not in result["presence_flags"]
    assert result["presence_flags"].get("has_identity") is True


def test_post_process_removes_large_numeric_keys():
    summary = {
        "presence_flags": {},
        "counts": {"100000_transactions": 5, "entity_count": 3},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "100000_transactions" not in result["counts"]
    assert result["counts"].get("entity_count") == 3


def test_post_process_removes_email_keys():
    summary = {
        "presence_flags": {"user@example.com_verified": True, "has_kyc": True},
        "counts": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "user@example.com_verified" not in result["presence_flags"]
    assert result["presence_flags"].get("has_kyc") is True


def test_post_process_removes_currency_suffixed_keys():
    summary = {
        "counts": {"100_dollars_transactions": 3, "event_count": 7},
        "presence_flags": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "100_dollars_transactions" not in result["counts"]
    assert result["counts"].get("event_count") == 7


def test_post_process_does_not_modify_values():
    summary = {
        "presence_flags": {"has_balance": True},
        "counts": {"entity_count": 5},
        "freshness_markers": {"updated": "2026-05-10T00:00:00Z"},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert result == summary


def test_post_process_handles_nested_structures():
    summary = {
        "presence_flags": {
            "has_data": True,
            "inner": {"account_$9999": True, "safe_flag": False},
        },
        "counts": {},
        "freshness_markers": {},
        "sanctioned_capability_flags": {},
    }
    result = SummaryReducerAgent.post_process(summary)
    assert "account_$9999" not in result["presence_flags"]["inner"]
    assert result["presence_flags"]["inner"].get("safe_flag") is False


# ---------------------------------------------------------------------------
# Full pipeline: reduce()
# ---------------------------------------------------------------------------


def test_reduce_financial_domain_redacts_balance_and_holdings():
    data = {
        "events": {"entities": {"e1": {"kind": "trade"}, "e2": {"kind": "dividend"}}},
        "balance": 75000,
        "holdings": [{"ticker": "MSFT", "shares": 50}],
        "risk_profile": "moderate",
    }
    result = SummaryReducerAgent.reduce("financial", data)
    serialized = str(result)
    assert "75000" not in serialized
    assert "MSFT" not in serialized
    assert "moderate" not in serialized
    assert "presence_flags" in result
    assert "counts" in result


def test_reduce_produces_valid_summary_projection_schema():
    data = {"preferences": {"entities": {"e1": {}}}, "name": "Alice"}
    result = SummaryReducerAgent.reduce("health", data)
    assert set(result.keys()) == {
        "presence_flags",
        "counts",
        "freshness_markers",
        "sanctioned_capability_flags",
    }


def test_reduce_counts_entities_correctly():
    data = {
        "events": {"entities": {"a": {}, "b": {}, "c": {}}},
        "tags": ["alpha", "beta"],
    }
    result = SummaryReducerAgent.reduce("financial", data)
    assert result["counts"].get("events_entity_count") == 3
    assert result["counts"].get("tags_count") == 2


def test_reduce_presence_flag_for_non_empty_dict():
    data = {"portfolio": {"holdings": []}, "goals": {}}
    result = SummaryReducerAgent.reduce("financial", data)
    assert result["presence_flags"].get("portfolio") is True
    assert result["presence_flags"].get("goals") is False


def test_reduce_post_processes_presence_flags_with_pii():
    class _PatchedReducer(SummaryReducerAgent):
        @classmethod
        def validate_output(cls, raw):
            return {
                "presence_flags": {"account_$50000": True, "has_portfolio": True},
                "counts": {},
                "freshness_markers": {},
                "sanctioned_capability_flags": {},
            }

    result = _PatchedReducer.reduce("financial", {})
    assert "account_$50000" not in result["presence_flags"]
    assert result["presence_flags"].get("has_portfolio") is True


def test_reduce_empty_input_returns_empty_projection():
    result = SummaryReducerAgent.reduce("travel", {})
    assert result == SummaryProjection().model_dump()


def test_reduce_does_not_expose_redacted_sentinel_in_output():
    data = {"balance": 99999, "holdings": [1, 2, 3], "secret": "xyz"}
    result = SummaryReducerAgent.reduce("financial", data)
    assert "[REDACTED FOR REDUCER]" not in str(result)
