import pytest

from hushh_mcp.agents.summary_reducer.agent import SummaryProjection, summary_reducer_agent


@pytest.mark.asyncio
async def test_summary_reducer_pre_processing_blindfold():
    """Verify that specific keys like 'balance', 'holdings', and 'token' are scrubbed before reaching the LLM."""
    raw_data = {
        "user_activity": "Logged in",
        "account_info": {
            "balance": 15000.50,
            "holdings": ["AAPL", "GOOG"],
            "preferences": {"theme": "dark"},
        },
        "api_token": "secret-12345",
    }
    
    scrubbed_data = summary_reducer_agent._pre_process_data(raw_data)
    
    # Non-sensitive data remains
    assert scrubbed_data["user_activity"] == "Logged in"
    assert scrubbed_data["account_info"]["preferences"]["theme"] == "dark"
    
    # Sensitive data is wiped
    assert scrubbed_data["account_info"]["balance"] == "[REDACTED FOR REDUCER]"
    assert scrubbed_data["account_info"]["holdings"] == "[REDACTED FOR REDUCER]"
    assert scrubbed_data["api_token"] == "[REDACTED FOR REDUCER]"  # noqa: S105


@pytest.mark.asyncio
async def test_summary_reducer_post_processing_guardrails():
    """Verify that if the LLM hallucinates and includes leaked data in keys or capabilities, it is stripped."""
    # Simulate a bad LLM output that snuck numerical keys and financial info into strings
    bad_projection = SummaryProjection(
        presence_flags={
            "has_basic_info": True,
            "has_holdings": True, # Should catch "holdings"
            "account_$50000": True, # Should catch the dollar amount
        },
        counts={
            "total_logins": 5,
            "holdings_count": 10, # Should catch "holdings"
            "100_dollars": 5, # Should catch digits matching pattern
        },
        freshness_markers={
            "last_login": "2026-04-18T00:00:00Z"
        },
        sanctioned_capability_flags=[
            "can_trade",
            "view_$1000", # Dollar leak
            "manage_balance" # "balance" string
        ]
    )
    
    safe_projection = summary_reducer_agent._post_process_summary(bad_projection)
    
    # Capabilities checks
    assert "can_trade" in safe_projection.sanctioned_capability_flags
    assert "view_$1000" not in safe_projection.sanctioned_capability_flags
    assert "manage_balance" not in safe_projection.sanctioned_capability_flags
    
    # Presence Flags Checks
    assert "has_basic_info" in safe_projection.presence_flags
    assert "has_holdings" not in safe_projection.presence_flags
    assert "account_$50000" not in safe_projection.presence_flags
    
    # Counts Checks
    assert "total_logins" in safe_projection.counts
    assert "holdings_count" not in safe_projection.counts
    assert "100_dollars" not in safe_projection.counts


@pytest.mark.asyncio
async def test_summary_reducer_integration(monkeypatch):
    """
    Test the full summarize pipeline. We mock the base .run() to simulate 
    an LLM response, verifying that it correctly parses into the projection.
    """
    def mock_run(*args, **kwargs):
        class MockResponse:
            text = '''```json
            {
              "presence_flags": {"has_activity": true},
              "counts": {"activity_entries": 42},
              "freshness_markers": {"latest_entry": "2026-04-18T00:00:00Z"},
              "sanctioned_capability_flags": ["view_history"]
            }
            ```'''
        return MockResponse()

    monkeypatch.setattr(summary_reducer_agent, "run", mock_run)
    
    result = await summary_reducer_agent.summarize(
        domain="activity",
        candidate_data={"entries": [1, 2, 3]},
        user_id="test_user",
        consent_token="test_token"  # noqa: S106
    )
    
    assert result.presence_flags["has_activity"] is True
    assert result.counts["activity_entries"] == 42
    assert "latest_entry" in result.freshness_markers
    assert "view_history" in result.sanctioned_capability_flags
