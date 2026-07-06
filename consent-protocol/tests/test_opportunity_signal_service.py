"""Tests for durable opportunity-signal persistence.

Injects a fake Supabase client (chainable query stub) so shaping, idempotent
re-derivation, owner-scoped lifecycle, and the due-now logic are covered without a
real database. Unlike the marketplace-request stub, this one queues a result per
execute() because the service issues several queries per call (find-by-dedupe then
insert/update; list_due does expire + select + per-row show_count bumps).
"""

from __future__ import annotations

from datetime import UTC, datetime

from hushh_mcp.services.opportunity_signal_service import (
    OpportunitySignalService,
    _start_of_next_day,
)


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Chainable stub; records the call shape and pops the next queued result."""

    def __init__(self, db):
        self._db = db
        self.inserted = None
        self.updated = None
        self.eqs: list[tuple] = []
        self.ins: list[tuple] = []
        self.lts: list[tuple] = []

    def insert(self, payload):
        self.inserted = payload
        return self

    def select(self, *_a):
        return self

    def update(self, payload):
        self.updated = payload
        return self

    def eq(self, key, value):
        self.eqs.append((key, value))
        return self

    def in_(self, key, values):
        self.ins.append((key, tuple(values)))
        return self

    def lt(self, key, value):
        self.lts.append((key, value))
        return self

    def limit(self, *_a):
        return self

    def order(self, *_a, **_k):
        return self

    def execute(self):
        self._db.calls.append(self)
        return self._db.next_result()


class _FakeTable:
    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        query = _FakeQuery(self._db)
        return getattr(query, name)


class _FakeDB:
    def __init__(self, results):
        self._results = list(results)
        self.calls: list[_FakeQuery] = []

    def next_result(self):
        return self._results.pop(0) if self._results else _FakeResult([])

    def table(self, _name):
        return _FakeTable(self)


def _service_with(*results) -> tuple[OpportunitySignalService, _FakeDB]:
    svc = OpportunitySignalService()
    fake = _FakeDB([_FakeResult(r) for r in results])
    svc._supabase = fake
    return svc, fake


async def test_create_new_signal_inserts_and_shapes():
    # 1st query: find_by_dedupe (none) → 2nd: insert returns the row.
    row = {
        "id": "sig-1",
        "user_id": "owner",
        "kind": "intent",
        "domain": "travel",
        "scope_handle": "h1",
        "title": "List your travel intent",
        "suggested_price_cents": 120,
        "currency": "USD",
        "source": "derived",
        "status": "active",
        "dedupe_key": "derived:intent:travel:h1",
        "show_count": 0,
        "metadata": {"topLevelScopePath": "travel.intent"},
    }
    svc, fake = _service_with([], [row])

    out = await svc.create_signal(
        user_id="owner",
        kind="intent",
        domain="travel",
        title="List your travel intent",
        dedupe_key="derived:intent:travel:h1",
        scope_handle="h1",
        suggested_price_cents=120,
        metadata={"topLevelScopePath": "travel.intent"},
    )

    assert out["id"] == "sig-1"
    assert out["kind"] == "intent"
    assert out["suggestedPriceCents"] == 120
    assert out["metadata"]["topLevelScopePath"] == "travel.intent"
    # Second call was the insert with status active.
    assert fake.calls[1].inserted["status"] == "active"
    assert fake.calls[1].inserted["dedupe_key"] == "derived:intent:travel:h1"


async def test_create_refreshes_existing_active_signal():
    existing = {
        "id": "sig-1",
        "user_id": "owner",
        "status": "active",
        "dedupe_key": "k",
        "title": "old",
    }
    updated = {**existing, "title": "new", "suggested_price_cents": 200}
    # find_by_dedupe → existing active; then update returns refreshed row.
    svc, fake = _service_with([existing], [updated])

    out = await svc.create_signal(
        user_id="owner",
        kind="intent",
        domain="travel",
        title="new",
        dedupe_key="k",
        suggested_price_cents=200,
    )

    assert out["title"] == "new"
    assert out["suggestedPriceCents"] == 200
    # It was an update (guarded to still-active), not a second insert.
    assert fake.calls[1].updated["title"] == "new"
    assert ("status", "active") in fake.calls[1].eqs


async def test_create_does_not_resurrect_dismissed_signal():
    existing = {
        "id": "sig-1",
        "user_id": "owner",
        "status": "dismissed",
        "dedupe_key": "k",
        "title": "old",
    }
    svc, fake = _service_with([existing])  # only the find query runs

    out = await svc.create_signal(
        user_id="owner",
        kind="intent",
        domain="travel",
        title="new",
        dedupe_key="k",
    )

    assert out["status"] == "dismissed"
    assert out["title"] == "old"  # untouched
    assert len(fake.calls) == 1  # no insert/update issued


async def test_list_due_returns_active_and_elapsed_snoozed_only():
    now = datetime(2026, 7, 5, 12, 0, tzinfo=UTC)
    rows = [
        {"id": "a", "user_id": "o", "status": "active", "show_count": 0},
        {
            "id": "b",
            "user_id": "o",
            "status": "snoozed",
            "snoozed_until": "2026-07-04T00:00:00+00:00",  # elapsed
            "show_count": 1,
        },
        {
            "id": "c",
            "user_id": "o",
            "status": "snoozed",
            "snoozed_until": "2026-07-06T00:00:00+00:00",  # still snoozed
            "show_count": 0,
        },
    ]
    # 1st query: expire_past update (no rows). 2nd: the select. Then per-due-row bumps.
    svc, _ = _service_with([], rows, [], [])

    out = await svc.list_due(user_id="o", now=now)

    ids = {r["id"] for r in out}
    assert ids == {"a", "b"}  # c is still snoozed into the future


async def test_snooze_defaults_to_start_of_tomorrow():
    now = datetime(2026, 7, 5, 15, 30, tzinfo=UTC)
    row = {"id": "sig-1", "user_id": "o", "status": "snoozed"}
    svc, fake = _service_with([row])

    result = await svc.snooze(user_id="o", signal_id="sig-1", now=now)

    assert result["ok"] is True
    expected = _start_of_next_day(now).isoformat()
    assert fake.calls[0].updated["snoozed_until"] == expected
    assert fake.calls[0].updated["status"] == "snoozed"
    assert ("user_id", "o") in fake.calls[0].eqs


async def test_dismiss_and_publish_are_owner_scoped():
    row = {"id": "sig-1", "user_id": "o", "status": "dismissed"}
    svc, fake = _service_with([row])
    result = await svc.dismiss(user_id="o", signal_id="sig-1")
    assert result["ok"] is True
    assert fake.calls[0].updated["status"] == "dismissed"
    assert ("user_id", "o") in fake.calls[0].eqs

    row2 = {"id": "sig-1", "user_id": "o", "status": "published"}
    svc2, fake2 = _service_with([row2])
    result2 = await svc2.mark_published(user_id="o", signal_id="sig-1")
    assert result2["ok"] is True
    assert fake2.calls[0].updated["status"] == "published"


async def test_owner_update_not_found_returns_not_ok():
    svc, _ = _service_with([])  # no row matched
    result = await svc.dismiss(user_id="o", signal_id="missing")
    assert result["ok"] is False
    assert result["reason"] == "not_found"
