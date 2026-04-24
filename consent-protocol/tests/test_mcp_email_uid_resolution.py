from __future__ import annotations

import asyncio

from mcp_modules.tools import consent_tools, data_tools


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload

    def json(self):
        return self._payload


class _FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, *, params=None, headers=None, timeout=None):
        identifier = (params or {}).get("identifier")
        self.calls.append(
            {
                "url": url,
                "params": params,
                "headers": headers,
                "timeout": timeout,
            }
        )
        assert url.endswith("/api/user/lookup")
        assert headers == {"X-MCP-Developer-Token": "dev-token"}

        if identifier == "jd77v9k4nx@privaterelay.appleid.com":
            return _FakeResponse(
                {
                    "exists": True,
                    "user_id": "s3xmA4lNSAQFrIaOytnSGAOzXlL2",
                    "email": "jd77v9k4nx@privaterelay.appleid.com",
                    "display_name": "Kai Test User",
                }
            )

        if identifier == "+16505550101":
            return _FakeResponse(
                {
                    "exists": True,
                    "user_id": "phoneUid1234567890abcdef",
                    "email": "phone@example.com",
                    "phone_number": "+16505550101",
                    "display_name": "Phone Test User",
                }
            )

        if identifier == "+12012419368":
            return _FakeResponse(
                {
                    "exists": True,
                    "user_id": "usNationalUid1234567890",
                    "email": "us-national@example.com",
                    "phone_number": "+12012419368",
                    "display_name": "US National Test User",
                }
            )

        raise AssertionError(f"Unexpected lookup params: {params}")


def test_consent_tools_resolve_email_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_email_to_uid("jd77v9k4nx@privaterelay.appleid.com")
    )

    assert resolved_uid == "s3xmA4lNSAQFrIaOytnSGAOzXlL2"
    assert email == "jd77v9k4nx@privaterelay.appleid.com"
    assert display_name == "Kai Test User"


def test_consent_tools_resolve_phone_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_user_identifier_to_uid("+1 (650) 555-0101")
    )

    assert resolved_uid == "phoneUid1234567890abcdef"
    assert email == "phone@example.com"
    assert display_name == "Phone Test User"


def test_data_tools_resolve_email_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid = asyncio.run(
        data_tools.resolve_email_to_uid("jd77v9k4nx@privaterelay.appleid.com")
    )

    assert resolved_uid == "s3xmA4lNSAQFrIaOytnSGAOzXlL2"


def test_data_tools_resolve_phone_to_uid_uses_header_token(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid = asyncio.run(data_tools.resolve_user_identifier_to_uid("+16505550101"))

    assert resolved_uid == "phoneUid1234567890abcdef"


def test_consent_tools_do_not_resolve_national_phone_without_country_hint(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_user_identifier_to_uid("2012419368")
    )

    assert resolved_uid == "2012419368"
    assert email is None
    assert display_name is None


def test_consent_tools_resolve_national_phone_with_country_hint(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_user_identifier_to_uid("2012419368", country_iso2="US")
    )

    assert resolved_uid == "usNationalUid1234567890"
    assert email == "us-national@example.com"
    assert display_name == "US National Test User"


def test_consent_tools_resolve_country_prefixed_phone(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_user_identifier_to_uid("US 2012419368")
    )

    assert resolved_uid == "usNationalUid1234567890"
    assert email == "us-national@example.com"
    assert display_name == "US National Test User"


def test_consent_tools_resolve_national_phone_with_country_name(monkeypatch):
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(consent_tools.httpx, "AsyncClient", _FakeAsyncClient)

    resolved_uid, email, display_name = asyncio.run(
        consent_tools.resolve_user_identifier_to_uid("2012419368", country="United States")
    )

    assert resolved_uid == "usNationalUid1234567890"
    assert email == "us-national@example.com"
    assert display_name == "US National Test User"
