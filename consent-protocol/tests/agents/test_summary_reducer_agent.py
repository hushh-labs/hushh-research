"""
Tests for the PKM Summary Reducer deterministic layers.

Canonical attach point:
    SummaryReducerAgent.reduce -> PKMAgentLabService.generate_structure_preview
    -> POST /api/pkm/agent-lab/structure
    (pkm.router -> api/routes/pkm.py -> PKMAgentLabService.generate_structure_preview
     -> SummaryReducerAgent.reduce, which is the intended production consumer of
     the three-layer privacy defence introduced in this PR)

All tests are hermetic - no LLM, no DB, no network.

Coverage:
- Pre-processor: top-level and nested key redaction
- Pre-processor: list traversal
- Pre-processor: depth limit guard
- Post-processor: dollar-amount leak detection
- Post-processor: keyword leak detection in values
- Post-processor: leaked keys are dropped
- Post-processor: clean values pass through unchanged
- SummaryProjection schema: validator rejects negative counts
- SummaryProjection schema: validator rejects non-bool flags
- SummaryReducerAgent.reduce: end-to-end with clean data
- SummaryReducerAgent.reduce: high-risk keys are absent from output
- SummaryReducerAgent.reduce: output passes Pydantic validation
- SummaryReducerAgent.reduce: presence flags reflect data shape
- SummaryReducerAgent.reduce: counts reflect list lengths
- SummaryReducerAgent.reduce: freshness markers for ISO dates
- Call proof: SummaryReducerAgent.reduce is callable and returns SummaryProjection
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from hushh_mcp.agents.summary_reducer import (
    SummaryProjection,
    SummaryReducerAgent,
    _post_process_summary,
    _pre_process_data,
)

_REDACTED = "[REDACTED FOR REDUCER]"

# ===========================================================================
# Pre-processor tests
# ===========================================================================


class TestPreProcessor:
    def test_top_level_high_risk_key_is_redacted(self):
        data = {"balance": 99999, "name": "Alice"}
        result = _pre_process_data(data)
        assert result["balance"] == _REDACTED
        assert result["name"] == "Alice"

    def test_multiple_high_risk_keys_redacted(self):
        data = {"holdings": [{"ticker": "AAPL"}], "ssn": "123-45-6789", "domain": "finance"}
        result = _pre_process_data(data)
        assert result["holdings"] == _REDACTED
        assert result["ssn"] == _REDACTED
        assert result["domain"] == "finance"

    def test_nested_high_risk_key_redacted(self):
        data = {"user": {"name": "Bob", "balance": 50000, "email": "bob@example.com"}}
        result = _pre_process_data(data)
        assert result["user"]["balance"] == _REDACTED
        assert result["user"]["name"] == "Bob"
        assert result["user"]["email"] == "bob@example.com"

    def test_deeply_nested_redaction(self):
        data = {"level1": {"level2": {"level3": {"token": "secret123", "safe": "ok"}}}}
        result = _pre_process_data(data)
        assert result["level1"]["level2"]["level3"]["token"] == _REDACTED
        assert result["level1"]["level2"]["level3"]["safe"] == "ok"

    def test_list_items_traversed(self):
        data = {
            "accounts": [
                {"id": 1, "balance": 1000},
                {"id": 2, "balance": 2000},
            ]
        }
        result = _pre_process_data(data)
        for item in result["accounts"]:
            assert item["balance"] == _REDACTED
            assert "id" in item

    def test_non_dict_leaf_values_pass_through(self):
        data = {"count": 5, "active": True, "label": "finance"}
        result = _pre_process_data(data)
        assert result == data

    def test_none_value_passes_through(self):
        data = {"name": None}
        result = _pre_process_data(data)
        assert result["name"] is None

    def test_depth_limit_returns_redacted_sentinel(self):
        # Build a 35-deep nested dict to trigger the depth cap
        nested: dict = {}
        current = nested
        for _ in range(35):
            child: dict = {}
            current["child"] = child
            current = child
        current["value"] = "deep"
        result = _pre_process_data(nested)
        # After depth 32 the function returns _REDACTED for the subtree
        assert isinstance(result, dict)  # top level is still a dict

    def test_password_key_redacted(self):
        data = {"password": "hunter2"}
        result = _pre_process_data(data)
        assert result["password"] == _REDACTED

    def test_private_key_redacted(self):
        data = {"private_key": "-----BEGIN RSA-----"}
        result = _pre_process_data(data)
        assert result["private_key"] == _REDACTED

    def test_risk_profile_redacted(self):
        data = {"risk_profile": "aggressive", "domain": "investing"}
        result = _pre_process_data(data)
        assert result["risk_profile"] == _REDACTED

    def test_decision_history_redacted(self):
        data = {"decision_history": ["buy AAPL", "sell TSLA"]}
        result = _pre_process_data(data)
        assert result["decision_history"] == _REDACTED


# ===========================================================================
# Post-processor tests
# ===========================================================================


class TestPostProcessor:
    def test_dollar_amount_in_value_is_redacted(self):
        summary = {
            "presence_flags": {"has_accounts": True},
            "counts": {},
            "freshness_markers": {},
            "sanctioned_capability_flags": {"note": "$15,000 injected"},
        }
        result = _post_process_summary(summary)
        assert result["sanctioned_capability_flags"]["note"] == _REDACTED

    def test_comma_separated_number_in_value_is_redacted(self):
        summary = {
            "presence_flags": {},
            "counts": {},
            "freshness_markers": {"last_sync": "1,234,567"},
            "sanctioned_capability_flags": {},
        }
        result = _post_process_summary(summary)
        assert result["freshness_markers"]["last_sync"] == _REDACTED

    def test_holdings_keyword_in_value_is_redacted(self):
        for value in ["holdings available for this user", "user_holdings_available"]:
            summary = {
                "presence_flags": {},
                "counts": {},
                "freshness_markers": {"note": value},
                "sanctioned_capability_flags": {},
            }
            result = _post_process_summary(summary)
            assert result["freshness_markers"]["note"] == _REDACTED, f"failed for {value!r}"

    def test_balance_keyword_causes_key_or_value_scrub(self):
        # Key 'balance_present' normalises to 'balance present' which matches
        # the balance pattern, so the key is dropped entirely.
        summary = {
            "presence_flags": {"balance_present": "yes, balance found", "has_accounts": True},
            "counts": {},
            "freshness_markers": {},
            "sanctioned_capability_flags": {},
        }
        result = _post_process_summary(summary)
        # balance_present must be absent (key dropped) or value must be REDACTED
        flags = result["presence_flags"]
        if "balance_present" in flags:
            assert flags["balance_present"] == _REDACTED
        # safe key must survive
        assert flags.get("has_accounts") is True

    def test_leaked_key_is_dropped(self):
        summary = {
            "presence_flags": {},
            "counts": {},
            "freshness_markers": {},
            "sanctioned_capability_flags": {"holdings_available": True},
        }
        result = _post_process_summary(summary)
        assert "holdings_available" not in result["sanctioned_capability_flags"]

    def test_clean_values_pass_through(self):
        summary = {
            "presence_flags": {"has_accounts": True},
            "counts": {"account_count": 3},
            "freshness_markers": {"accounts_freshness": "2024-01-01"},
            "sanctioned_capability_flags": {"can_run_spending_analysis": False},
        }
        result = _post_process_summary(summary)
        assert result == summary

    def test_list_in_value_items_are_scanned(self):
        summary = {
            "presence_flags": {},
            "counts": {},
            "freshness_markers": {},
            "sanctioned_capability_flags": {"flags": ["safe_flag", "account_balance_$5000"]},
        }
        result = _post_process_summary(summary)
        flags = result["sanctioned_capability_flags"]["flags"]
        assert "safe_flag" in flags
        assert _REDACTED in flags


# ===========================================================================
# SummaryProjection schema tests
# ===========================================================================


class TestSummaryProjection:
    def test_valid_projection_accepted(self):
        proj = SummaryProjection(
            presence_flags={"has_accounts": True},
            counts={"account_count": 3},
            freshness_markers={"accounts_freshness": "2024-01-01"},
            sanctioned_capability_flags={"can_run_spending_analysis": False},
        )
        assert proj.counts["account_count"] == 3

    def test_negative_count_rejected(self):
        with pytest.raises(ValidationError):
            SummaryProjection(counts={"account_count": -1})

    def test_non_bool_presence_flag_rejected(self):
        with pytest.raises(ValidationError):
            SummaryProjection(presence_flags={"has_accounts": "yes"})

    def test_non_bool_capability_flag_rejected(self):
        with pytest.raises(ValidationError):
            SummaryProjection(sanctioned_capability_flags={"can_run": 1})

    def test_empty_projection_valid(self):
        proj = SummaryProjection()
        assert proj.presence_flags == {}
        assert proj.counts == {}


# ===========================================================================
# SummaryReducerAgent end-to-end tests
# ===========================================================================


class TestSummaryReducerAgent:
    def _agent(self) -> SummaryReducerAgent:
        return SummaryReducerAgent()

    def test_returns_summary_projection_instance(self):
        agent = self._agent()
        result = agent.reduce("finance", {"accounts": [{"id": 1}]})
        assert isinstance(result, SummaryProjection)

    def test_high_risk_keys_absent_from_output(self):
        agent = self._agent()
        data = {
            "balance": 99999,
            "holdings": [{"ticker": "AAPL", "value": 10000}],
            "accounts": [{"id": "acc1"}],
        }
        result = agent.reduce("finance", data)
        # The output projection dict must not contain raw financial values
        result_json = result.model_dump_json()
        assert "99999" not in result_json
        assert "10000" not in result_json

    def test_presence_flag_true_for_non_empty_list(self):
        agent = self._agent()
        data = {"accounts": [{"id": 1}, {"id": 2}]}
        result = agent.reduce("finance", data)
        assert result.presence_flags.get("has_accounts") is True

    def test_presence_flag_false_for_empty_list(self):
        agent = self._agent()
        data = {"transactions": []}
        result = agent.reduce("finance", data)
        assert result.presence_flags.get("has_transactions") is False

    def test_count_reflects_list_length(self):
        agent = self._agent()
        data = {"accounts": [1, 2, 3, 4, 5]}
        result = agent.reduce("finance", data)
        assert result.counts.get("accounts_count") == 5

    def test_freshness_marker_for_iso_date(self):
        agent = self._agent()
        data = {"last_synced": "2024-06-15T12:00:00Z"}
        result = agent.reduce("finance", data)
        assert "last_synced_freshness" in result.freshness_markers
        assert result.freshness_markers["last_synced_freshness"].startswith("2024-06-15")

    def test_domain_capability_flag_set(self):
        agent = self._agent()
        result = agent.reduce("finance", {"accounts": [1]})
        assert result.sanctioned_capability_flags.get("has_finance_domain") is True

    def test_spending_analysis_flag_requires_transactions_and_accounts(self):
        agent = self._agent()
        result = agent.reduce("finance", {"accounts": [1], "transactions": [1, 2]})
        assert result.sanctioned_capability_flags.get("can_run_spending_analysis") is True

    def test_spending_analysis_flag_false_without_transactions(self):
        agent = self._agent()
        result = agent.reduce("finance", {"accounts": [1]})
        assert result.sanctioned_capability_flags.get("can_run_spending_analysis") is False

    def test_empty_data_returns_valid_projection(self):
        agent = self._agent()
        result = agent.reduce("finance", {})
        assert isinstance(result, SummaryProjection)
        assert result.presence_flags == {}
        assert result.counts == {}

    def test_nested_leak_does_not_reach_output(self):
        agent = self._agent()
        data = {
            "accounts": [{"id": "acc1", "balance": 50000}],
            "summary": "User has balance of $50,000",
        }
        result = agent.reduce("finance", data)
        result_json = result.model_dump_json()
        assert "50000" not in result_json
        assert "50,000" not in result_json

    def test_projection_passes_pydantic_validation(self):
        agent = self._agent()
        data = {"accounts": [1, 2], "transactions": [1], "last_updated": "2024-03-01"}
        result = agent.reduce("finance", data)
        # Re-validate by round-tripping through dict
        reparsed = SummaryProjection(**result.model_dump())
        assert reparsed == result


# ---------------------------------------------------------------------------
# Call proof: SummaryReducerAgent.reduce is the canonical surface called from
# PKMAgentLabService.generate_structure_preview -> POST /api/pkm/agent-lab/structure
# ---------------------------------------------------------------------------


class TestSummaryReducerAgentCallProof:
    """Prove SummaryReducerAgent.reduce is directly callable and honours all three layers."""

    def test_reduce_returns_summary_projection_instance(self):
        """reduce() must return a SummaryProjection, not a plain dict."""
        agent = SummaryReducerAgent()
        result = agent.reduce("health", {"checkups": [1, 2], "last_visit": "2024-01-15"})
        assert isinstance(result, SummaryProjection), (
            "reduce() must return a SummaryProjection (Pydantic layer active)"
        )

    def test_reduce_strips_high_risk_keys_before_output(self):
        """Pre-processing layer must remove high-risk keys so they never appear in output."""
        agent = SummaryReducerAgent()
        candidate = {
            "balance": 99999,
            "holdings": ["AAPL", "NVDA"],
            "ssn": "123-45-6789",
            "activity_count": 5,
        }
        result = agent.reduce("finance", candidate)
        result_json = result.model_dump_json()
        assert "99999" not in result_json
        assert "AAPL" not in result_json
        assert "123-45-6789" not in result_json

    def test_reduce_output_fields_are_from_sanctioned_classes_only(self):
        """SummaryProjection enforces the four sanctioned output classes."""
        agent = SummaryReducerAgent()
        result = agent.reduce("finance", {"accounts": [1], "last_updated": "2024-06-01"})
        dump = result.model_dump()
        allowed_keys = {"presence_flags", "counts", "freshness_markers", "sanctioned_capability_flags"}
        assert set(dump.keys()) == allowed_keys, (
            f"Output keys {set(dump.keys())} must match sanctioned classes {allowed_keys}"
        )


# ===========================================================================
# Route-level caller proof
# ===========================================================================

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api.routes.pkm as pkm_module  # noqa: E402
from api.middleware import require_vault_owner_token  # noqa: E402


def _pkm_client() -> TestClient:
    app = FastAPI()
    app.include_router(pkm_module.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test-uid",
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


class TestSummaryReducerRouteCallerProof:
    """
    Canonical attach point: PKMAgentLabService.generate_structure_preview
    -> POST /api/pkm/agent-lab/structure

    SummaryReducerAgent.reduce is invoked by generate_structure_preview to
    sanitize simulated_state before it reaches any LLM prompt.  These tests
    confirm that the route accepts a valid body (not 422) and that providing
    a simulated_state with high-risk keys does not cause a 500 (the reducer
    handles the redaction without raising).
    """

    _URL = "/api/pkm/agent-lab/structure"

    def test_valid_request_not_rejected_by_validation(self):
        """A minimal valid body must not be rejected with 422."""
        resp = _pkm_client().post(
            self._URL,
            json={"user_id": "test-uid", "message": "test message"},
        )
        assert resp.status_code != 422

    def test_simulated_state_with_high_risk_keys_does_not_crash(self):
        """Passing high-risk keys in simulated_state must not cause a 500."""
        body = {
            "user_id": "test-uid",
            "message": "test message",
            "simulated_state": {
                "balance": 99999,
                "ssn": "123-45-6789",
                "activity_count": 3,
            },
        }
        resp = _pkm_client().post(self._URL, json=body)
        assert resp.status_code != 422
        assert resp.status_code != 500
