"""Tests for local stdio auto-fill of connector keypair args in request_consent.

On the local stdio MCP transport, `request_consent` should auto-fill
`connector_public_key`/`connector_key_id`/`connector_wrapping_alg` from the
persisted local keypair (see local_mcp_keypair_service) when the caller omits
them, so the LLM host never has to generate/remember a key. The remote/hosted
transport must keep requiring these fields explicitly (no local trusted
process to hold a key there).
"""

from __future__ import annotations

import json

import pytest

_LOCAL_KEYPAIR_PUBLIC = "bG9jYWwtcHVibGljLWtleS1iYXNlNjQ="
_LOCAL_KEYPAIR_KEY_ID = "local-mcp-abc123def456"


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _CapturingClient:
    """Stand-in httpx.AsyncClient that records the POST body."""

    captured: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, params=None, json=None, timeout=None):  # noqa: A002
        _CapturingClient.captured = {"url": url, "json": json}
        return _FakeResponse(
            200,
            {
                "status": "pending",
                "request_id": "req_test",
                "scope": (json or {}).get("scope"),
                "message": "pending",
            },
        )


@pytest.fixture
def _patched_consent_env(monkeypatch):
    import mcp_modules.tools.consent_tools as ct

    async def _fake_resolve(user_id, **_):
        return user_id, None, None

    monkeypatch.setattr(ct, "resolve_user_identifier_to_uid", _fake_resolve)
    monkeypatch.setattr(ct, "resolve_scope_api", lambda s: "attr.financial.*")
    monkeypatch.setattr(ct, "DEVELOPER_API_ENABLED", True)
    monkeypatch.setattr(ct, "PRODUCTION_MODE", True)
    monkeypatch.setattr(ct, "get_developer_request_query", lambda: {"token": "hdk_demo"})
    monkeypatch.setattr(ct.httpx, "AsyncClient", _CapturingClient)
    _CapturingClient.captured = {}
    return ct


def _fake_local_keypair():
    from types import SimpleNamespace

    return SimpleNamespace(
        public_key_b64=_LOCAL_KEYPAIR_PUBLIC,
        key_id=_LOCAL_KEYPAIR_KEY_ID,
        wrapping_alg="X25519-AES256-GCM",
    )


@pytest.mark.asyncio
async def test_local_stdio_auto_fills_missing_connector_args(_patched_consent_env, monkeypatch):
    ct = _patched_consent_env
    monkeypatch.setattr(ct, "is_local_stdio_transport", lambda: True)
    monkeypatch.setattr(ct, "get_or_create_local_connector_keypair", _fake_local_keypair)

    result = await ct.handle_request_consent({"user_id": "user_123", "scope": "attr.financial.*"})

    sent = _CapturingClient.captured["json"]
    assert sent["connector_public_key"] == _LOCAL_KEYPAIR_PUBLIC
    assert sent["connector_key_id"] == _LOCAL_KEYPAIR_KEY_ID
    assert sent["connector_wrapping_alg"] == "X25519-AES256-GCM"

    payload = json.loads(result[0].text)
    assert payload["status"] == "pending"


@pytest.mark.asyncio
async def test_local_stdio_explicit_args_win_over_local_keypair(_patched_consent_env, monkeypatch):
    ct = _patched_consent_env
    monkeypatch.setattr(ct, "is_local_stdio_transport", lambda: True)
    monkeypatch.setattr(
        ct,
        "get_or_create_local_connector_keypair",
        lambda: (_ for _ in ()).throw(
            AssertionError("should not be called when args are explicit")
        ),
    )

    result = await ct.handle_request_consent(
        {
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "connector_public_key": "ZXhwbGljaXQta2V5",
            "connector_key_id": "explicit_key",
            "connector_wrapping_alg": "X25519-AES256-GCM",
        }
    )

    sent = _CapturingClient.captured["json"]
    assert sent["connector_public_key"] == "ZXhwbGljaXQta2V5"
    assert sent["connector_key_id"] == "explicit_key"

    payload = json.loads(result[0].text)
    assert payload["status"] == "pending"


@pytest.mark.asyncio
async def test_remote_transport_does_not_auto_fill_and_hard_errors(
    _patched_consent_env, monkeypatch
):
    ct = _patched_consent_env
    # Default is_local_stdio_transport() is False; explicitly confirm and
    # ensure the local keypair service is never consulted on remote.
    monkeypatch.setattr(
        ct,
        "get_or_create_local_connector_keypair",
        lambda: (_ for _ in ()).throw(AssertionError("must not be called on remote transport")),
    )

    result = await ct.handle_request_consent({"user_id": "user_123", "scope": "attr.financial.*"})

    payload = json.loads(result[0].text)
    assert payload["status"] == "error"
    assert "connector_public_key" in payload["error"]
    # No outbound API call should have happened since validation failed first.
    assert _CapturingClient.captured == {}
