"""Shared public MCP HTTP and envelope fixtures; no real identity or payment authority."""

from __future__ import annotations

import json
from typing import Any

import pytest

from hushh_mcp.consent.export_envelope import canonical_aad_bytes, digest_bytes
from mcp_modules.tools import public_tools_v3 as tools


class _Response:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self) -> dict[str, Any]:
        return self._payload


class _Client:
    def __init__(self, response: _Response, calls: list[dict[str, Any]]) -> None:
        self.response = response
        self.calls = calls

    async def __aenter__(self) -> _Client:
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def get(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return self.response

    async def post(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append({"method": "POST", "url": url, **kwargs})
        return self.response


def _install_client(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
    calls: list[dict[str, Any]],
    status_code: int = 200,
) -> None:
    monkeypatch.setattr(
        tools.httpx,
        "AsyncClient",
        lambda **_kwargs: _Client(_Response(payload, status_code), calls),
    )
    monkeypatch.setattr(tools, "get_developer_api_headers", lambda: {"Authorization": "Bearer x"})


def _payload(result: tuple[Any, dict[str, Any]]) -> dict[str, Any]:
    content, structured = result
    assert json.loads(content[0].text) == structured
    return structured


def _hosted_crypto() -> dict[str, Any]:
    export_id = "e" * 32
    aad = {
        "version": 2,
        "app_id": "public-app-ref",
        "grant_id": "req_0123456789abcdef0123456789ab",
        "export_id": export_id,
        "revision": 2,
        "machine_scope": "attr.financial.portfolio.*",
        "scope_handle": "s_0123456789abcdef0123456789abcdef",
        "recipient_key_fingerprint": "sha256:" + "1" * 64,
        "payload_algorithm": "AES-256-GCM",
        "expires_at_ms": 9999999999999,
    }
    return {
        "iv": "aXY=",
        "tag": "dGFn",
        "wrapped_key_bundle": {
            "wrapped_export_key": "d3JhcHBlZA==",
            "wrapped_key_iv": "aXY=",
            "wrapped_key_tag": "dGFn",
            "sender_public_key": "cHVibGlj",
            "wrapping_alg": "X25519-AES256-GCM",
            "connector_key_id": "connector-1",
            "consent_token": "must-not-pass-through",
        },
        "export_envelope": {
            "version": 2,
            "export_id": export_id,
            "aad": aad,
            "aad_sha256": digest_bytes(canonical_aad_bytes(aad)),
            "ciphertext_sha256": "sha256:" + "2" * 64,
            "ciphertext_bytes": 128,
        },
    }
