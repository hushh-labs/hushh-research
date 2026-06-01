"""Behavioral tests for pure helpers in voice_action_manifest.py.

_normalize_action_entry is the normalization gate for every voice action
entering the Kai action-gateway. It validates required fields, normalises
optional fields (speaker_persona, delegate_agent_id, aliases, scope,
guards, risk, completion_mode) and returns a canonical dict or None.

select_voice_manifest_actions_for_prompt scores and ranks actions by
contextual relevance (available_action_ids, screen, transcript keyword).

Tests inject synthetic action dicts directly — no filesystem manifest needed.
"""

from __future__ import annotations

from unittest.mock import patch

from hushh_mcp.services.voice_action_manifest import (
    _normalize_action_entry,
    select_voice_manifest_actions_for_prompt,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MIN_ACTION = {
    "action_id": "open_portfolio",
    "label": "Open Portfolio",
    "meaning": "Navigate to the portfolio screen",
}


def _make_action(**overrides) -> dict:
    a = dict(_MIN_ACTION)
    a.update(overrides)
    return a


def _normalized(**overrides) -> dict:
    return _normalize_action_entry(_make_action(**overrides))


# ---------------------------------------------------------------------------
# _normalize_action_entry — required fields
# ---------------------------------------------------------------------------


class TestNormalizeActionEntryRequired:
    def test_non_dict_returns_none(self):
        assert _normalize_action_entry("not-a-dict") is None
        assert _normalize_action_entry(None) is None
        assert _normalize_action_entry([]) is None

    def test_missing_action_id_returns_none(self):
        assert _normalize_action_entry({"label": "L", "meaning": "M"}) is None

    def test_empty_action_id_returns_none(self):
        assert _normalize_action_entry({"action_id": "", "label": "L", "meaning": "M"}) is None

    def test_whitespace_action_id_returns_none(self):
        assert _normalize_action_entry({"action_id": "   ", "label": "L", "meaning": "M"}) is None

    def test_missing_label_returns_none(self):
        assert _normalize_action_entry({"action_id": "x", "meaning": "M"}) is None

    def test_missing_meaning_returns_none(self):
        assert _normalize_action_entry({"action_id": "x", "label": "L"}) is None

    def test_minimal_valid_entry_returns_dict(self):
        result = _normalize_action_entry(_MIN_ACTION)
        assert isinstance(result, dict)
        assert result["action_id"] == "open_portfolio"

    def test_id_field_accepted_as_action_id_alias(self):
        raw = {"id": "nav_home", "label": "Home", "meaning": "Go home"}
        result = _normalize_action_entry(raw)
        assert result is not None
        assert result["action_id"] == "nav_home"

    def test_action_id_whitespace_stripped(self):
        result = _normalized(action_id="  open_portfolio  ")
        assert result["action_id"] == "open_portfolio"

    def test_label_whitespace_stripped(self):
        result = _normalized(label="  Open Portfolio  ")
        assert result["label"] == "Open Portfolio"


# ---------------------------------------------------------------------------
# _normalize_action_entry — speaker_persona
# ---------------------------------------------------------------------------


class TestNormalizeSpeakerPersona:
    def test_default_persona_is_one(self):
        result = _normalized()
        assert result["speaker_persona"] == "one"

    def test_valid_persona_kai_accepted(self):
        assert _normalized(speaker_persona="kai")["speaker_persona"] == "kai"

    def test_valid_persona_nav_accepted(self):
        assert _normalized(speaker_persona="nav")["speaker_persona"] == "nav"

    def test_valid_persona_kyc_accepted(self):
        assert _normalized(speaker_persona="kyc")["speaker_persona"] == "kyc"

    def test_unknown_persona_falls_back_to_one(self):
        assert _normalized(speaker_persona="robot")["speaker_persona"] == "one"

    def test_persona_lowercased(self):
        assert _normalized(speaker_persona="KAI")["speaker_persona"] == "kai"


# ---------------------------------------------------------------------------
# _normalize_action_entry — delegate_agent_id
# ---------------------------------------------------------------------------


class TestNormalizeDelegateAgentId:
    def test_no_delegate_defaults_to_none(self):
        assert _normalized()["delegate_agent_id"] is None

    def test_valid_delegate_kai_accepted(self):
        assert _normalized(delegate_agent_id="kai")["delegate_agent_id"] == "kai"

    def test_valid_delegate_nav_accepted(self):
        assert _normalized(delegate_agent_id="nav")["delegate_agent_id"] == "nav"

    def test_invalid_delegate_set_to_none(self):
        assert _normalized(delegate_agent_id="unknown_agent")["delegate_agent_id"] is None

    def test_empty_delegate_set_to_none(self):
        assert _normalized(delegate_agent_id="")["delegate_agent_id"] is None

    def test_delegate_lowercased(self):
        assert _normalized(delegate_agent_id="KAI")["delegate_agent_id"] == "kai"


# ---------------------------------------------------------------------------
# _normalize_action_entry — aliases
# ---------------------------------------------------------------------------


class TestNormalizeAliases:
    def test_no_aliases_defaults_to_empty_list(self):
        assert _normalized()["aliases"] == []

    def test_valid_aliases_preserved(self):
        result = _normalized(aliases=["portfolio", "my holdings"])
        assert result["aliases"] == ["portfolio", "my holdings"]

    def test_empty_alias_strings_filtered(self):
        result = _normalized(aliases=["", "  ", "portfolio"])
        assert result["aliases"] == ["portfolio"]

    def test_aliases_whitespace_stripped(self):
        result = _normalized(aliases=["  portfolio  "])
        assert result["aliases"] == ["portfolio"]


# ---------------------------------------------------------------------------
# _normalize_action_entry — scope
# ---------------------------------------------------------------------------


class TestNormalizeScope:
    def test_no_scope_defaults_to_empty_lists(self):
        result = _normalized()
        assert result["scope"] == {"screens": [], "routes": []}

    def test_reachability_field_used_over_scope(self):
        result = _normalized(
            reachability={"screens": ["home"], "routes": []},
            scope={"screens": ["other"]},
        )
        assert result["scope"]["screens"] == ["home"]

    def test_scope_screens_and_routes_extracted(self):
        result = _normalized(scope={"screens": ["home", "portfolio"], "routes": ["/v1"]})
        assert result["scope"]["screens"] == ["home", "portfolio"]
        assert result["scope"]["routes"] == ["/v1"]

    def test_empty_screen_strings_filtered(self):
        result = _normalized(scope={"screens": ["", "home", None]})
        assert "home" in result["scope"]["screens"]
        assert "" not in result["scope"]["screens"]


# ---------------------------------------------------------------------------
# _normalize_action_entry — guards
# ---------------------------------------------------------------------------


class TestNormalizeGuards:
    def test_no_guards_defaults_to_empty_list(self):
        assert _normalized()["guards"] == []

    def test_list_of_dicts_preserved(self):
        guards = [{"id": "consent_required"}, {"id": "auth_required"}]
        result = _normalized(guards=guards)
        assert result["guards"] == guards

    def test_non_dict_guards_filtered(self):
        result = _normalized(guards=[{"id": "ok"}, "not-a-dict", 42])
        assert result["guards"] == [{"id": "ok"}]

    def test_guard_ids_list_converted_to_dicts(self):
        result = _normalized(guard_ids=["consent_required"])
        assert result["guards"] == [{"id": "consent_required"}]


# ---------------------------------------------------------------------------
# _normalize_action_entry — risk / execution_policy
# ---------------------------------------------------------------------------


class TestNormalizeRisk:
    def test_default_execution_policy_is_allow_direct(self):
        assert _normalized()["risk"]["execution_policy"] == "allow_direct"

    def test_risk_dict_execution_policy_used(self):
        result = _normalized(risk={"execution_policy": "require_confirm"})
        assert result["risk"]["execution_policy"] == "require_confirm"

    def test_top_level_execution_policy_fallback(self):
        result = _normalized(execution_policy="require_confirm")
        assert result["risk"]["execution_policy"] == "require_confirm"


# ---------------------------------------------------------------------------
# _normalize_action_entry — completion_mode
# ---------------------------------------------------------------------------


class TestNormalizeCompletionMode:
    def test_default_completion_mode_is_none(self):
        assert _normalized()["completion_mode"] == "none"

    def test_completion_mode_from_field(self):
        result = _normalized(completion_mode="confirm")
        assert result["completion_mode"] == "confirm"

    def test_completion_field_alias(self):
        result = _normalized(completion="confirm")
        assert result["completion_mode"] == "confirm"


# ---------------------------------------------------------------------------
# select_voice_manifest_actions_for_prompt
# ---------------------------------------------------------------------------

_ACTION_PORTFOLIO = {
    "action_id": "open_portfolio",
    "label": "Open Portfolio",
    "meaning": "Navigate to the portfolio screen",
    "aliases": [],
    "scope": {"screens": ["portfolio"], "routes": []},
    "speaker_persona": "one",
    "delegate_agent_id": None,
    "guards": [],
    "risk": {"execution_policy": "allow_direct"},
    "completion_mode": "none",
    "expected_effects": {},
    "background_behavior": {},
}
_ACTION_SETTINGS = {
    "action_id": "open_settings",
    "label": "Open Settings",
    "meaning": "Navigate to the settings screen",
    "aliases": [],
    "scope": {"screens": ["settings"], "routes": []},
    "speaker_persona": "one",
    "delegate_agent_id": None,
    "guards": [],
    "risk": {"execution_policy": "allow_direct"},
    "completion_mode": "none",
    "expected_effects": {},
    "background_behavior": {},
}
_ALL_ACTIONS = [_ACTION_PORTFOLIO, _ACTION_SETTINGS]


class TestSelectVoiceManifestActionsForPrompt:
    def _select(self, **kwargs):
        with patch(
            "hushh_mcp.services.voice_action_manifest.list_voice_manifest_actions",
            return_value=_ALL_ACTIONS,
        ):
            return select_voice_manifest_actions_for_prompt(**kwargs)

    def test_available_action_id_scores_highest(self):
        result = self._select(available_action_ids=["open_portfolio"])
        assert result[0]["action_id"] == "open_portfolio"

    def test_screen_match_boosts_score(self):
        result = self._select(screen="settings")
        assert result[0]["action_id"] == "open_settings"

    def test_transcript_keyword_match_boosts_score(self):
        result = self._select(transcript="show portfolio screen")
        assert result[0]["action_id"] == "open_portfolio"

    def test_limit_respected(self):
        result = self._select(available_action_ids=["open_portfolio", "open_settings"], limit=1)
        assert len(result) == 1

    def test_no_match_returns_all_up_to_limit(self):
        result = self._select(limit=5)
        assert len(result) == len(_ALL_ACTIONS)

    def test_empty_available_ids_no_score_boost(self):
        # With no context, falls back to all_actions[:limit]
        result = self._select(available_action_ids=[])
        assert len(result) == len(_ALL_ACTIONS)

    def test_none_inputs_do_not_crash(self):
        result = self._select(screen=None, available_action_ids=None, transcript=None)
        assert isinstance(result, list)
