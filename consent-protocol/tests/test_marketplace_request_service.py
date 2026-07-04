"""Tests for durable marketplace access-request persistence.

Injects a fake Supabase client (chainable query stub) so the shaping and the
owner-scoped resolve logic are covered without a real database.
"""

from __future__ import annotations

from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Records the chained call and returns a preset result on execute()."""

    def __init__(self, result):
        self._result = result
        self.inserted = None
        self.updated = None
        self.eqs: list[tuple] = []
        self.order_called = False

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

    def order(self, *_a, **_k):
        self.order_called = True
        return self

    def execute(self):
        return self._result


class _FakeTable:
    def __init__(self, query):
        self._query = query

    def insert(self, payload):
        return self._query.insert(payload)

    def select(self, *a):
        return self._query.select(*a)

    def update(self, payload):
        return self._query.update(payload)


class _FakeDB:
    def __init__(self, result):
        self.query = _FakeQuery(result)

    def table(self, _name):
        return _FakeTable(self.query)


def _service_with(result_data) -> tuple[MarketplaceRequestService, _FakeDB]:
    svc = MarketplaceRequestService()
    fake = _FakeDB(_FakeResult(result_data))
    svc._supabase = fake
    return svc, fake


async def test_create_request_shapes_row_to_contract():
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "buyer_label": "Acme",
        "domain": "personal_data",
        "scope_handle": "h1",
        "slice_label": "Insurance",
        "price_cents": 55,
        "currency": "USD",
        "duration_days": 30,
        "status": "pending",
    }
    svc, fake = _service_with([row])

    out = await svc.create_request(
        owner_user_id="owner",
        slice_label="Insurance",
        domain="personal_data",
        scope_handle="h1",
        buyer_label="Acme",
        price_cents=55,
    )

    assert out["id"] == "req-1"
    assert out["sliceName"] == "Insurance"
    assert out["priceCents"] == 55
    assert out["status"] == "pending"
    # The insert payload defaulted status to pending.
    assert fake.query.inserted["status"] == "pending"


async def test_list_requests_filters_by_status_and_shapes():
    rows = [
        {"id": "a", "owner_user_id": "owner", "slice_label": "One", "status": "pending"},
        {"id": "b", "owner_user_id": "owner", "slice_label": "Two", "status": "pending"},
    ]
    svc, fake = _service_with(rows)

    out = await svc.list_requests(owner_user_id="owner", status="pending")

    assert [r["id"] for r in out] == ["a", "b"]
    assert [r["sliceName"] for r in out] == ["One", "Two"]
    assert ("owner_user_id", "owner") in fake.query.eqs
    assert ("status", "pending") in fake.query.eqs


async def test_approve_request_ok_when_pending_row_updated():
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "slice_label": "Insurance",
        "status": "approved",
    }
    svc, fake = _service_with([row])

    result = await svc.approve_request(owner_user_id="owner", request_id="req-1")

    assert result["ok"] is True
    assert result["request"]["status"] == "approved"
    # Owner-scoped, pending-only, id-matched update.
    assert fake.query.updated["status"] == "approved"
    assert ("owner_user_id", "owner") in fake.query.eqs
    assert ("id", "req-1") in fake.query.eqs
    assert ("status", "pending") in fake.query.eqs


async def test_approve_request_not_ok_when_no_row_matched():
    svc, _ = _service_with([])  # no pending row owned by this user

    result = await svc.approve_request(owner_user_id="owner", request_id="missing")

    assert result["ok"] is False
    assert result["reason"] == "not_found_or_not_pending"


async def test_deny_request_marks_denied():
    row = {"id": "req-1", "owner_user_id": "owner", "slice_label": "Insurance", "status": "denied"}
    svc, fake = _service_with([row])

    result = await svc.deny_request(owner_user_id="owner", request_id="req-1")

    assert result["ok"] is True
    assert fake.query.updated["status"] == "denied"
