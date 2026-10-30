"""Tests for durable marketplace access-request persistence.

Injects a fake Cloud SQL client (chainable query stub) so the shaping and the
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
        self.deleted = False
        self.updated = None
        self.upserted = None
        self.on_conflict = None
        self.eqs: list[tuple] = []
        self.neqs: list[tuple] = []
        self.order_called = False
        self.limit_value = None

    def insert(self, payload):
        self.inserted = payload
        return self

    def delete(self):
        self.deleted = True
        return self

    def select(self, *_a):
        return self

    def update(self, payload):
        self.updated = payload
        return self

    def upsert(self, payload, on_conflict=None):
        self.upserted = payload
        self.on_conflict = on_conflict
        return self

    def eq(self, key, value):
        self.eqs.append((key, value))
        return self

    def neq(self, key, value):
        self.neqs.append((key, value))
        return self

    def order(self, *_a, **_k):
        self.order_called = True
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def execute(self):
        return self._result


class _FakeTable:
    def __init__(self, query):
        self._query = query

    def insert(self, payload):
        return self._query.insert(payload)

    def delete(self):
        return self._query.delete()

    def select(self, *a):
        return self._query.select(*a)

    def update(self, payload):
        return self._query.update(payload)

    def upsert(self, payload, on_conflict=None):
        return self._query.upsert(payload, on_conflict=on_conflict)


class _FakeDB:
    def __init__(self, result):
        self.query = _FakeQuery(result)

    def table(self, _name):
        return _FakeTable(self.query)


def _service_with(result_data) -> tuple[MarketplaceRequestService, _FakeDB]:
    svc = MarketplaceRequestService()
    fake = _FakeDB(_FakeResult(result_data))
    svc._db = fake
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


async def test_approve_request_rejects_malformed_envelope_before_status_flip():
    svc, fake = _service_with([])

    for bad in (
        {},
        {"ciphertext": "x"},
        {"ciphertext": "x", "iv": "y", "senderEphemeralPublicKeyJwk": {}},
    ):
        try:
            await svc.approve_request(owner_user_id="owner", request_id="req-1", envelope=bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")
    # Validation happens before the resolve, so nothing was ever flipped to approved.
    assert fake.query.updated is None


async def test_deliver_envelope_rejects_malformed_envelope():
    svc, fake = _service_with([])

    for bad in (
        {},
        {"ciphertext": "x"},
        {"ciphertext": "x", "iv": "y", "senderEphemeralPublicKeyJwk": {}},
    ):
        try:
            await svc.deliver_envelope(owner_user_id="owner", request_id="req-1", envelope=bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")
    # Validation happens before any DB read/write.
    assert fake.query.inserted is None


async def test_list_buyer_requests_scopes_by_buyer():
    rows = [{"id": "a", "buyer_user_id": "buyer", "slice_label": "One", "status": "approved"}]
    svc, fake = _service_with(rows)

    out = await svc.list_buyer_requests(buyer_user_id="buyer", status="approved")

    assert [r["id"] for r in out] == ["a"]
    assert ("buyer_user_id", "buyer") in fake.query.eqs
    assert ("status", "approved") in fake.query.eqs


async def test_get_request_recipient_key_owner_scoped():
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "buyer_user_id": "buyer",
        "slice_label": "Insurance",
        "status": "pending",
        "user_id": "buyer",
        "key_id": "buyer-key-1",
        "public_key_jwk": _SAMPLE_JWK,
        "algorithm": "ECDH-P256-AES256-GCM",
    }
    svc, fake = _service_with([row])

    out = await svc.get_request_recipient_key(owner_user_id="owner", request_id="req-1")

    assert out is not None
    assert out["request"]["buyerUserId"] == "buyer"
    assert out["recipientKey"]["keyId"] == "buyer-key-1"
    assert ("owner_user_id", "owner") in fake.query.eqs

    svc_none, _ = _service_with([])
    assert await svc_none.get_request_recipient_key(owner_user_id="owner", request_id="x") is None


async def test_deny_request_marks_denied():
    row = {"id": "req-1", "owner_user_id": "owner", "slice_label": "Insurance", "status": "denied"}
    svc, fake = _service_with([row])

    result = await svc.deny_request(owner_user_id="owner", request_id="req-1")

    assert result["ok"] is True
    assert fake.query.updated["status"] == "denied"


async def test_register_recipient_key_rejects_invalid_jwk():
    svc, _ = _service_with([])

    for bad in (None, {}, {"crv": "P-256"}):
        try:
            await svc.register_recipient_key(user_id="buyer", public_key_jwk=bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")


async def test_get_recipient_key_returns_active_or_none():
    stored = {
        "user_id": "buyer",
        "key_id": "buyer-key-1",
        "public_key_jwk": _SAMPLE_JWK,
        "algorithm": "ECDH-P256-AES256-GCM",
    }
    svc, fake = _service_with([stored])

    out = await svc.get_recipient_key(user_id="buyer")
    assert out["keyId"] == "buyer-key-1"
    assert ("status", "active") in fake.query.eqs
    assert fake.query.limit_value == 1

    svc_none, _ = _service_with([])
    assert await svc_none.get_recipient_key(user_id="buyer") is None


_SAMPLE_JWK = {"kty": "EC", "crv": "P-256", "x": "public_x", "y": "public_y"}
