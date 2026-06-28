"""Regression test: handle_check_consent_status must log httpx.ConnectError.

mcp_modules/tools/consent_tools.py::handle_check_consent_status had a bare
except httpx.ConnectError block with no logger call, so an unreachable
consent backend left zero server side trace of the failure. Its sibling
function handle_request_consent already logs the same exception type.
"""

from __future__ import annotations

import httpx
import pytest


class _RaisingClient:
    """Stand-in httpx.AsyncClient whose get() raises httpx.ConnectError."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, *args, **kwargs):
        raise httpx.ConnectError("Connection refused")


@pytest.fixture
def _patched_consent_env(monkeypatch):
    import mcp_modules.tools.consent_tools as ct

    async def _fake_resolve(user_id, **_):
        return user_id, None, None

    monkeypatch.setattr(ct, "resolve_user_identifier_to_uid", _fake_resolve)
    monkeypatch.setattr(ct, "DEVELOPER_API_ENABLED", True)
    monkeypatch.setattr(ct, "get_developer_request_query", lambda: {"token": "hdk_demo"})
    monkeypatch.setattr(ct.httpx, "AsyncClient", _RaisingClient)
    return ct


@pytest.mark.asyncio
async def test_connect_error_is_logged(_patched_consent_env, monkeypatch):
    ct = _patched_consent_env

    calls = []
    monkeypatch.setattr(ct.logger, "error", lambda *args, **kwargs: calls.append(args))

    await ct.handle_check_consent_status({"user_id": "user-abc"})

    assert len(calls) == 1, "logger.error must be called exactly once when the backend is unreachable"
    logged_text = " ".join(str(a) for a in calls[0])
    assert "Connection refused" in logged_text, "the ConnectError instance must reach the log call"


@pytest.mark.asyncio
async def test_connect_error_response_unchanged(_patched_consent_env):
    ct = _patched_consent_env

    result = await ct.handle_check_consent_status({"user_id": "user-abc"})

    import json

    body = json.loads(result[0].text)
    assert body["status"] == "error"
    assert body["error"] == "Cannot connect to consent backend"
    assert "hint" in body
