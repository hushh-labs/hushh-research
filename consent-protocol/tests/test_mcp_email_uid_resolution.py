from __future__ import annotations

import asyncio

from mcp_modules.tools import consent_tools, data_tools


class _FakeResponse:
    status_code = 200

    def json(self):
        return {
            "exists": True,
            "user_id": "s3xmA4lNSAQFrIaOytnSGAOzXlL2",
            "email": "jd77v9k4nx@privaterelay.appleid.com",
            "display_name": "Kai Test User",
        }


class _FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, *, params=None, headers=None, timeout=None):
        self.calls.append(
            {
                "url": url,
                "params": params,
                "headers": headers,
                "timeout": timeout,
            }
        )
        assert url.endswith("/api/user/lookup")
        assert params == {"email": "jd77v9k4nx@privaterelay.appleid.com"}
        assert headers == {"X-MCP-Developer-Token": "dev-token"}
        return _FakeResponse()


def test_consent_tools_resolve_email_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_email_to_uid("jd77v9k4nx@privaterelay.appleid.com")
    )

    assert resolved_uid == "s3xmA4lNSAQFrIaOytnSGAOzXlL2"
    assert email == "jd77v9k4nx@privaterelay.appleid.com"
    assert display_name == "Kai Test User"


def test_data_tools_resolve_email_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(data_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid = asyncio.run(
        data_tools.resolve_email_to_uid("jd77v9k4nx@privaterelay.appleid.com")
    )

    assert resolved_uid == "s3xmA4lNSAQFrIaOytnSGAOzXlL2"
