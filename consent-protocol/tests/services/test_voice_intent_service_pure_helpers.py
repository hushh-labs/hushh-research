"""Behavioral tests for pure helper functions in voice_intent_service.py.

The existing test_kai_voice_contract.py covers _compact_context and
integration-level TTS/LLM paths. This file covers the 14 remaining pure
helpers that had zero dedicated tests:

    _parse_model_candidates      — comma-sep model string parsing with dedup
    _prioritize_tts_models       — model priority ordering
    _is_retryable_model_error    — OpenAI error classification for retry
    _is_model_unavailable_error  — OpenAI error classification for skip
    _coerce_bool / _coerce_str / _coerce_str_or_none / _coerce_int
    _coerce_str_list / _coerce_slot_value
    _is_screen_explain_intent    — transcript intent detection
    _is_screen_capability_intent — transcript intent detection
    _wants_detailed_response     — transcript detail-level detection
    _match_surface_navigation_intent — surface routing from transcript
    _match_ria_navigation_action    — RIA navigation routing
    _is_receipts_memory_intent      — receipts memory intent detection
    _is_generic_execute_message     — generic execute label detection
    _build_execute_message          — spoken execute confirmation builder
    _canonical_action_id_from_tool_call — tool → canonical action ID
"""

from __future__ import annotations

from hushh_mcp.services.voice_intent_service import (
    _build_execute_message,
    _canonical_action_id_from_tool_call,
    _coerce_bool,
    _coerce_int,
    _coerce_slot_value,
    _coerce_str,
    _coerce_str_list,
    _coerce_str_or_none,
    _is_generic_execute_message,
    _is_model_unavailable_error,
    _is_receipts_memory_intent,
    _is_retryable_model_error,
    _is_screen_capability_intent,
    _is_screen_explain_intent,
    _match_ria_navigation_action,
    _match_surface_navigation_intent,
    _parse_model_candidates,
    _prioritize_tts_models,
    _wants_detailed_response,
)

# ---------------------------------------------------------------------------
# _parse_model_candidates
# ---------------------------------------------------------------------------


class TestParseModelCandidates:
    _DEFAULTS = ["gpt-4o-mini", "gpt-4o"]

    def test_none_returns_defaults(self):
        assert _parse_model_candidates(None, default_models=self._DEFAULTS) == self._DEFAULTS

    def test_empty_string_returns_defaults(self):
        assert _parse_model_candidates("", default_models=self._DEFAULTS) == self._DEFAULTS

    def test_whitespace_only_returns_defaults(self):
        assert _parse_model_candidates("   ", default_models=self._DEFAULTS) == self._DEFAULTS

    def test_single_model(self):
        assert _parse_model_candidates("gpt-4o", default_models=self._DEFAULTS) == ["gpt-4o"]

    def test_comma_separated_models(self):
        result = _parse_model_candidates("gpt-4o,gpt-4o-mini", default_models=self._DEFAULTS)
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_duplicates_removed(self):
        result = _parse_model_candidates("gpt-4o,gpt-4o,gpt-4o-mini", default_models=self._DEFAULTS)
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_whitespace_around_models_stripped(self):
        result = _parse_model_candidates(" gpt-4o , gpt-4o-mini ", default_models=self._DEFAULTS)
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_empty_segments_skipped(self):
        result = _parse_model_candidates("gpt-4o,,gpt-4o-mini", default_models=self._DEFAULTS)
        assert result == ["gpt-4o", "gpt-4o-mini"]

    def test_non_string_type_returns_defaults(self):
        result = _parse_model_candidates(42, default_models=self._DEFAULTS)  # type: ignore[arg-type]
        assert result == self._DEFAULTS


# ---------------------------------------------------------------------------
# _prioritize_tts_models
# ---------------------------------------------------------------------------


class TestPrioritizeTtsModels:
    def test_gpt_4o_mini_tts_always_first(self):
        result = _prioritize_tts_models(
            ["some-other-model"], configured_model="custom-tts", prefer_quality=False
        )
        assert result[0] == "gpt-4o-mini-tts"

    def test_configured_model_included(self):
        result = _prioritize_tts_models([], configured_model="my-tts-model", prefer_quality=False)
        assert "my-tts-model" in result

    def test_prefer_quality_adds_gpt_4o_tts(self):
        result = _prioritize_tts_models([], configured_model="gpt-4o-mini-tts", prefer_quality=True)
        assert "gpt-4o-tts" in result

    def test_prefer_quality_false_omits_gpt_4o_tts(self):
        result = _prioritize_tts_models(
            [], configured_model="gpt-4o-mini-tts", prefer_quality=False
        )
        assert "gpt-4o-tts" not in result

    def test_no_duplicates(self):
        result = _prioritize_tts_models(
            ["gpt-4o-mini-tts", "gpt-4o-mini-tts"],
            configured_model="gpt-4o-mini-tts",
            prefer_quality=False,
        )
        assert result.count("gpt-4o-mini-tts") == 1

    def test_parsed_models_appended(self):
        result = _prioritize_tts_models(
            ["extra-model"], configured_model="gpt-4o-mini-tts", prefer_quality=False
        )
        assert "extra-model" in result

    def test_empty_model_name_skipped(self):
        result = _prioritize_tts_models(
            ["", "gpt-4o-tts"], configured_model="gpt-4o-mini-tts", prefer_quality=False
        )
        assert "" not in result


# ---------------------------------------------------------------------------
# _is_retryable_model_error / _is_model_unavailable_error
# ---------------------------------------------------------------------------


class TestIsRetryableModelError:
    def test_400_model_not_found_is_retryable(self):
        assert _is_retryable_model_error(400, {"error": {"message": "model not found"}}) is True

    def test_403_not_permitted_is_retryable(self):
        assert (
            _is_retryable_model_error(403, {"error": {"message": "not permitted for this model"}})
            is True
        )

    def test_500_is_not_retryable(self):
        assert _is_retryable_model_error(500, {"error": {"message": "model not found"}}) is False

    def test_200_is_not_retryable(self):
        assert _is_retryable_model_error(200, {}) is False

    def test_empty_payload_not_retryable(self):
        assert _is_retryable_model_error(400, {}) is False

    def test_unrelated_error_message_not_retryable(self):
        assert (
            _is_retryable_model_error(400, {"error": {"message": "rate limit exceeded"}}) is False
        )


class TestIsModelUnavailableError:
    def test_404_not_found_is_unavailable(self):
        assert (
            _is_model_unavailable_error(404, {"error": {"message": "model does not exist"}}) is True
        )

    def test_403_no_access_is_unavailable(self):
        assert (
            _is_model_unavailable_error(
                403, {"error": {"message": "you do not have access to this model"}}
            )
            is True
        )

    def test_200_not_unavailable(self):
        assert _is_model_unavailable_error(200, {}) is False

    def test_empty_payload_not_unavailable(self):
        assert _is_model_unavailable_error(400, {}) is False


# ---------------------------------------------------------------------------
# _coerce_bool, _coerce_str, _coerce_str_or_none, _coerce_int
# ---------------------------------------------------------------------------


class TestCoerceBool:
    def test_true_returned(self):
        assert _coerce_bool(True) is True

    def test_false_returned(self):
        assert _coerce_bool(False) is False

    def test_int_1_returns_default(self):
        assert _coerce_bool(1) is False

    def test_string_true_returns_default(self):
        assert _coerce_bool("true") is False

    def test_none_returns_default(self):
        assert _coerce_bool(None) is False

    def test_custom_default_for_non_bool(self):
        assert _coerce_bool(42, default=True) is True


class TestCoerceStr:
    def test_normal_string_returned(self):
        assert _coerce_str("hello") == "hello"

    def test_none_returns_default(self):
        assert _coerce_str(None) == ""

    def test_whitespace_only_returns_default(self):
        assert _coerce_str("   ") == ""

    def test_int_converted_to_string(self):
        assert _coerce_str(42) == "42"

    def test_whitespace_stripped(self):
        assert _coerce_str("  hello  ") == "hello"

    def test_custom_default(self):
        assert _coerce_str(None, default="fallback") == "fallback"


class TestCoerceStrOrNone:
    def test_valid_string_returned(self):
        assert _coerce_str_or_none("hello") == "hello"

    def test_none_returns_none(self):
        assert _coerce_str_or_none(None) is None

    def test_empty_string_returns_none(self):
        assert _coerce_str_or_none("") is None

    def test_whitespace_only_returns_none(self):
        assert _coerce_str_or_none("   ") is None


class TestCoerceInt:
    def test_int_returned(self):
        assert _coerce_int(5) == 5

    def test_float_returns_none(self):
        assert _coerce_int(3.14) is None

    def test_string_returns_none(self):
        assert _coerce_int("5") is None

    def test_none_returns_none(self):
        assert _coerce_int(None) is None


# ---------------------------------------------------------------------------
# _coerce_str_list
# ---------------------------------------------------------------------------


class TestCoerceStrList:
    def test_valid_strings_returned(self):
        assert _coerce_str_list(["a", "b"]) == ["a", "b"]

    def test_non_list_returns_empty(self):
        assert _coerce_str_list(None) == []
        assert _coerce_str_list("string") == []

    def test_empty_strings_filtered(self):
        assert _coerce_str_list(["a", "", "b"]) == ["a", "b"]

    def test_whitespace_items_filtered(self):
        assert _coerce_str_list(["a", "  ", "b"]) == ["a", "b"]


# ---------------------------------------------------------------------------
# _coerce_slot_value
# ---------------------------------------------------------------------------


class TestCoerceSlotValue:
    def test_none_returns_none(self):
        assert _coerce_slot_value(None) is None

    def test_string_returned(self):
        assert _coerce_slot_value("hello") == "hello"

    def test_int_returned(self):
        assert _coerce_slot_value(42) == 42

    def test_float_returned(self):
        assert _coerce_slot_value(3.14) == 3.14

    def test_bool_returned(self):
        assert _coerce_slot_value(True) is True

    def test_list_coerced_to_string_or_none(self):
        # Lists are not in the allowed types; _coerce_str([]) → "" → None
        result = _coerce_slot_value([1, 2, 3])
        assert result is None or isinstance(result, str)


# ---------------------------------------------------------------------------
# Intent detection
# ---------------------------------------------------------------------------


class TestIsScreenExplainIntent:
    def test_what_is_this_screen(self):
        assert _is_screen_explain_intent("what is this screen") is True

    def test_explain_this_screen(self):
        # "explain this screen" is in _SCREEN_EXPLAIN_KEYWORDS; "explain my screen" is not
        assert _is_screen_explain_intent("explain this screen") is True

    def test_explain_my_screen_not_matched(self):
        # "explain my screen" is intentionally absent from keywords — only "explain this screen" etc. are included
        assert _is_screen_explain_intent("explain my screen") is False

    def test_what_can_you_do_here(self):
        assert _is_screen_explain_intent("what can you do here") is True

    def test_generic_navigation_not_explain(self):
        assert _is_screen_explain_intent("open portfolio") is False


class TestIsScreenCapabilityIntent:
    def test_what_can_i_do_here(self):
        assert _is_screen_capability_intent("what can i do here") is True

    def test_what_can_you_do_on_this_screen(self):
        assert _is_screen_capability_intent("what can you do on this screen") is True

    def test_unrelated_transcript_false(self):
        assert _is_screen_capability_intent("show me my portfolio") is False


class TestWantsDetailedResponse:
    def test_explain_in_detail(self):
        assert _wants_detailed_response("explain in detail") is True

    def test_why_keyword(self):
        assert _wants_detailed_response("why does this work") is True

    def test_brief_question_false(self):
        assert _wants_detailed_response("what is this") is False


# ---------------------------------------------------------------------------
# Navigation intent matching
# ---------------------------------------------------------------------------


class TestMatchSurfaceNavigationIntent:
    def test_open_gmail_returns_gmail(self):
        assert _match_surface_navigation_intent("open gmail") == "gmail"

    def test_show_receipts_returns_receipts(self):
        assert _match_surface_navigation_intent("show my receipts") == "receipts"

    def test_go_to_pkm_returns_pkm_agent_lab(self):
        assert _match_surface_navigation_intent("go to pkm") == "pkm_agent_lab"

    def test_unrelated_transcript_returns_none(self):
        assert _match_surface_navigation_intent("analyze apple") is None


class TestMatchRiaNavigationAction:
    def test_open_ria_clients_returns_route(self):
        result = _match_ria_navigation_action("open my clients")
        assert result == "route.ria_clients"

    def test_go_to_ria_picks_returns_route(self):
        result = _match_ria_navigation_action("go to ria picks")
        assert result == "route.ria_picks"

    def test_show_ria_onboarding(self):
        result = _match_ria_navigation_action("show ria onboarding")
        assert result == "route.ria_onboarding"

    def test_no_nav_verb_no_ria_returns_none(self):
        assert _match_ria_navigation_action("analyze apple stock") is None

    def test_ria_home_direct(self):
        result = _match_ria_navigation_action("open ria")
        assert result == "route.ria_home"


class TestIsReceiptsMemoryIntent:
    def test_add_receipts_to_pkm(self):
        assert _is_receipts_memory_intent("add receipts to pkm") is True

    def test_build_receipts_pkm(self):
        assert _is_receipts_memory_intent("build receipts pkm") is True

    def test_receipts_memory(self):
        assert _is_receipts_memory_intent("show receipts memory") is True

    def test_unrelated_transcript_false(self):
        assert _is_receipts_memory_intent("open portfolio") is False


# ---------------------------------------------------------------------------
# _is_generic_execute_message
# ---------------------------------------------------------------------------


class TestIsGenericExecuteMessage:
    def test_working_on_that_now(self):
        assert _is_generic_execute_message("Working on that now") is True

    def test_done(self):
        assert _is_generic_execute_message("Done") is True

    def test_okay(self):
        assert _is_generic_execute_message("Okay") is True

    def test_ok(self):
        assert _is_generic_execute_message("Ok") is True

    def test_trailing_punctuation_stripped(self):
        assert _is_generic_execute_message("Done.") is True

    def test_non_generic_message_false(self):
        assert _is_generic_execute_message("Starting analysis for AAPL.") is False


# ---------------------------------------------------------------------------
# _build_execute_message
# ---------------------------------------------------------------------------


class TestBuildExecuteMessage:
    def test_none_returns_working_on_that(self):
        assert _build_execute_message(None) == "Working on that now."

    def test_non_dict_returns_working_on_that(self):
        assert _build_execute_message("not-a-dict") == "Working on that now."

    def test_navigate_back_returns_going_back(self):
        assert _build_execute_message({"tool_name": "navigate_back"}) == "Going back."

    def test_resume_active_analysis(self):
        assert (
            _build_execute_message({"tool_name": "resume_active_analysis"}) == "Resuming analysis."
        )

    def test_cancel_active_analysis(self):
        assert (
            _build_execute_message({"tool_name": "cancel_active_analysis"})
            == "Cancelling analysis."
        )

    def test_execute_kai_command_analyze_with_symbol(self):
        tool_call = {
            "tool_name": "execute_kai_command",
            "args": {"command": "analyze", "params": {"symbol": "aapl"}},
        }
        assert _build_execute_message(tool_call) == "Starting analysis for AAPL."

    def test_execute_kai_command_analyze_no_symbol(self):
        tool_call = {
            "tool_name": "execute_kai_command",
            "args": {"command": "analyze", "params": {}},
        }
        assert _build_execute_message(tool_call) == "Starting analysis."

    def test_execute_kai_command_home(self):
        tool_call = {"tool_name": "execute_kai_command", "args": {"command": "home"}}
        result = _build_execute_message(tool_call)
        assert "Opening" in result

    def test_unknown_tool_returns_working_on_that(self):
        assert _build_execute_message({"tool_name": "unknown_tool"}) == "Working on that now."


# ---------------------------------------------------------------------------
# _canonical_action_id_from_tool_call
# ---------------------------------------------------------------------------


class TestCanonicalActionIdFromToolCall:
    def test_none_returns_none(self):
        assert _canonical_action_id_from_tool_call(None) is None

    def test_non_dict_returns_none(self):
        assert _canonical_action_id_from_tool_call("not-a-dict") is None

    def test_execute_kai_command_home_maps_to_route(self):
        result = _canonical_action_id_from_tool_call(
            {"tool_name": "execute_kai_command", "args": {"command": "home"}}
        )
        assert result == "route.kai_home"

    def test_execute_kai_command_analyze_maps_to_action(self):
        result = _canonical_action_id_from_tool_call(
            {"tool_name": "execute_kai_command", "args": {"command": "analyze"}}
        )
        assert result == "analysis.start"

    def test_resume_active_analysis_tool_name(self):
        result = _canonical_action_id_from_tool_call({"tool_name": "resume_active_analysis"})
        assert result == "analysis.resume_active"

    def test_cancel_active_analysis_tool_name(self):
        result = _canonical_action_id_from_tool_call({"tool_name": "cancel_active_analysis"})
        assert result == "analysis.cancel_active"

    def test_unknown_tool_name_returns_none(self):
        result = _canonical_action_id_from_tool_call({"tool_name": "unknown_tool"})
        assert result is None
