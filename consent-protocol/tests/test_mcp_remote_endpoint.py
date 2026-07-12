"""Coverage for the remote /mcp ASGI mount (mcp_remote.AuthenticatedRemoteMCPApp).

Before this file, the live `/mcp` ASGI mount had zero automated test
coverage - only a manual UAT ops script
(scripts/uat_kai_regression_smoke.py --scenario mcp_transport/mcp_consent)
exercised it, against a real hosted backend. This file drives the ASGI app
directly (raw scope/receive/send, matching the ASGI callable contract that
`app.mount("/mcp", remote_mcp_app)` relies on) so auth, rate limiting, and
the inner dispatch are protected by CI regardless of environment reachability.
"""

from __future__ import annotations

import asyncio
import json

import pytest

import mcp_remote as mcp_remote_module
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from mcp_remote import AuthenticatedRemoteMCPApp


def _http_scope(
    *, headers: list[tuple[bytes, bytes]] | None = None, query_string: bytes = b""
) -> dict:
    return {
        "type": "http",
        "method": "POST",
        "path": "/mcp/",
        "headers": headers or [],
        "query_string": query_string,
        "client": ("127.0.0.1", 12345),
    }


async def _noop_receive():
    return {"type": "http.request", "body": b"", "more_body": False}


class _CapturingSend:
    def __init__(self):
        self.messages: list[dict] = []

    async def __call__(self, message: dict) -> None:
        self.messages.append(message)

    @property
    def status(self) -> int | None:
        for message in self.messages:
            if message["type"] == "http.response.start":
                return message["status"]
        return None

    @property
    def body_json(self) -> dict | None:
        for message in self.messages:
            if message["type"] == "http.response.body":
                return json.loads(message["body"])
        return None


class _FakeInnerApp:
    """Stand-in for the StreamableHTTPSessionManager-backed inner ASGI app."""

    def __init__(self, *, delay_seconds: float = 0.0):
        self.calls = 0
        self.delay_seconds = delay_seconds

    async def __call__(self, scope, receive, send) -> None:
        self.calls += 1
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b'{"jsonrpc":"2.0"}', "more_body": False})


def _fake_principal(app_id: str = "app_demo_123") -> DeveloperPrincipal:
    return DeveloperPrincipal(
        app_id=app_id,
        agent_id=f"developer:{app_id}",
        display_name="Demo App",
        allowed_tool_groups=("core_consent",),
        contact_email="founder@example.com",
    )


@pytest.fixture(autouse=True)
def _remote_mcp_enabled(monkeypatch):
    monkeypatch.setattr(mcp_remote_module, "remote_mcp_enabled", lambda: True)


@pytest.fixture(autouse=True)
def _fresh_rate_limiter_storage(monkeypatch):
    """Isolate each test's rate-limit window from the module-level storage."""
    from limits.storage import storage_from_string
    from limits.strategies import MovingWindowRateLimiter

    isolated_storage = storage_from_string("memory://")
    monkeypatch.setattr(mcp_remote_module, "_rate_limit_storage", isolated_storage)
    monkeypatch.setattr(
        mcp_remote_module, "_rate_limiter", MovingWindowRateLimiter(isolated_storage)
    )


def _build_app(
    *, inner_app: _FakeInnerApp | None = None
) -> tuple[AuthenticatedRemoteMCPApp, _FakeInnerApp]:
    app = AuthenticatedRemoteMCPApp.__new__(AuthenticatedRemoteMCPApp)
    from hushh_mcp.services.developer_registry_service import DeveloperRegistryService

    app._registry = DeveloperRegistryService()
    fake_inner = inner_app or _FakeInnerApp()
    app._inner = fake_inner
    return app, fake_inner


@pytest.mark.asyncio
async def test_missing_token_returns_401(monkeypatch):
    app, _inner = _build_app()

    send = _CapturingSend()
    await app(_http_scope(), _noop_receive, send)

    assert send.status == 401
    assert send.body_json["error_code"] == "DEVELOPER_TOKEN_REQUIRED"


@pytest.mark.asyncio
async def test_invalid_token_returns_403(monkeypatch):
    app, _inner = _build_app()
    monkeypatch.setattr(app._registry, "authenticate_token", lambda *a, **k: None)

    send = _CapturingSend()
    headers = [(b"authorization", b"Bearer bad-token")]
    await app(_http_scope(headers=headers), _noop_receive, send)

    assert send.status == 403
    assert send.body_json["error_code"] == "DEVELOPER_TOKEN_INVALID"


@pytest.mark.asyncio
async def test_valid_token_dispatches_to_inner_app(monkeypatch):
    app, inner = _build_app()
    monkeypatch.setattr(app._registry, "authenticate_token", lambda *a, **k: _fake_principal())

    send = _CapturingSend()
    headers = [(b"authorization", b"Bearer good-token")]
    await app(_http_scope(headers=headers), _noop_receive, send)

    assert send.status == 200
    assert inner.calls == 1


@pytest.mark.asyncio
async def test_query_token_authentication_is_rejected(monkeypatch):
    app, inner = _build_app()
    monkeypatch.setattr(app._registry, "authenticate_token", lambda *a, **k: _fake_principal())

    send = _CapturingSend()
    await app(_http_scope(query_string=b"token=good-token"), _noop_receive, send)

    assert send.status == 401
    assert send.body_json["error_code"] == "DEVELOPER_TOKEN_REQUIRED"
    assert inner.calls == 0


@pytest.mark.asyncio
async def test_rate_limit_exceeded_returns_429(monkeypatch):
    monkeypatch.setattr(mcp_remote_module, "_MCP_REMOTE_RATE_LIMIT", "2/minute")
    from limits import parse as parse_rate_limit

    monkeypatch.setattr(mcp_remote_module, "_rate_limit_item", parse_rate_limit("2/minute"))

    app, inner = _build_app()
    monkeypatch.setattr(app._registry, "authenticate_token", lambda *a, **k: _fake_principal())
    headers = [(b"authorization", b"Bearer good-token")]

    # First two requests succeed (within the 2/minute limit).
    for _ in range(2):
        send = _CapturingSend()
        await app(_http_scope(headers=headers), _noop_receive, send)
        assert send.status == 200

    # Third request in the same window is rate limited.
    send = _CapturingSend()
    await app(_http_scope(headers=headers), _noop_receive, send)
    assert send.status == 429
    assert send.body_json["error_code"] == "RATE_LIMIT_EXCEEDED"
    assert inner.calls == 2


@pytest.mark.asyncio
async def test_rate_limit_is_scoped_per_app_id(monkeypatch):
    """One noisy developer app must not exhaust another app's quota."""
    monkeypatch.setattr(mcp_remote_module, "_MCP_REMOTE_RATE_LIMIT", "1/minute")
    from limits import parse as parse_rate_limit

    monkeypatch.setattr(mcp_remote_module, "_rate_limit_item", parse_rate_limit("1/minute"))

    principals = {
        "token-a": _fake_principal("app_a"),
        "token-b": _fake_principal("app_b"),
    }

    app, inner = _build_app()

    def _authenticate(raw_token, **kwargs):
        return principals.get(raw_token)

    monkeypatch.setattr(app._registry, "authenticate_token", _authenticate)

    send_a1 = _CapturingSend()
    await app(_http_scope(headers=[(b"authorization", b"Bearer token-a")]), _noop_receive, send_a1)
    assert send_a1.status == 200

    # app_a is now rate limited, but app_b should be unaffected.
    send_a2 = _CapturingSend()
    await app(_http_scope(headers=[(b"authorization", b"Bearer token-a")]), _noop_receive, send_a2)
    assert send_a2.status == 429

    send_b1 = _CapturingSend()
    await app(_http_scope(headers=[(b"authorization", b"Bearer token-b")]), _noop_receive, send_b1)
    assert send_b1.status == 200
    assert inner.calls == 2


@pytest.mark.asyncio
async def test_request_timeout_returns_504(monkeypatch):
    monkeypatch.setattr(mcp_remote_module, "_MCP_REMOTE_REQUEST_TIMEOUT_SECONDS", 0.01)

    app, _inner = _build_app(inner_app=_FakeInnerApp(delay_seconds=1.0))
    monkeypatch.setattr(app._registry, "authenticate_token", lambda *a, **k: _fake_principal())

    send = _CapturingSend()
    headers = [(b"authorization", b"Bearer good-token")]
    await app(_http_scope(headers=headers), _noop_receive, send)

    assert send.status == 504
    assert send.body_json["error_code"] == "REQUEST_TIMEOUT"


@pytest.mark.asyncio
async def test_remote_mcp_disabled_returns_404(monkeypatch):
    monkeypatch.setattr(mcp_remote_module, "remote_mcp_enabled", lambda: False)
    app, _inner = _build_app()

    send = _CapturingSend()
    await app(_http_scope(), _noop_receive, send)

    assert send.status == 404
