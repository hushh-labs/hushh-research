"""
Regression tests for CWE-209 fix in losers.py SSE optimize stream error payload.

CWE-209 -- Information Exposure Through Error Messages:
  analyze_portfolio_losers_stream yielded {"message": str(e)} in the
  OPTIMIZE_STREAM_FAILED terminal SSE event, exposing internal runtime errors
  directly to clients.

Attach point:
  POST /api/kai/portfolio/analyze-losers/stream  (losers.py)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from api.routes.kai.losers import AnalyzeLosersRequest, analyze_portfolio_losers_stream

_SENTINEL = "INTERNAL_SECRET_zP3mQw7nRk_LEAK_MARKER"


class TestLosersOptimizeStreamExceptionLeak:
    """analyze_portfolio_losers_stream must not echo exc detail in SSE error event."""

    def test_stream_error_does_not_echo_exception_detail(self):
        token_data = {
            "user_id": "user_test",
            "token": "fake-consent-token",
        }

        request = AnalyzeLosersRequest(
            user_id="user_test",
            holdings=[],
        )

        raw_frames: list[str] = []

        async def _collect():
            with patch(
                "api.routes.kai.losers._build_optimization_context",
                new_callable=AsyncMock,
                side_effect=RuntimeError(_SENTINEL),
            ):
                response = await analyze_portfolio_losers_stream(
                    request=request,
                    raw_request=None,
                    token_data=token_data,
                )
                async for chunk in response.body_iterator:
                    if isinstance(chunk, bytes):
                        raw_frames.append(chunk.decode())
                    else:
                        raw_frames.append(str(chunk))

        asyncio.run(_collect())

        combined = "\n".join(raw_frames)
        assert _SENTINEL not in combined, (
            f"Internal exception detail leaked into optimize SSE stream: {combined!r}"
        )
        assert "OPTIMIZE_STREAM_FAILED" in combined or "error" in combined
