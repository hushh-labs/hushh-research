"""
Regression tests for ConsentDBService consent-center reads.

Canonical attach points:
    hushh_mcp.services.consent_db.ConsentDBService.get_pending_requests
    hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens
    hushh_mcp.services.consent_db.ConsentDBService.get_audit_log
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


class _FakeResponse:
    def __init__(self, data=None):
        self.data = data or []


class _FakeTable:
    def __init__(self, rows: list[dict], calls: list[tuple]):
        self._rows = rows
        self._calls = calls
        self._selected = "*"
        self._filters: list[tuple[str, str, object]] = []
        self._limit: int | None = None
        self._offset = 0

    def select(self, selected="*", **kwargs):
        self._selected = selected
        self._calls.append(("select", selected, kwargs))
        return self

    def eq(self, key, value):
        self._filters.append(("eq", key, value))
        self._calls.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self._filters.append(("in", key, list(values)))
        self._calls.append(("in", key, list(values)))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, value):
        self._limit = value
        return self

    def offset(self, value):
        self._offset = value
        return self

    def execute(self):
        rows = list(self._rows)
        for kind, key, value in self._filters:
            if kind == "eq":
                rows = [row for row in rows if row.get(key) == value]
            elif kind == "in":
                allowed = set(value)
                rows = [row for row in rows if row.get(key) in allowed]
        if self._limit is not None:
            rows = rows[self._offset : self._offset + self._limit]
        elif self._offset:
            rows = rows[self._offset :]
        return _FakeResponse(rows)


class _FakeSupabase:
    def __init__(self, rows: list[dict], calls: list[tuple]):
        self._rows = rows
        self._calls = calls

    def table(self, name):
        if name == "internal_access_events":
            return _FakeTable([], self._calls)
        assert name == "consent_audit"
        return _FakeTable(self._rows, self._calls)


def _service(rows: list[dict], calls: list[tuple], monkeypatch) -> ConsentDBService:
    service = ConsentDBService()
    monkeypatch.setattr(service, "_get_supabase", lambda: _FakeSupabase(rows, calls))
    return service


class TestConsentCenterDbReads:
    @pytest.mark.asyncio
    async def test_pending_requests_accept_alias_user_ids(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "REQUESTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 200,
                "poll_timeout_at": None,
            },
            {
                "id": "row_2",
                "user_id": "other",
                "request_id": "req_other",
                "action": "REQUESTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 100,
                "poll_timeout_at": None,
            },
        ]
        service = _service(rows, calls, monkeypatch)

        result = await service.get_pending_requests(
            "firebase_uid",
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert [item["id"] for item in result] == ["req_alias"]
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls

    @pytest.mark.asyncio
    async def test_pending_request_lookup_accepts_alias_user_ids(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "REQUESTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "scope_description": "Identity",
                "issued_at": 200,
                "poll_timeout_at": None,
            },
            {
                "id": "row_2",
                "user_id": "other",
                "request_id": "req_alias",
                "action": "REQUESTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 100,
                "poll_timeout_at": None,
            },
        ]
        service = _service(rows, calls, monkeypatch)

        result = await service.get_pending_by_request_id(
            "firebase_uid",
            "req_alias",
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert result is not None
        assert result["request_id"] == "req_alias"
        assert result["user_id"] == "alias@example.com"
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls

    @pytest.mark.asyncio
    async def test_mark_pending_request_opened_accepts_alias_user_ids(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "REQUESTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "scope_description": "Identity",
                "issued_at": 200,
                "poll_timeout_at": None,
            }
        ]
        service = _service(rows, calls, monkeypatch)
        inserted: list[dict] = []

        async def _insert_event(**kwargs):
            inserted.append(kwargs)
            return "event_1"

        monkeypatch.setattr(service, "insert_event", _insert_event)

        result = await service.mark_pending_request_opened(
            user_id="firebase_uid",
            request_id="req_alias",
            opened_via="review",
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert result == {"request_id": "req_alias", "bundle_id": None}
        assert inserted[0]["user_id"] == "alias@example.com"
        assert inserted[0]["action"] == "NOTIFICATION_OPENED"
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls

    @pytest.mark.asyncio
    async def test_active_tokens_accept_alias_user_ids(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 200,
                "expires_at": None,
            },
            {
                "id": "row_2",
                "user_id": "other",
                "request_id": "req_other",
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 100,
                "expires_at": None,
            },
        ]
        service = _service(rows, calls, monkeypatch)

        result = await service.get_active_tokens(
            "firebase_uid",
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert [item["request_id"] for item in result] == ["req_alias"]
        assert result[0]["user_id"] == "alias@example.com"
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls

    @pytest.mark.asyncio
    async def test_covering_token_helpers_accept_alias_user_ids(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 200,
                "expires_at": None,
            }
        ]
        service = _service(rows, calls, monkeypatch)

        covering = await service.find_covering_active_token(
            "firebase_uid",
            requested_scope="attr.identity.*",
            agent_id="developer:test",
            user_ids=["firebase_uid", "alias@example.com"],
        )
        superseded = await service.get_superseded_active_tokens(
            "firebase_uid",
            requested_scope="pkm.read",
            agent_id="developer:test",
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert covering is not None
        assert covering["user_id"] == "alias@example.com"
        assert [token["user_id"] for token in superseded] == ["alias@example.com"]
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls

    @pytest.mark.asyncio
    async def test_audit_log_counts_external_rows_without_not_operator(self, monkeypatch):
        calls: list[tuple] = []
        rows = [
            {
                "id": "row_1",
                "user_id": "alias@example.com",
                "request_id": "req_alias",
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 200,
            },
            {
                "id": "row_2",
                "user_id": "alias@example.com",
                "request_id": "req_internal",
                "action": "NOTIFICATION_OPENED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 150,
            },
            {
                "id": "row_3",
                "user_id": "other",
                "request_id": "req_other",
                "action": "CONSENT_GRANTED",
                "agent_id": "developer:test",
                "scope": "attr.identity.*",
                "issued_at": 100,
            },
        ]
        service = _service(rows, calls, monkeypatch)

        result = await service.get_audit_log(
            "firebase_uid",
            page=1,
            limit=20,
            user_ids=["firebase_uid", "alias@example.com"],
        )

        assert result["total"] == 1
        assert [item["request_id"] for item in result["items"]] == ["req_alias"]
        assert not any(call[0] == "not_" for call in calls)
        assert ("in", "user_id", ["firebase_uid", "alias@example.com"]) in calls
