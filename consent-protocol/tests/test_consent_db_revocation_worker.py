from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


class _Response:
    def __init__(self, data):
        self.data = data
        self.count = None


class _Query:
    def __init__(self, responses, filters=None):
        self._responses = responses
        self.filters = filters if filters is not None else []

    def select(self, *_args):
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, list(values)))
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
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
        self.filters: list = []

    def table(self, _name):
        return _Query(self._responses, self.filters)


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


def _requested_row(request_id: str, now_ms: int) -> dict:
    return {
        "request_id": request_id,
        "user_id": "owner-1",
        "agent_id": "one_person:viewer",
        "scope": "attr.identity.legal_name",
        "scope_description": "Legal name",
        "action": "REQUESTED",
        "issued_at": now_ms - 10_000,
        "poll_timeout_at": now_ms - 1_000,
        "expires_at": None,
        "metadata": None,
    }


@pytest.mark.asyncio
async def test_get_timed_out_requests_skips_requests_already_resolved(monkeypatch):
    """A withdrawn, answered, revoked or already timed-out request never gains a TIMEOUT row.

    Before this, only an existing TIMEOUT excluded a request, so a REQUESTED
    row past its deadline whose requester had since cancelled would be timed
    out again, and the cancellation would stop being the request's latest event.
    """
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    service = ConsentDBService()
    fake_db = _FakeDb(
        [
            [
                _requested_row("req-open", now_ms),
                _requested_row("req-cancelled", now_ms),
                _requested_row("req-denied", now_ms),
                _requested_row("req-granted", now_ms),
                _requested_row("req-revoked", now_ms),
                _requested_row("req-timed-out", now_ms),
            ],
            [
                {"request_id": "req-cancelled"},
                {"request_id": "req-denied"},
                {"request_id": "req-granted"},
                {"request_id": "req-revoked"},
                {"request_id": "req-timed-out"},
            ],
        ]
    )
    monkeypatch.setattr(service, "_get_db", lambda: fake_db)

    rows = await service.get_timed_out_requests()

    assert [row["request_id"] for row in rows] == ["req-open"]
    # The resolution lookup asks for every resolving action, not TIMEOUT alone.
    action_filters = [f for f in fake_db.filters if f[0] == "in" and f[1] == "action"]
    assert len(action_filters) == 1
    assert set(action_filters[0][2]) == {
        "CANCELLED",
        "CONSENT_DENIED",
        "CONSENT_GRANTED",
        "REVOKED",
        "TIMEOUT",
    }


@pytest.mark.asyncio
async def test_get_timed_out_requests_keeps_a_request_past_its_deadline_with_no_resolution(
    monkeypatch,
):
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    service = ConsentDBService()
    still_waiting = {**_requested_row("req-waiting", now_ms), "poll_timeout_at": now_ms + 60_000}
    fake_db = _FakeDb([[_requested_row("req-open", now_ms), still_waiting], []])
    monkeypatch.setattr(service, "_get_db", lambda: fake_db)

    rows = await service.get_timed_out_requests()

    assert [row["request_id"] for row in rows] == ["req-open"]
