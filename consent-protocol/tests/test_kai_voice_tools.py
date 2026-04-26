"""
tests/test_kai_voice_tools.py

Unit tests for Kai voice action MCP tool handlers.
Verifies:
  - All handlers return list[TextContent] with valid JSON payload
  - action_id matches the canonical voice action manifest
  - Ticker resolution works for company names and uppercase symbols
  - Invalid/missing inputs return status=error responses
  - completion_mode is set correctly for each action type
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# Import kai_tools directly as a standalone module to avoid the asyncpg /
# DB-stack chain pulled in by mcp_modules/tools/__init__.py.
_spec = importlib.util.spec_from_file_location(
    "kai_tools_standalone",
    Path(__file__).parent.parent / "mcp_modules" / "tools" / "kai_tools.py",
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["kai_tools_standalone"] = _mod
_spec.loader.exec_module(_mod)

handle_kai_analyze_stock          = _mod.handle_kai_analyze_stock
handle_kai_cancel_active_analysis = _mod.handle_kai_cancel_active_analysis
handle_kai_navigate_back          = _mod.handle_kai_navigate_back
handle_kai_open_consent           = _mod.handle_kai_open_consent
handle_kai_open_dashboard         = _mod.handle_kai_open_dashboard
handle_kai_open_history           = _mod.handle_kai_open_history
handle_kai_open_home              = _mod.handle_kai_open_home
handle_kai_open_import            = _mod.handle_kai_open_import
handle_kai_open_optimize          = _mod.handle_kai_open_optimize
handle_kai_open_profile           = _mod.handle_kai_open_profile
handle_kai_resume_active_analysis = _mod.handle_kai_resume_active_analysis



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse(result) -> dict:
    """Parse the first TextContent item as JSON."""
    assert result, "Handler returned empty list"
    text = result[0].text
    return json.loads(text)


# ---------------------------------------------------------------------------
# kai_analyze_stock
# ---------------------------------------------------------------------------

class TestKaiAnalyzeStock:
    @pytest.mark.asyncio
    async def test_valid_ticker_uppercase(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "AAPL"}))
        assert payload["status"] == "success"
        assert payload["action_id"] == "analysis.start"
        assert payload["slots"]["symbol"] == "AAPL"
        assert payload["slots"]["analysis_type"] == "full"
        assert payload["completion_mode"] == "background_start"

    @pytest.mark.asyncio
    async def test_company_name_resolves_to_ticker(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "Apple"}))
        assert payload["status"] == "success"
        assert payload["slots"]["symbol"] == "AAPL"

    @pytest.mark.asyncio
    async def test_nvidia_resolved(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "nvidia"}))
        assert payload["slots"]["symbol"] == "NVDA"

    @pytest.mark.asyncio
    async def test_explicit_analysis_type(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "MSFT", "analysis_type": "fundamental"}))
        assert payload["slots"]["analysis_type"] == "fundamental"

    @pytest.mark.asyncio
    async def test_invalid_analysis_type_defaults_to_full(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "TSLA", "analysis_type": "unknown_type"}))
        assert payload["slots"]["analysis_type"] == "full"

    @pytest.mark.asyncio
    async def test_missing_symbol_returns_error(self):
        payload = _parse(await handle_kai_analyze_stock({}))
        assert payload["status"] == "error"

    @pytest.mark.asyncio
    async def test_gibberish_symbol_returns_error(self):
        payload = _parse(await handle_kai_analyze_stock({"symbol": "NOT_A_TICKER_1234567890"}))
        assert payload["status"] == "error"

    @pytest.mark.asyncio
    async def test_ticker_slot_alias(self):
        """Handler also accepts 'ticker' as input key."""
        payload = _parse(await handle_kai_analyze_stock({"ticker": "AMZN"}))
        assert payload["slots"]["symbol"] == "AMZN"

    @pytest.mark.asyncio
    async def test_target_slot_alias(self):
        """Handler also accepts 'target' as input key."""
        payload = _parse(await handle_kai_analyze_stock({"target": "Tesla"}))
        assert payload["slots"]["symbol"] == "TSLA"


# ---------------------------------------------------------------------------
# Navigation tools — shared schema assertions
# ---------------------------------------------------------------------------

NAV_CASES = [
    (handle_kai_open_dashboard,            "nav.kai_dashboard",    "route_settle"),
    (handle_kai_open_import,               "nav.kai_import",       "route_settle"),
    (handle_kai_open_consent,              "nav.consents",         "route_settle"),
    (handle_kai_open_profile,              "nav.profile",          "route_settle"),
    (handle_kai_open_optimize,             "nav.kai_optimize",     "route_settle"),
    (handle_kai_open_home,                 "nav.kai_home",         "route_settle"),
    (handle_kai_navigate_back,             "nav.back",             "route_settle"),
    (handle_kai_resume_active_analysis,    "analysis.resume_active", "route_settle"),
    (handle_kai_cancel_active_analysis,    "analysis.cancel_active", "none"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("handler,expected_action_id,expected_completion_mode", NAV_CASES)
async def test_nav_tool(handler, expected_action_id, expected_completion_mode):
    payload = _parse(await handler({}))
    assert payload["status"] == "success", f"Expected success, got: {payload}"
    assert payload["action_id"] == expected_action_id
    assert payload["completion_mode"] == expected_completion_mode
    assert "message" in payload
    assert len(payload["message"]) > 0


# ---------------------------------------------------------------------------
# kai_open_history — sub-tab routing
# ---------------------------------------------------------------------------

class TestKaiOpenHistory:
    @pytest.mark.asyncio
    async def test_default_tab(self):
        payload = _parse(await handle_kai_open_history({}))
        assert payload["status"] == "success"
        assert payload["action_id"] == "nav.analysis_history"
        assert payload["slots"]["tab"] == "history"

    @pytest.mark.asyncio
    async def test_debate_tab(self):
        payload = _parse(await handle_kai_open_history({"tab": "debate"}))
        assert payload["slots"]["tab"] == "debate"

    @pytest.mark.asyncio
    async def test_summary_tab(self):
        payload = _parse(await handle_kai_open_history({"tab": "summary"}))
        assert payload["slots"]["tab"] == "summary"

    @pytest.mark.asyncio
    async def test_transcript_tab(self):
        payload = _parse(await handle_kai_open_history({"tab": "transcript"}))
        assert payload["slots"]["tab"] == "transcript"

    @pytest.mark.asyncio
    async def test_invalid_tab_defaults_to_history(self):
        payload = _parse(await handle_kai_open_history({"tab": "nonexistent"}))
        assert payload["slots"]["tab"] == "history"


# ---------------------------------------------------------------------------
# Response schema — all handlers must include action_id and message
# ---------------------------------------------------------------------------

ALL_HANDLERS = [
    (handle_kai_open_dashboard,         {}),
    (handle_kai_open_import,            {}),
    (handle_kai_open_history,           {}),
    (handle_kai_open_consent,           {}),
    (handle_kai_open_profile,           {}),
    (handle_kai_open_optimize,          {}),
    (handle_kai_open_home,              {}),
    (handle_kai_navigate_back,          {}),
    (handle_kai_resume_active_analysis, {}),
    (handle_kai_cancel_active_analysis, {}),
    (handle_kai_analyze_stock,          {"symbol": "GOOGL"}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("handler,args", ALL_HANDLERS)
async def test_all_handlers_return_valid_schema(handler, args):
    result = await handler(args)
    assert isinstance(result, list)
    assert len(result) == 1
    payload = _parse(result)
    assert "status" in payload
    assert "action_id" in payload
    assert "message" in payload
    assert "completion_mode" in payload
