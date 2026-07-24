"""Backend proof for SummaryReducerAgent three-layer PII defense.

Canonical attach point:
    hushh_mcp.agents.summary_reducer.reducer.SummaryReducerAgent
    -> used by PKMAgentLabService domain summary pipeline
    -> reachable via POST /api/pkm/agent-lab/structure

These tests prove:
- SummaryReducerAgent is importable and callable from the backend package path.
- Layer 1 (pre_process): sensitive PII key values are replaced with the REDACTED sentinel.
- Layer 2 (validate_output): only SummaryProjection schema fields survive; unknown keys dropped.
- Layer 3 (post_process): keys whose names match PII patterns are dropped from the output.
- The full reduce() path (all three layers) produces a schema-valid, PII-safe projection.
- Safe PKM keys pass through without modification.
"""

from __future__ import annotations


class TestSummaryReducerAgentBackendProof:
    """Backend proof: SummaryReducerAgent is importable, callable, and enforces PII defense."""

    # -- Import smoke --

    def test_agent_is_importable(self):
        """SummaryReducerAgent must be importable from the canonical package path."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent  # noqa: F401

    def test_agent_exposes_required_methods(self):
        """SummaryReducerAgent must expose pre_process, validate_output, post_process, reduce."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        for method in ("pre_process", "validate_output", "post_process", "reduce"):
            assert callable(getattr(SummaryReducerAgent, method, None)), (
                f"SummaryReducerAgent.{method} must be callable"
            )

    # -- Layer 1: pre_process (PII value blindfold) --

    def test_layer1_redacts_ssn_key_value(self):
        """pre_process must replace values at 'ssn' key with the REDACTED sentinel."""
        from hushh_mcp.agents.summary_reducer.reducer import _REDACTED, SummaryReducerAgent

        data = {"ssn": "123-45-6789", "name": "Jane"}
        result = SummaryReducerAgent.pre_process(data)
        assert result["ssn"] == _REDACTED
        assert result["name"] == "Jane"

    def test_layer1_redacts_account_number(self):
        """pre_process must replace values at 'account_number' with the REDACTED sentinel."""
        from hushh_mcp.agents.summary_reducer.reducer import _REDACTED, SummaryReducerAgent

        data = {"account_number": "9876543210"}
        result = SummaryReducerAgent.pre_process(data)
        assert result["account_number"] == _REDACTED

    def test_layer1_redacts_balance(self):
        """pre_process must replace values at 'balance' key."""
        from hushh_mcp.agents.summary_reducer.reducer import _REDACTED, SummaryReducerAgent

        data = {"balance": 50000.00}
        result = SummaryReducerAgent.pre_process(data)
        assert result["balance"] == _REDACTED

    def test_layer1_redacts_nested_sensitive_keys(self):
        """pre_process must recurse into nested dicts and redact sensitive keys."""
        from hushh_mcp.agents.summary_reducer.reducer import _REDACTED, SummaryReducerAgent

        data = {"financial": {"balance": 100, "currency": "USD"}}
        result = SummaryReducerAgent.pre_process(data)
        assert result["financial"]["balance"] == _REDACTED
        assert result["financial"]["currency"] == "USD"

    def test_layer1_redacts_in_list_items(self):
        """pre_process must recurse into list items."""
        from hushh_mcp.agents.summary_reducer.reducer import _REDACTED, SummaryReducerAgent

        data = {"records": [{"ssn": "111-22-3333"}, {"ssn": "444-55-6666"}]}
        result = SummaryReducerAgent.pre_process(data)
        for item in result["records"]:
            assert item["ssn"] == _REDACTED

    def test_layer1_passes_safe_keys_unchanged(self):
        """pre_process must not modify values at safe (non-sensitive) keys."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        data = {"last_synced": "2024-01-15T12:00:00Z", "domain_count": 3}
        result = SummaryReducerAgent.pre_process(data)
        assert result["last_synced"] == "2024-01-15T12:00:00Z"
        assert result["domain_count"] == 3

    # -- Layer 2: validate_output (Pydantic schema enforcement) --

    def test_layer2_accepts_valid_projection(self):
        """validate_output must accept dicts conforming to the SummaryProjection schema."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        raw = {
            "presence_flags": {"has_portfolio": True},
            "counts": {"asset_count": 5},
            "freshness_markers": {"last_updated": "2024-01-15"},
            "sanctioned_capability_flags": {"can_trade": False},
        }
        result = SummaryReducerAgent.validate_output(raw)
        assert result["presence_flags"] == {"has_portfolio": True}
        assert result["counts"] == {"asset_count": 5}

    def test_layer2_drops_unknown_fields(self):
        """validate_output must drop keys outside the four permitted schema fields."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        raw = {
            "presence_flags": {},
            "counts": {},
            "freshness_markers": {},
            "sanctioned_capability_flags": {},
            "raw_pii_dump": "should be dropped",
            "secret_field": "sensitive",
        }
        result = SummaryReducerAgent.validate_output(raw)
        assert "raw_pii_dump" not in result
        assert "secret_field" not in result

    def test_layer2_returns_empty_projection_on_invalid_input(self):
        """validate_output must return empty SummaryProjection on non-dict input (fail-safe)."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        result = SummaryReducerAgent.validate_output("not a dict")
        assert isinstance(result, dict)
        assert "presence_flags" in result
        assert result["presence_flags"] == {}

    # -- Layer 3: post_process (PII-in-key scrubber) --

    def test_layer3_drops_key_with_ssn_pattern(self):
        """post_process must drop keys whose names match the SSN pattern."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        summary = {"123-45-6789": True, "safe_flag": True}
        result = SummaryReducerAgent.post_process(summary)
        assert "123-45-6789" not in result
        assert "safe_flag" in result

    def test_layer3_drops_key_with_dollar_amount(self):
        """post_process must drop keys whose names embed a dollar amount."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        summary = {"$50000": True, "count": 3}
        result = SummaryReducerAgent.post_process(summary)
        assert "$50000" not in result
        assert "count" in result

    def test_layer3_drops_key_with_long_digit_sequence(self):
        """post_process must drop keys that contain 5+ consecutive digits."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        summary = {"account_12345678": True, "domain_count": 2}
        result = SummaryReducerAgent.post_process(summary)
        assert "account_12345678" not in result
        assert "domain_count" in result

    def test_layer3_passes_safe_keys(self):
        """post_process must not remove keys that do not contain PII patterns."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        summary = {"has_portfolio": True, "asset_count": 5, "last_sync": "2024-01-01"}
        result = SummaryReducerAgent.post_process(summary)
        assert result == summary

    # -- Full reduce() path --

    def test_reduce_returns_schema_valid_projection(self):
        """reduce() must return a dict with exactly the four SummaryProjection fields."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        raw = {
            "last_synced": "2024-01-15T12:00:00Z",
            "balance": 99999,
            "ssn": "999-99-9999",
            "portfolio": {"entities": {"AAPL": 10, "GOOG": 5}},
            "tags": ["tech", "growth"],
        }
        result = SummaryReducerAgent.reduce("financial", raw)
        for field in ("presence_flags", "counts", "freshness_markers", "sanctioned_capability_flags"):
            assert field in result, f"Expected field '{field}' in reduce() output"

    def test_reduce_strips_pii_keys_from_output(self):
        """reduce() must not include PII key patterns in the final projection."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        raw = {"ssn": "123-45-6789", "balance": 500000}
        result = SummaryReducerAgent.reduce("financial", raw)
        # Flatten all keys in output for inspection.
        all_keys: list[str] = []
        for section_val in result.values():
            if isinstance(section_val, dict):
                all_keys.extend(section_val.keys())
        # Neither the raw sensitive keys nor their values should leak.
        assert "ssn" not in all_keys
        assert "balance" not in all_keys

    def test_reduce_safe_keys_produce_presence_or_count_flags(self):
        """Safe dict-valued keys must produce presence_flags entries in the projection."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        raw = {"health": {"entities": {"steps": 8000}}}
        result = SummaryReducerAgent.reduce("health", raw)
        assert "health" in result.get("presence_flags", {}), (
            "A safe dict-valued key should produce a presence_flag entry"
        )

    def test_reduce_is_callable_without_llm(self):
        """reduce() must complete synchronously without any network or LLM dependency."""
        from hushh_mcp.agents.summary_reducer.reducer import SummaryReducerAgent

        # Must not raise; no mocking required.
        result = SummaryReducerAgent.reduce("test_domain", {"items": ["a", "b", "c"]})
        assert isinstance(result, dict)

    # -- Canonical backend caller path --

    def test_canonical_package_init_exposes_agent(self):
        """hushh_mcp.agents.summary_reducer must re-export SummaryReducerAgent."""
        from hushh_mcp.agents.summary_reducer import SummaryReducerAgent  # noqa: F401

        assert SummaryReducerAgent is not None
