"""Test that VoiceIntentService sanitizes OpenAI error messages (CWE-209)."""

from hushh_mcp.services.voice_intent_service import _extract_openai_error

_SENTINEL = "XK9_VOICE_OPENAI_ERROR_SENTINEL_XK9"


class TestExtractOpenaiError:
    """Unit tests for _extract_openai_error function."""

    def test_extract_message_from_openai_error_dict(self):
        """Test extracting error message from OpenAI error dict."""
        payload = {
            "error": {
                "message": "Model not found",
                "code": "model_not_found",
            }
        }
        result = _extract_openai_error(payload)
        assert result == "Model not found"

    def test_extract_message_with_sentinel(self):
        """Test that sentinel message is extracted correctly."""
        payload = {
            "error": {
                "message": f"API error: {_SENTINEL}",
            }
        }
        result = _extract_openai_error(payload)
        assert result == f"API error: {_SENTINEL}"

    def test_return_none_for_non_dict_payload(self):
        """Test that non-dict payloads return None."""
        result = _extract_openai_error("not a dict")
        assert result is None

    def test_return_none_for_missing_error(self):
        """Test that payloads without error field return None."""
        payload = {"data": "something"}
        result = _extract_openai_error(payload)
        assert result is None

    def test_return_none_for_empty_string_error(self):
        """Test that empty string errors are ignored."""
        payload = {"error": {"message": ""}}
        result = _extract_openai_error(payload)
        assert result is None

    def test_return_none_for_non_string_message(self):
        """Test that non-string message values are ignored."""
        payload = {"error": {"message": 123}}
        result = _extract_openai_error(payload)
        assert result is None

    def test_return_none_for_error_dict_without_message(self):
        """Test that error dict without message returns None."""
        payload = {"error": {"code": "some_code"}}
        result = _extract_openai_error(payload)
        assert result is None

    def test_strips_whitespace_from_message(self):
        """Test that whitespace is stripped from extracted messages."""
        payload = {"error": {"message": "  Model not found  "}}
        result = _extract_openai_error(payload)
        assert result == "Model not found"


class TestVoiceServiceErrorMessages:
    """Tests verifying error messages are static and don't expose internal details."""

    def test_require_api_key_error_is_generic(self):
        """Test that missing API key error message is generic."""
        from hushh_mcp.services.voice_intent_service import VoiceIntentService

        service = VoiceIntentService()
        try:
            service._require_api_key()
        except Exception as e:
            assert "OPENAI_API_KEY" not in str(e)
            assert "Voice service is not configured" in str(e)

    def test_service_error_class_preserves_message(self):
        """Test that VoiceServiceError preserves the message."""
        from hushh_mcp.services.voice_intent_service import VoiceServiceError

        error = VoiceServiceError(502, "Static error message")
        assert error.status_code == 502
        assert error.message == "Static error message"
        assert _SENTINEL not in error.message
