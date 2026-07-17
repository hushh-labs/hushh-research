# tests/test_sse_token_pii_redaction.py
"""PII redaction tests for SSE lifecycle logs.

Verifies that user_id is not written to log records during the SSE
event generator lifecycle by driving the FastAPI endpoint via TestClient.
"""

from __future__ import annotations

import asyncio
import logging
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import sse

_SENTINEL_USER_ID = "uid_SENTINEL_12345"


class _CapturingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def all_messages(self) -> list[str]:
        return [self.format(r) for r in self.records]

    def combined(self) -> str:
        return " ".join(self.all_messages())


def _attach(logger_name: str) -> _CapturingHandler:
    handler = _CapturingHandler()
    lg = logging.getLogger(logger_name)
    lg.setLevel(logging.DEBUG)
    lg.addHandler(handler)
    return handler


def _detach(logger_name: str) -> None:
    lg = logging.getLogger(logger_name)
    lg.handlers = [h for h in lg.handlers if not isinstance(h, _CapturingHandler)]


def _build_sse_app() -> FastAPI:
    app = FastAPI()
    app.include_router(sse.router)
    return app


class TestSseGeneratorLogRedaction:
    """SSE open/disconnect lifecycle logs must not contain the raw user_id."""

    def teardown_method(self, _m: object) -> None:
        _detach("api.routes.sse")

    def _run_generator_via_client(self) -> None:
        q: asyncio.Queue = asyncio.Queue()
        app = _build_sse_app()
        client = TestClient(app)

        with (
            patch("api.routes.sse._ensure_consent_sse_enabled", return_value=None),
            patch("api.routes.sse._authorize_sse_user", return_value=None),
            patch("api.consent_listener.get_consent_queue", return_value=q),
            patch(
                "hushh_mcp.services.consent_db.ConsentDBService.get_recent_consent_events",
                new=AsyncMock(return_value=[]),
            ),
            patch("fastapi.Request.is_disconnected", new=AsyncMock(return_value=True)),
        ):
            with client.stream("GET", f"/api/consent/events/{_SENTINEL_USER_ID}") as response:
                assert response.status_code == 200
                for _line in response.iter_lines():
                    break

    def test_open_log_does_not_contain_sentinel_user_id(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_via_client()
        assert _SENTINEL_USER_ID not in handler.combined(), (
            f"Raw user_id found in SSE open log: {handler.combined()[:400]}"
        )

    def test_disconnected_log_does_not_contain_sentinel_user_id(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_via_client()
        for msg in handler.all_messages():
            if "disconnected" in msg:
                assert _SENTINEL_USER_ID not in msg, (
                    f"Raw user_id in disconnected log: {msg!r}"
                )

    def test_logs_use_redacted_placeholder(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_via_client()
        assert any("[redacted]" in m for m in handler.all_messages()), (
            "No [redacted] placeholder found in SSE logs -- redaction may not be applied."
        )

    def test_no_sentinel_in_any_log_record(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_via_client()
        assert _SENTINEL_USER_ID not in handler.combined(), (
            f"PII sentinel found in SSE log output: {handler.combined()[:400]}"
        )


class TestSseGeneratorCancelledLogRedaction:
    """Cancelled SSE lifecycle log must not contain the raw user_id."""

    def teardown_method(self, _m: object) -> None:
        _detach("api.routes.sse")

    def _run_generator_with_cancel_via_client(self) -> None:
        q: asyncio.Queue = asyncio.Queue()
        app = _build_sse_app()
        client = TestClient(app)

        async def _raise_cancelled(*args, **kwargs) -> bool:
            raise asyncio.CancelledError

        with (
            patch("api.routes.sse._ensure_consent_sse_enabled", return_value=None),
            patch("api.routes.sse._authorize_sse_user", return_value=None),
            patch("api.consent_listener.get_consent_queue", return_value=q),
            patch(
                "hushh_mcp.services.consent_db.ConsentDBService.get_recent_consent_events",
                new=AsyncMock(return_value=[]),
            ),
            patch("fastapi.Request.is_disconnected", new=_raise_cancelled),
        ):
            with client.stream("GET", f"/api/consent/events/{_SENTINEL_USER_ID}") as response:
                try:
                    for _line in response.iter_lines():
                        pass
                except (asyncio.CancelledError, Exception):
                    pass

    def test_cancelled_log_does_not_contain_sentinel_user_id(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_with_cancel_via_client()
        assert _SENTINEL_USER_ID not in handler.combined(), (
            f"Raw user_id in cancelled log: {handler.combined()[:400]}"
        )


class TestSseGeneratorErrorLogRedaction:
    """Generic exception path lifecycle log must not contain the raw user_id."""

    def teardown_method(self, _m: object) -> None:
        _detach("api.routes.sse")

    def _run_generator_with_error_via_client(self) -> None:
        q: asyncio.Queue = asyncio.Queue()
        app = _build_sse_app()
        client = TestClient(app)

        with (
            patch("api.routes.sse._ensure_consent_sse_enabled", return_value=None),
            patch("api.routes.sse._authorize_sse_user", return_value=None),
            patch("api.consent_listener.get_consent_queue", return_value=q),
            patch(
                "hushh_mcp.services.consent_db.ConsentDBService.get_recent_consent_events",
                new=AsyncMock(side_effect=RuntimeError("db connection lost")),
            ),
        ):
            try:
                with client.stream("GET", f"/api/consent/events/{_SENTINEL_USER_ID}") as response:
                    for _line in response.iter_lines():
                        pass
            except BaseException:
                pass

    def test_error_log_does_not_contain_sentinel_user_id(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_with_error_via_client()
        assert _SENTINEL_USER_ID not in handler.combined(), (
            f"Raw user_id in error log: {handler.combined()[:400]}"
        )

    def test_error_log_uses_redacted_placeholder(self) -> None:
        handler = _attach("api.routes.sse")
        self._run_generator_with_error_via_client()
        error_messages = [m for m in handler.all_messages() if "consent_sse.error" in m]
        assert error_messages, "Expected a consent_sse.error log record"
        assert any("[redacted]" in m for m in error_messages), (
            f"No [redacted] placeholder in error log: {error_messages}"
        )
