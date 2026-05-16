"""Behavioral tests for pure primitive helpers in voice_app_knowledge.py.

The existing test_voice_app_knowledge.py covers high-level resolution paths.
This file targets the low-level helpers that underpin all of that logic:

    _normalize             — text canonicalization (lowercase, strip, collapse)
    _matches_phrase        — word-boundary phrase matching
    _coerce_bool           — bool-only type guard
    _coerce_int            — int-only type guard
    _coerce_text           — str coercion with empty-string → None
    _coerce_str_list       — list-of-non-empty-strings coercion
    looks_like_voice_knowledge_request — transcript intent classifier

All are pure / side-effect-free.
"""

from __future__ import annotations

from hushh_mcp.services.voice_app_knowledge import (
    _coerce_bool,
    _coerce_int,
    _coerce_str_list,
    _coerce_text,
    _matches_phrase,
    _normalize,
    looks_like_voice_knowledge_request,
)

# ---------------------------------------------------------------------------
# _normalize
# ---------------------------------------------------------------------------


class TestNormalize:
    def test_none_returns_empty_string(self):
        assert _normalize(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _normalize("") == ""

    def test_lowercased(self):
        assert _normalize("HELLO WORLD") == "hello world"

    def test_leading_trailing_whitespace_stripped(self):
        assert _normalize("  hello  ") == "hello"

    def test_underscores_replaced_with_space(self):
        assert _normalize("portfolio_value") == "portfolio value"

    def test_hyphens_replaced_with_space(self):
        assert _normalize("step-by-step") == "step by step"

    def test_multiple_separators_collapsed(self):
        assert _normalize("a--b__c") == "a b c"

    def test_non_alphanumeric_replaced_with_space(self):
        assert _normalize("hello! world?") == "hello world"

    def test_multiple_spaces_collapsed(self):
        assert _normalize("too   many   spaces") == "too many spaces"

    def test_digits_preserved(self):
        assert _normalize("item123") == "item123"

    def test_mixed_complex_string(self):
        result = _normalize("Open_Portfolio-VALUE: $1,234!")
        assert result == "open portfolio value 1 234"


# ---------------------------------------------------------------------------
# _matches_phrase
# ---------------------------------------------------------------------------


class TestMatchesPhrase:
    def test_exact_single_word_match(self):
        assert _matches_phrase("open portfolio", "portfolio") is True

    def test_multi_word_phrase_match(self):
        # The regex joins tokens with \s+ so "open portfolio" must be adjacent in text
        assert _matches_phrase("please open portfolio now", "open portfolio") is True

    def test_no_match_returns_false(self):
        assert _matches_phrase("open settings", "portfolio") is False

    def test_empty_text_returns_false(self):
        assert _matches_phrase("", "portfolio") is False

    def test_empty_phrase_returns_false(self):
        assert _matches_phrase("open portfolio", "") is False

    def test_both_empty_returns_false(self):
        assert _matches_phrase("", "") is False

    def test_word_boundary_respected_no_partial(self):
        # "port" should NOT match "portfolio"
        assert _matches_phrase("open portfolio", "port") is False

    def test_case_insensitive_via_normalize(self):
        assert _matches_phrase("OPEN PORTFOLIO", "open portfolio") is True

    def test_phrase_with_underscores_normalized(self):
        # "open_portfolio" phrase normalized to "open portfolio"
        assert _matches_phrase("open portfolio screen", "open_portfolio") is True

    def test_multi_word_phrase_must_be_contiguous(self):
        # "portfolio open" — words in wrong order, no match
        assert _matches_phrase("open portfolio now", "portfolio open") is False


# ---------------------------------------------------------------------------
# _coerce_bool
# ---------------------------------------------------------------------------


class TestCoerceBool:
    def test_true_returned(self):
        assert _coerce_bool(True) is True

    def test_false_returned(self):
        assert _coerce_bool(False) is False

    def test_non_bool_returns_default_false(self):
        assert _coerce_bool(1) is False
        assert _coerce_bool("true") is False
        assert _coerce_bool(None) is False

    def test_custom_default_returned_for_non_bool(self):
        assert _coerce_bool("yes", default=True) is True

    def test_zero_is_not_bool(self):
        # 0 is int, not bool (even though bool is subclass of int)
        assert _coerce_bool(0) is False  # 0 isinstance bool → True? Let's check actual behavior

    def test_actual_bool_subclass_behavior(self):
        # In Python, isinstance(True, int) is True and isinstance(True, bool) is True
        # The function checks isinstance(value, bool), so True/False are captured
        assert _coerce_bool(True, default=False) is True
        assert _coerce_bool(False, default=True) is False


# ---------------------------------------------------------------------------
# _coerce_int
# ---------------------------------------------------------------------------


class TestCoerceInt:
    def test_int_returned(self):
        assert _coerce_int(42) == 42

    def test_zero_returned(self):
        assert _coerce_int(0) == 0

    def test_negative_int_returned(self):
        assert _coerce_int(-5) == -5

    def test_float_returns_none(self):
        assert _coerce_int(3.14) is None

    def test_string_returns_none(self):
        assert _coerce_int("42") is None

    def test_none_returns_none(self):
        assert _coerce_int(None) is None

    def test_bool_returns_bool_value(self):
        # In Python, bool is a subclass of int — isinstance(True, int) is True
        # So _coerce_int(True) returns True (which is 1)
        result = _coerce_int(True)
        assert result == 1  # True is an int subclass


# ---------------------------------------------------------------------------
# _coerce_text
# ---------------------------------------------------------------------------


class TestCoerceText:
    def test_normal_string_returned(self):
        assert _coerce_text("hello") == "hello"

    def test_none_returns_none(self):
        assert _coerce_text(None) is None

    def test_empty_string_returns_none(self):
        assert _coerce_text("") is None

    def test_whitespace_only_returns_none(self):
        assert _coerce_text("   ") is None

    def test_whitespace_stripped_from_valid_string(self):
        assert _coerce_text("  hello  ") == "hello"

    def test_int_converted_to_string(self):
        assert _coerce_text(42) == "42"

    def test_bool_converted_to_string(self):
        assert _coerce_text(True) == "True"


# ---------------------------------------------------------------------------
# _coerce_str_list
# ---------------------------------------------------------------------------


class TestCoerceStrList:
    def test_empty_list_returns_empty_list(self):
        assert _coerce_str_list([]) == []

    def test_non_list_returns_empty_list(self):
        assert _coerce_str_list(None) == []
        assert _coerce_str_list("not-a-list") == []
        assert _coerce_str_list(42) == []

    def test_valid_strings_returned(self):
        assert _coerce_str_list(["a", "b", "c"]) == ["a", "b", "c"]

    def test_empty_strings_filtered(self):
        assert _coerce_str_list(["a", "", "b"]) == ["a", "b"]

    def test_whitespace_strings_filtered(self):
        assert _coerce_str_list(["a", "   ", "b"]) == ["a", "b"]

    def test_none_items_filtered(self):
        assert _coerce_str_list(["a", None, "b"]) == ["a", "b"]

    def test_whitespace_in_valid_string_stripped(self):
        result = _coerce_str_list(["  hello  "])
        assert result == ["hello"]


# ---------------------------------------------------------------------------
# looks_like_voice_knowledge_request
# ---------------------------------------------------------------------------


class TestLooksLikeVoiceKnowledgeRequest:
    def test_what_is_question_detected(self):
        assert looks_like_voice_knowledge_request("what is this?") is True

    def test_what_can_you_do_detected(self):
        assert looks_like_voice_knowledge_request("what can you do") is True

    def test_what_can_i_do_here_detected(self):
        assert looks_like_voice_knowledge_request("What can I do here?") is True

    def test_explain_prefix_detected(self):
        assert looks_like_voice_knowledge_request("explain the portfolio screen") is True

    def test_tell_me_about_detected(self):
        assert looks_like_voice_knowledge_request("tell me about this screen") is True

    def test_how_does_detected(self):
        assert looks_like_voice_knowledge_request("how does this work?") is True

    def test_what_does_detected(self):
        assert looks_like_voice_knowledge_request("what does save receipts do?") is True

    def test_who_are_you_detected(self):
        assert looks_like_voice_knowledge_request("who are you?") is True

    def test_what_are_you_detected(self):
        assert looks_like_voice_knowledge_request("what are you?") is True

    def test_action_command_not_detected(self):
        assert looks_like_voice_knowledge_request("open the portfolio screen") is False

    def test_generic_question_not_detected(self):
        assert looks_like_voice_knowledge_request("show me my holdings") is False

    def test_empty_string_not_detected(self):
        assert looks_like_voice_knowledge_request("") is False

    def test_case_insensitive_detection(self):
        assert looks_like_voice_knowledge_request("WHAT IS THIS?") is True
