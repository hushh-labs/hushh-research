"""
Pure unit tests for the module-level helper functions in
hushh_mcp/operons/kai/llm.py.

All functions under test are pure (no Gemini API, no network, no async)
and had zero dedicated test coverage.  They are called on every Kai
analysis request and LLM stream invocation.

Functions covered
-----------------
_stream_concurrency_limit()
    Reads KAI_GEMINI_STREAM_CONCURRENCY env var, parses int,
    clamps to ≥1, defaults to 2 on error.

_is_retryable_stream_error(error)
    Detects rate-limit / quota exhaustion from error message strings.

_is_truthy(raw_value)
    Converts string env-var-style values to bool.

_gemini_unavailable_payload(default_message)
    Builds a standardised error dict.

_extract_json(text)
    Robustly extracts a JSON object from LLM output, handling markdown
    code fences, leading noise, and trailing noise.
"""

from __future__ import annotations

import pytest

from hushh_mcp.operons.kai.llm import (
    _extract_json,
    _gemini_unavailable_payload,
    _is_retryable_stream_error,
    _is_truthy,
    _stream_concurrency_limit,
)

# ===========================================================================
# _stream_concurrency_limit
# ===========================================================================


class TestStreamConcurrencyLimit:
    def test_default_returns_2(self, monkeypatch):
        monkeypatch.delenv("KAI_GEMINI_STREAM_CONCURRENCY", raising=False)
        assert _stream_concurrency_limit() == 2

    def test_valid_env_var_used(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "5")
        assert _stream_concurrency_limit() == 5

    def test_zero_clamped_to_1(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "0")
        assert _stream_concurrency_limit() == 1

    def test_negative_clamped_to_1(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "-3")
        assert _stream_concurrency_limit() == 1

    def test_non_integer_defaults_to_2(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "abc")
        assert _stream_concurrency_limit() == 2

    def test_empty_string_defaults_to_2(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "")
        assert _stream_concurrency_limit() == 2

    def test_whitespace_trimmed(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "  10  ")
        assert _stream_concurrency_limit() == 10

    def test_large_value_allowed(self, monkeypatch):
        monkeypatch.setenv("KAI_GEMINI_STREAM_CONCURRENCY", "100")
        assert _stream_concurrency_limit() == 100

    def test_returns_int(self, monkeypatch):
        monkeypatch.delenv("KAI_GEMINI_STREAM_CONCURRENCY", raising=False)
        result = _stream_concurrency_limit()
        assert isinstance(result, int)


# ===========================================================================
# _is_retryable_stream_error
# ===========================================================================


class TestIsRetryableStreamError:
    def test_429_status_code_in_message_is_retryable(self):
        assert _is_retryable_stream_error("HTTP 429 error") is True

    def test_too_many_requests_is_retryable(self):
        assert _is_retryable_stream_error("too many requests") is True

    def test_resource_exhausted_is_retryable(self):
        assert _is_retryable_stream_error("resource_exhausted quota exceeded") is True

    def test_quota_is_retryable(self):
        assert _is_retryable_stream_error("quota limit reached") is True

    def test_rate_limit_is_retryable(self):
        assert _is_retryable_stream_error("rate limit exceeded") is True

    def test_case_insensitive_matching(self):
        assert _is_retryable_stream_error("QUOTA exceeded") is True
        assert _is_retryable_stream_error("Rate Limit") is True

    def test_500_internal_error_not_retryable(self):
        assert _is_retryable_stream_error("500 internal server error") is False

    def test_timeout_not_retryable(self):
        assert _is_retryable_stream_error("request timed out") is False

    def test_connection_error_not_retryable(self):
        assert _is_retryable_stream_error("connection refused") is False

    def test_empty_string_not_retryable(self):
        assert _is_retryable_stream_error("") is False

    def test_exception_object_accepted(self):
        exc = RuntimeError("HTTP 429: Too Many Requests")
        assert _is_retryable_stream_error(exc) is True

    def test_exception_without_marker_not_retryable(self):
        exc = ValueError("Invalid input")
        assert _is_retryable_stream_error(exc) is False


# ===========================================================================
# _is_truthy
# ===========================================================================


class TestIsTruthy:
    @pytest.mark.parametrize("val", ["1", "true", "yes", "on"])
    def test_truthy_values(self, val: str):
        assert _is_truthy(val) is True

    @pytest.mark.parametrize("val", ["True", "YES", "ON", "TRUE"])
    def test_truthy_values_case_insensitive(self, val: str):
        assert _is_truthy(val) is True

    @pytest.mark.parametrize("val", ["0", "false", "no", "off", "", "nope", "maybe"])
    def test_falsy_values(self, val: str):
        assert _is_truthy(val) is False

    def test_whitespace_stripped(self):
        assert _is_truthy("  true  ") is True
        assert _is_truthy("  1  ") is True

    def test_returns_bool(self):
        assert isinstance(_is_truthy("true"), bool)
        assert isinstance(_is_truthy("false"), bool)


# ===========================================================================
# _gemini_unavailable_payload
# ===========================================================================


class TestGeminiUnavailablePayload:
    def test_contains_error_key(self):
        result = _gemini_unavailable_payload("Gemini is down")
        assert "error" in result

    def test_contains_fallback_true(self):
        result = _gemini_unavailable_payload("Gemini is down")
        assert result["fallback"] is True

    def test_contains_code_key(self):
        result = _gemini_unavailable_payload("Gemini is down")
        assert result["code"] == "GEMINI_UNAVAILABLE"

    def test_default_message_used_when_no_reason(self):
        # When _gemini_unavailable_reason is None (fresh import), the default_message is used
        result = _gemini_unavailable_payload("fallback message")
        assert isinstance(result["error"], str)
        assert len(result["error"]) > 0

    def test_returns_dict(self):
        result = _gemini_unavailable_payload("msg")
        assert isinstance(result, dict)

    def test_three_keys_present(self):
        result = _gemini_unavailable_payload("msg")
        assert set(result.keys()) == {"error", "fallback", "code"}


# ===========================================================================
# _extract_json
# ===========================================================================


class TestExtractJson:
    def test_plain_json_extracted(self):
        result = _extract_json('{"key": "value"}')
        assert result == {"key": "value"}

    def test_markdown_json_fence_stripped(self):
        text = '```json\n{"score": 0.9}\n```'
        result = _extract_json(text)
        assert result == {"score": 0.9}

    def test_plain_code_fence_stripped(self):
        text = '```\n{"x": 1}\n```'
        result = _extract_json(text)
        assert result == {"x": 1}

    def test_leading_noise_before_brace_ignored(self):
        text = 'Here is the result: {"answer": 42}'
        result = _extract_json(text)
        assert result == {"answer": 42}

    def test_trailing_noise_after_brace_ignored(self):
        text = '{"ok": true} some trailing text'
        result = _extract_json(text)
        assert result == {"ok": True}

    def test_nested_json_extracted(self):
        text = '{"a": {"b": {"c": 1}}}'
        result = _extract_json(text)
        assert result == {"a": {"b": {"c": 1}}}

    def test_json_with_list_values(self):
        text = '{"items": [1, 2, 3]}'
        result = _extract_json(text)
        assert result == {"items": [1, 2, 3]}

    def test_empty_object_extracted(self):
        result = _extract_json("{}")
        assert result == {}

    def test_invalid_json_returns_empty_dict(self):
        result = _extract_json("not json at all")
        assert result == {}

    def test_empty_string_returns_empty_dict(self):
        result = _extract_json("")
        assert result == {}

    def test_malformed_json_returns_empty_dict(self):
        result = _extract_json('{"key": missing_quote}')
        assert result == {}

    def test_whitespace_around_json_stripped(self):
        result = _extract_json('   {"padded": true}   ')
        assert result == {"padded": True}

    def test_llm_preamble_and_postamble(self):
        text = (
            "Based on my analysis, here is the structured output:\n"
            '```json\n{"recommendation": "buy", "confidence": 0.85}\n```\n'
            "I hope this helps!"
        )
        result = _extract_json(text)
        assert result == {"recommendation": "buy", "confidence": 0.85}

    def test_returns_dict_type(self):
        result = _extract_json('{"k": "v"}')
        assert isinstance(result, dict)

    def test_unicode_values_preserved(self):
        result = _extract_json('{"name": "José"}')
        assert result == {"name": "José"}
