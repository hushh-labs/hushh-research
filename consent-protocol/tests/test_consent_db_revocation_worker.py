from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, responses):
        self._responses = responses

    def select(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        return _Response(self._responses.pop(0))


class _FakeDb:
    def __init__(self, responses):
        self._responses = responses

    def table(self, _name):
        return _Query(self._responses)


@pytest.mark.asyncio
async def test_fetch_expired_consents_uses_only_the_latest_external_grant(monkeypatch):
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    service = ConsentDBService()
    monkeypatch.setattr(
        service,
        "_get_db",
        lambda: _FakeDb(
            [
                [
                    {
                        "id": "revoked-newer",
                        "token_id": "token-1",
                        "user_id": "user-1",
                        "agent_id": "partner",
                        "scope": "profile.read",
                        "action": "REVOKED",
                        "issued_at": now_ms,
                        "expires_at": now_ms - 1,
                    },
                    {
                        "id": "expired-old",
                        "token_id": "token-1",
                        "user_id": "user-1",
                        "agent_id": "partner",
                        "scope": "profile.read",
                        "action": "CONSENT_GRANTED",
                        "issued_at": now_ms - 10,
                        "expires_at": now_ms - 1,
                    },
                    {
                        "id": "expired-current",
                        "token_id": "token-2",
                        "user_id": "user-2",
                        "agent_id": "partner",
                        "scope": "profile.read",
                        "action": "CONSENT_GRANTED",
                        "issued_at": now_ms - 5,
                        "expires_at": now_ms - 1,
                    },
                ]
            ]
        ),
    )

    expired = await service.fetch_expired_consents()

    assert [record.consent_id for record in expired] == ["expired-current"]


@pytest.mark.asyncio
async def test_mark_consent_revoked_appends_only_when_the_expired_grant_is_current(
    monkeypatch,
):
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    record = {
        "id": "expired-current",
        "token_id": "token-2",
        "request_id": "request-2",
        "user_id": "user-2",
        "agent_id": "partner",
        "scope": "profile.read",
        "scope_description": "Profile",
        "action": "CONSENT_GRANTED",
        "issued_at": now_ms - 5,
        "expires_at": now_ms - 1,
    }
    service = ConsentDBService()
    monkeypatch.setattr(
        service,
        "_get_db",
        lambda: _FakeDb([[record], [record]]),
    )
    inserted = []

    async def capture_insert(**kwargs):
        inserted.append(kwargs)
        return 1

    monkeypatch.setattr(service, "insert_event", capture_insert)

    await service.mark_consent_revoked("expired-current")

    assert inserted == [
        {
            "user_id": "user-2",
            "agent_id": "partner",
            "scope": "profile.read",
            "action": "REVOKED",
            "token_id": "token-2",
            "request_id": "request-2",
            "scope_description": "Profile",
            "expires_at": now_ms - 1,
            "metadata": {"reason": "expired", "source": "consent_revocation_worker"},
        }
    ]
