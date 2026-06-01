"""Regression tests - CWE-209 in hushh_mcp/operons/kai/llm.py.

Verifies that internal exception detail and consent-validation reason strings
are NOT forwarded to SSE callers through stream_gemini_response and
analyze_fundamental_streaming.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _collect(gen) -> list[dict]:
    frames = []
    async for frame in gen:
        frames.append(frame)
    return frames


# ---------------------------------------------------------------------------
# stream_gemini_response - exception leak (CWE-209)
#
# stream_gemini_response() uses the module-level _gemini_client object; it
# does NOT accept a `model` parameter. Tests patch the module-level client
# and _require_gemini_ready so the function exercises the real exception path.
# ---------------------------------------------------------------------------


class TestStreamGeminiResponseExceptionLeak:
    """Internal exception detail must not appear in yielded error frames."""

    def test_exception_message_not_in_error_payload(self) -> None:
        """Sentinel exception message must not leak into error frame."""
        from hushh_mcp.operons.kai import llm as llm_mod
        from hushh_mcp.operons.kai.llm import stream_gemini_response

        sentinel = "SENTINEL_INTERNAL_GEMINI_DETAIL_xk9z"

        fake_client = MagicMock()
        fake_client.aio.models.generate_content_stream = AsyncMock(
            side_effect=RuntimeError(sentinel)
        )

        # Patch the module-level client so _require_gemini_ready returns True
        # and the actual generation path raises with the sentinel.
        with patch.object(llm_mod, "_gemini_client", fake_client), \
             patch.object(llm_mod, "GEMINI_AVAILABLE", True), \
             patch.object(llm_mod, "_gemini_model_name", "gemini-flash"), \
             patch("hushh_mcp.operons.kai.llm.types", MagicMock()):
            frames = asyncio.run(_collect(stream_gemini_response(
                prompt="analyze AAPL",
                agent_name="bull",
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames, "Expected at least one error frame"

        for frame in error_frames:
            msg = frame.get("message", "")
            assert sentinel not in msg, (
                f"Internal exception detail leaked into error frame: {msg!r}"
            )

    def test_error_frame_has_static_message(self) -> None:
        """Error frame message must be the approved static string."""
        from hushh_mcp.operons.kai import llm as llm_mod
        from hushh_mcp.operons.kai.llm import stream_gemini_response

        fake_client = MagicMock()
        fake_client.aio.models.generate_content_stream = AsyncMock(
            side_effect=RuntimeError("some internal failure")
        )

        with patch.object(llm_mod, "_gemini_client", fake_client), \
             patch.object(llm_mod, "GEMINI_AVAILABLE", True), \
             patch.object(llm_mod, "_gemini_model_name", "gemini-flash"), \
             patch("hushh_mcp.operons.kai.llm.types", MagicMock()):
            frames = asyncio.run(_collect(stream_gemini_response(
                prompt="analyze AAPL",
                agent_name="bear",
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames
        assert error_frames[0]["message"] == "Streaming analysis encountered an internal error."

    def test_gemini_unavailable_message_is_generic(self) -> None:
        """When Gemini client is not ready, the error message must be static, not the internal reason."""
        from hushh_mcp.operons.kai import llm as llm_mod
        from hushh_mcp.operons.kai.llm import stream_gemini_response

        sentinel = "SENTINEL_UNAVAIL_REASON_init_failed_7x2"

        with patch.object(llm_mod, "_gemini_unavailable_reason", sentinel), \
             patch("hushh_mcp.operons.kai.llm._require_gemini_ready", return_value=False):
            frames = asyncio.run(_collect(stream_gemini_response(
                prompt="analyze AAPL",
                agent_name="bull",
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames, "Expected an error frame when Gemini is unavailable"
        for frame in error_frames:
            assert sentinel not in frame.get("message", ""), (
                f"Internal unavailable reason leaked: {frame!r}"
            )
        assert error_frames[0]["message"] == "The analysis service is temporarily unavailable."


# ---------------------------------------------------------------------------
# analyze_fundamental_streaming - consent reason leak (CWE-209)
# ---------------------------------------------------------------------------


class TestAnalyzeFundamentalStreamingConsentLeak:
    """validate_token reason must not appear in yielded error frames."""

    def test_consent_reason_not_in_error_payload(self) -> None:
        """Sentinel consent-failure reason must not leak into error frame."""
        from hushh_mcp.operons.kai.llm import analyze_fundamental_streaming

        sentinel = "SENTINEL_CONSENT_REASON_abc123"

        with patch(
            "hushh_mcp.operons.kai.llm.validate_token",
            return_value=(False, sentinel, None),
        ):
            frames = asyncio.run(_collect(analyze_fundamental_streaming(
                ticker="AAPL",
                user_id="user-test",
                consent_token="bad-token",  # noqa: S106
                sec_data={},
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames, "Expected an error frame on consent failure"

        for frame in error_frames:
            msg = frame.get("message", "")
            assert sentinel not in msg, (
                f"Consent failure reason leaked into error frame: {msg!r}"
            )

    def test_consent_error_static_message(self) -> None:
        """Consent error frame must use the approved static message."""
        from hushh_mcp.operons.kai.llm import analyze_fundamental_streaming

        with patch(
            "hushh_mcp.operons.kai.llm.validate_token",
            return_value=(False, "token expired", None),
        ):
            frames = asyncio.run(_collect(analyze_fundamental_streaming(
                ticker="AAPL",
                user_id="user-test",
                consent_token="expired",  # noqa: S106
                sec_data={},
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames
        assert (
            error_frames[0]["message"]
            == "Consent token is invalid or insufficient for this operation."
        )


# ---------------------------------------------------------------------------
# analyze_fundamental_streaming - Gemini unavailable reason leak (CWE-209)
# ---------------------------------------------------------------------------


class TestAnalyzeFundamentalStreamingGeminiLeak:
    """Internal Gemini-unavailable reason must not appear in yielded error frames."""

    def test_gemini_unavailable_reason_not_leaked(self) -> None:
        """Sentinel Gemini reason must not appear in error frame."""
        from hushh_mcp.operons.kai import llm as llm_mod
        from hushh_mcp.operons.kai.llm import analyze_fundamental_streaming

        sentinel = "SENTINEL_GEMINI_INIT_REASON_7x2q"

        with patch(
            "hushh_mcp.operons.kai.llm.validate_token",
            return_value=(True, None, MagicMock()),
        ), patch(
            "hushh_mcp.operons.kai.llm._require_gemini_ready",
            return_value=False,
        ), patch.object(llm_mod, "_gemini_unavailable_reason", sentinel):
            frames = asyncio.run(_collect(analyze_fundamental_streaming(
                ticker="TSLA",
                user_id="user-test",
                consent_token="good-token",  # noqa: S106
                sec_data={},
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames, "Expected an error frame when Gemini is unavailable"

        for frame in error_frames:
            msg = frame.get("message", "")
            assert sentinel not in msg, (
                f"Gemini unavailable reason leaked into error frame: {msg!r}"
            )

    def test_gemini_unavailable_static_message(self) -> None:
        """Gemini-unavailable error frame must use the approved static message."""
        from hushh_mcp.operons.kai import llm as llm_mod
        from hushh_mcp.operons.kai.llm import analyze_fundamental_streaming

        with patch(
            "hushh_mcp.operons.kai.llm.validate_token",
            return_value=(True, None, MagicMock()),
        ), patch(
            "hushh_mcp.operons.kai.llm._require_gemini_ready",
            return_value=False,
        ), patch.object(llm_mod, "_gemini_unavailable_reason", "api key invalid"):
            frames = asyncio.run(_collect(analyze_fundamental_streaming(
                ticker="TSLA",
                user_id="user-test",
                consent_token="good-token",  # noqa: S106
                sec_data={},
            )))

        error_frames = [f for f in frames if f.get("type") == "error"]
        assert error_frames
        assert (
            error_frames[0]["message"]
            == "The analysis service is temporarily unavailable."
        )
