from __future__ import annotations

import time

import pytest

from hushh_mcp.consent.token import issue_token, validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_db import ConsentDBService


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, table_name: str, response_rows: dict[str, list[dict]]):
        self._table_name = table_name
        self._response_rows = response_rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def in_(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return _FakeResponse(self._response_rows.get(self._table_name, []))


class _FakeSupabase:
    def __init__(self, response_rows: dict[str, list[dict]]):
        self.response_rows = response_rows
        self.requested_tables: list[str] = []

    def table(self, table_name: str):
        self.requested_tables.append(table_name)
        return _FakeQuery(table_name, self.response_rows)


@pytest.mark.asyncio
async def test_internal_vault_owner_tokens_use_internal_ledger(monkeypatch):
    future_ms = int(time.time() * 1000) + 60_000
    fake_supabase = _FakeSupabase(
        {
            "internal_access_events": [
                {
                    "action": "CONSENT_GRANTED",
                    "expires_at": future_ms,
                    "issued_at": future_ms - 1_000,
                }
            ]
        }
    )

    service = ConsentDBService()
    monkeypatch.setattr(service, "_get_supabase", lambda: fake_supabase)

    is_active = await service.is_token_active(
        "user_test",
        ConsentScope.VAULT_OWNER.value,
        agent_id="self",
    )

    assert is_active is True
    assert fake_supabase.requested_tables == ["internal_access_events"]


@pytest.mark.asyncio
async def test_validate_token_with_db_accepts_active_internal_vault_owner_token(monkeypatch):
    future_ms = int(time.time() * 1000) + 60_000
    fake_supabase = _FakeSupabase(
        {
            "internal_access_events": [
                {
                    "action": "CONSENT_GRANTED",
                    "expires_at": future_ms,
                    "issued_at": future_ms - 1_000,
                }
            ]
        }
    )

    monkeypatch.setattr(ConsentDBService, "_get_supabase", lambda self: fake_supabase)

    token = issue_token(
        user_id="user_test",
        agent_id="self",
        scope=ConsentScope.VAULT_OWNER,
    ).token

    valid, reason, token_obj = await validate_token_with_db(token, ConsentScope.VAULT_OWNER)

    assert valid is True
    assert reason is None
    assert token_obj is not None
    assert token_obj.user_id == "user_test"
    assert fake_supabase.requested_tables == ["internal_access_events"]


@pytest.mark.asyncio
async def test_external_tokens_still_use_consent_audit(monkeypatch):
    future_ms = int(time.time() * 1000) + 60_000
    fake_supabase = _FakeSupabase(
        {
            "consent_audit": [
                {
                    "action": "CONSENT_GRANTED",
                    "expires_at": future_ms,
                    "issued_at": future_ms - 1_000,
                }
            ]
        }
    )

    service = ConsentDBService()
    monkeypatch.setattr(service, "_get_supabase", lambda: fake_supabase)

    is_active = await service.is_token_active(
        "user_test",
        ConsentScope.PKM_READ.value,
        agent_id="agent_alpha",
    )

    assert is_active is True
    assert fake_supabase.requested_tables == ["consent_audit"]
