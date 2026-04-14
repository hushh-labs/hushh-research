# tests/services/test_voice_intent_service_logic.py
"""
Voice Intent Service Logic Tests
=================================

Tests for pure helper functions in the voice intent service that handle
command normalization, ticker resolution, filler word detection, and
intent classification.

These functions power Kai's voice agent routing -- ensuring user
speech is correctly mapped to application commands without hitting
any external API.
"""

import pytest

from hushh_mcp.services.voice_intent_service import (
    _ALLOWED_COMMANDS,
    _ALLOWED_TOOL_NAMES,
    _COMMAND_ALIASES,
    _COMPANY_ALIAS_TO_TICKER,
    _FILLER_WORDS,
    _MIN_ACTIONABLE_CHARS,
    _env_bool,
    _parse_model_candidates,
)


# ============================================================================
# _COMMAND_ALIASES
# ============================================================================


class TestCommandAliases:
    """Tests for the voice command alias registry."""

    def test_market_aliases_resolve_to_home(self):
        assert _COMMAND_ALIASES["market"] == "home"
        assert _COMMAND_ALIASES["market_section"] == "home"
        assert _COMMAND_ALIASES["kai"] == "home"
        assert _COMMAND_ALIASES["kai_home"] == "home"

    def test_consent_typos_resolve_correctly(self):
        """Voice STT often misspells 'consent' -- aliases must handle common typos."""
        for typo in ("consesns", "consense", "concent", "consets"):
            assert _COMMAND_ALIASES[typo] == "consent", (
                f"Typo '{typo}' should resolve to 'consent'"
            )

    def test_portfolio_resolves_to_dashboard(self):
        assert _COMMAND_ALIASES["portfolio"] == "dashboard"
        assert _COMMAND_ALIASES["portfolio_section"] == "dashboard"

    def test_all_alias_targets_are_valid_commands(self):
        """Every alias must resolve to a recognized command."""
        for alias, target in _COMMAND_ALIASES.items():
            assert target in _ALLOWED_COMMANDS, (
                f"Alias '{alias}' maps to '{target}' which is not in _ALLOWED_COMMANDS"
            )


# ============================================================================
# _COMPANY_ALIAS_TO_TICKER
# ============================================================================


class TestCompanyAliasToTicker:
    """Tests for the company name to ticker symbol mapping."""

    @pytest.mark.parametrize(
        "company,ticker",
        [
            ("google", "GOOGL"),
            ("alphabet", "GOOGL"),
            ("facebook", "META"),
            ("meta", "META"),
            ("apple", "AAPL"),
            ("microsoft", "MSFT"),
            ("amazon", "AMZN"),
            ("nvidia", "NVDA"),
            ("tesla", "TSLA"),
            ("netflix", "NFLX"),
            ("amd", "AMD"),
            ("advanced micro devices", "AMD"),
        ],
    )
    def test_known_company_resolves(self, company, ticker):
        assert _COMPANY_ALIAS_TO_TICKER[company] == ticker

    def test_all_tickers_are_uppercase(self):
        for company, ticker in _COMPANY_ALIAS_TO_TICKER.items():
            assert ticker == ticker.upper(), (
                f"Ticker for '{company}' should be uppercase, got '{ticker}'"
            )


# ============================================================================
# _FILLER_WORDS
# ============================================================================


class TestFillerWords:
    """Tests for the filler word set used to discard noise from STT output."""

    def test_common_fillers_present(self):
        for word in ("uh", "um", "hmm", "huh"):
            assert word in _FILLER_WORDS

    def test_noise_and_static_present(self):
        assert "noise" in _FILLER_WORDS
        assert "static" in _FILLER_WORDS

    def test_greetings_treated_as_filler(self):
        assert "hello" in _FILLER_WORDS
        assert "hey" in _FILLER_WORDS


# ============================================================================
# _ALLOWED_TOOL_NAMES
# ============================================================================


class TestAllowedToolNames:
    """Tests for the voice tool name allowlist."""

    def test_core_tools_present(self):
        assert "execute_kai_command" in _ALLOWED_TOOL_NAMES
        assert "navigate_back" in _ALLOWED_TOOL_NAMES
        assert "clarify" in _ALLOWED_TOOL_NAMES

    def test_analysis_control_tools_present(self):
        assert "resume_active_analysis" in _ALLOWED_TOOL_NAMES
        assert "cancel_active_analysis" in _ALLOWED_TOOL_NAMES


# ============================================================================
# _parse_model_candidates
# ============================================================================


class TestParseModelCandidates:
    """Tests for parsing model candidate strings."""

    def test_returns_defaults_when_none(self):
        result = _parse_model_candidates(None, default_models=["gpt-4o", "gpt-4o-mini"])
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_returns_defaults_when_empty(self):
        result = _parse_model_candidates("", default_models=["gpt-4o-mini"])
        assert result == ["gpt-4o-mini"]

    def test_parses_comma_separated_models(self):
        result = _parse_model_candidates("gpt-4o,gpt-4o-mini", default_models=[])
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_deduplicates_models(self):
        result = _parse_model_candidates("gpt-4o,gpt-4o,gpt-4o-mini", default_models=[])
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_strips_whitespace(self):
        result = _parse_model_candidates("  gpt-4o , gpt-4o-mini  ", default_models=[])
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_filters_empty_entries(self):
        result = _parse_model_candidates("gpt-4o,,gpt-4o-mini,", default_models=[])
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_falls_back_to_gpt4o_mini_when_all_empty(self):
        result = _parse_model_candidates(",,,", default_models=[])
        assert result == ["gpt-4o-mini"]


# ============================================================================
# _env_bool
# ============================================================================


class TestEnvBool:
    """Tests for boolean environment variable parsing."""

    @pytest.mark.parametrize("value", ["1", "true", "yes", "on", "enabled"])
    def test_truthy_values(self, value, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", value)
        assert _env_bool("TEST_FLAG") is True

    @pytest.mark.parametrize("value", ["0", "false", "no", "off", "disabled", "random"])
    def test_falsy_values(self, value, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", value)
        assert _env_bool("TEST_FLAG") is False

    def test_returns_default_when_unset(self, monkeypatch):
        monkeypatch.delenv("TEST_FLAG", raising=False)
        assert _env_bool("TEST_FLAG", default=False) is False
        assert _env_bool("TEST_FLAG", default=True) is True

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "TRUE")
        assert _env_bool("TEST_FLAG") is True

    def test_strips_whitespace(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "  true  ")
        assert _env_bool("TEST_FLAG") is True
