"""Regression tests - CWE-209 in api/routes/kai/stream.py agent error frames.

The fundamental, sentiment, and valuation agent exception handlers previously
yielded str(e) directly into SSE agent_error events, and the top-level handler
yielded str(e) in the terminal error event. These tests verify that internal
exception detail no longer reaches SSE consumers.

Attach point: api/routes/kai/stream.py::analyze_stream_generator
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import router as kai_router

# ---------------------------------------------------------------------------
# Minimal app fixture -- same pattern as test_kai_auth_matrix.py in CI manifest.
# stream.py uses a module-level _require_vault_owner_token (not a FastAPI Depends),
# so auth is bypassed by patching that function directly.
# ---------------------------------------------------------------------------

_FAKE_CONSENT_TOKEN = "fake-consent-token-stream-leak"  # noqa: S105


@pytest.fixture(scope="module")
def kai_app() -> FastAPI:
    app = FastAPI()
    app.include_router(kai_router)
    return app


def _auth_patch():
    """Context manager that bypasses auth and audit-log DB calls in the stream route."""
    async def _stub_auth(*, user_id: str, authorization: str | None) -> str:  # noqa: ARG001
        return _FAKE_CONSENT_TOKEN

    async def _stub_log(*_a, **_kw) -> int:  # noqa: ARG001
        return 0

    from contextlib import ExitStack
    stack = ExitStack()
    stack.enter_context(
        patch("api.routes.kai.stream._require_vault_owner_token", side_effect=_stub_auth)
    )
    stack.enter_context(
        patch("hushh_mcp.services.consent_db.ConsentDBService.log_operation", new=_stub_log)
    )
    return stack


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sse_frames(raw_body: bytes) -> list[dict]:
    """Parse raw SSE bytes into a list of data dicts (skips non-data lines)."""
    frames = []
    for line in raw_body.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if not payload:
                continue
            try:
                frames.append(json.loads(payload))
            except json.JSONDecodeError:
                pass
    return frames


# ---------------------------------------------------------------------------
# Test: agent error frames must not contain str(e)
# ---------------------------------------------------------------------------


class TestAgentErrorFrameDoesNotLeakException:
    """sentinel exception text must not appear in agent_error SSE frames."""

    @pytest.mark.parametrize(
        "agent_cls_path, agent_name",
        [
            ("api.routes.kai.stream.FundamentalAgent", "fundamental"),
            ("api.routes.kai.stream.SentimentAgent", "sentiment"),
            ("api.routes.kai.stream.ValuationAgent", "valuation"),
        ],
    )
    def test_agent_error_no_sentinel(
        self, kai_app: FastAPI, agent_cls_path: str, agent_name: str
    ) -> None:
        sentinel = f"SENTINEL_{agent_name.upper()}_INTERNAL_DETAIL_kq8w"

        fake_agent = MagicMock()
        fake_agent.analyze = AsyncMock(side_effect=RuntimeError(sentinel))
        fake_cls = MagicMock(return_value=fake_agent)

        with _auth_patch(), patch(agent_cls_path, fake_cls):
            client = TestClient(kai_app, raise_server_exceptions=False)
            resp = client.get(
                "/api/kai/analyze/stream",
                params={
                    "ticker": "AAPL",
                    "user_id": "u-stream-test",
                    "consent_token": _FAKE_CONSENT_TOKEN,
                    "risk_profile": "balanced",
                },
                headers={"Accept": "text/event-stream"},
                timeout=30,
            )

        assert sentinel not in resp.text, (
            f"Internal exception detail for {agent_name} agent leaked into SSE response"
        )


# ---------------------------------------------------------------------------
# Test: top-level ANALYZE_STREAM_FAILED must not leak str(e)
# ---------------------------------------------------------------------------


class TestTopLevelStreamFailedNoLeak:
    """ANALYZE_STREAM_FAILED terminal error must not expose exception detail."""

    def test_stream_failed_no_sentinel(self, kai_app: FastAPI) -> None:
        sentinel = "SENTINEL_TOPLEVEL_STREAM_INTERNAL_9yz"

        with _auth_patch(), patch(
            "api.routes.kai.stream._resolve_symbol_eligibility",
            side_effect=RuntimeError(sentinel),
        ):
            client = TestClient(kai_app, raise_server_exceptions=False)
            resp = client.get(
                "/api/kai/analyze/stream",
                params={
                    "ticker": "AAPL",
                    "user_id": "u-stream-test",
                    "consent_token": _FAKE_CONSENT_TOKEN,
                    "risk_profile": "balanced",
                },
                headers={"Accept": "text/event-stream"},
                timeout=30,
            )

        assert sentinel not in resp.text, (
            "Internal exception detail leaked into ANALYZE_STREAM_FAILED SSE event"
        )

    def test_stream_failed_static_message(self, kai_app: FastAPI) -> None:
        """Terminal error message must be the approved static string."""
        with _auth_patch(), patch(
            "api.routes.kai.stream._resolve_symbol_eligibility",
            side_effect=RuntimeError("some internal crash"),
        ):
            client = TestClient(kai_app, raise_server_exceptions=False)
            resp = client.get(
                "/api/kai/analyze/stream",
                params={
                    "ticker": "AAPL",
                    "user_id": "u-stream-test",
                    "consent_token": _FAKE_CONSENT_TOKEN,
                    "risk_profile": "balanced",
                },
                headers={"Accept": "text/event-stream"},
                timeout=30,
            )

        frames = _sse_frames(resp.content)
        error_frames = [
            f for f in frames
            if (f.get("payload") or {}).get("code") == "ANALYZE_STREAM_FAILED"
        ]
        assert error_frames, "Expected ANALYZE_STREAM_FAILED terminal frame"
        msg = error_frames[0].get("payload", {}).get("message", "")
        assert msg == "Analysis failed. Please try again."
