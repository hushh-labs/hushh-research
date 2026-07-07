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
        self.upserted = None
        self.on_conflict = None
        self.eqs: list[tuple] = []
        self.neqs: list[tuple] = []
        self.order_called = False
        self.limit_value = None

    def insert(self, payload):
        self.inserted = payload
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


_VALID_ENVELOPE = {
    "ciphertext": "ct",
    "iv": "iv",
    "senderEphemeralPublicKeyJwk": {"kty": "EC", "crv": "P-256"},
    "recipientKeyId": "buyer-key-1",
    "algorithm": "ECDH-P256-AES256-GCM",
}


async def test_approve_request_with_envelope_stores_delivery():
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "buyer_user_id": "buyer",
        "slice_label": "Insurance",
        "status": "approved",
        # The fake reuses this row as the insert RETURNING result too, so give it
        # the envelope columns a real INSERT ... RETURNING would echo back.
        "request_id": "req-1",
        "recipient_key_id": "buyer-key-1",
        "ciphertext": "ct",
        "iv": "iv",
        "sender_ephemeral_public_key_jwk": {"kty": "EC"},
    }
    svc, fake = _service_with([row])

    result = await svc.approve_request(
        owner_user_id="owner", request_id="req-1", envelope=dict(_VALID_ENVELOPE)
    )

    assert result["ok"] is True
    assert result["request"]["status"] == "approved"
    # A sealed envelope was persisted, ciphertext-only, keyed to the request/buyer.
    assert result["envelope"]["ciphertext"] == "ct"
    assert fake.query.inserted["request_id"] == "req-1"
    assert fake.query.inserted["buyer_user_id"] == "buyer"
    assert fake.query.inserted["recipient_key_id"] == "buyer-key-1"
    assert fake.query.inserted["ciphertext"] == "ct"
    assert "slice_label" not in fake.query.inserted  # no plaintext slice ever stored
    # The request is pointed at its latest delivered envelope.
    assert fake.query.updated == {"latest_envelope_id": "req-1"}


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


async def test_approve_request_without_buyer_skips_delivery():
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "slice_label": "Insurance",
        "status": "approved",
    }  # no buyer_user_id (e.g. a labeled brand request)
    svc, fake = _service_with([row])

    result = await svc.approve_request(
        owner_user_id="owner", request_id="req-1", envelope=dict(_VALID_ENVELOPE)
    )

    assert result["ok"] is True
    assert "envelope" not in result
    assert fake.query.inserted is None


async def test_deliver_envelope_stores_for_already_approved_request():
    # Agent-approval fulfilment: the request is already "approved" (an agent flipped
    # it), and the seller's device now delivers the sealed slice via /deliver.
    row = {
        "id": "req-1",
        "owner_user_id": "owner",
        "buyer_user_id": "buyer",
        "slice_label": "Insurance",
        "status": "approved",
        # The fake reuses this row as the envelope INSERT ... RETURNING result too.
        "request_id": "req-1",
        "recipient_key_id": "buyer-key-1",
        "ciphertext": "ct",
        "iv": "iv",
        "sender_ephemeral_public_key_jwk": {"kty": "EC"},
    }
    svc, fake = _service_with([row])

    result = await svc.deliver_envelope(
        owner_user_id="owner", request_id="req-1", envelope=dict(_VALID_ENVELOPE)
    )

    assert result["ok"] is True
    assert result["envelope"]["ciphertext"] == "ct"
    # Ciphertext-only delivery keyed to the request/buyer; no status flip needed.
    assert fake.query.inserted["request_id"] == "req-1"
    assert fake.query.inserted["buyer_user_id"] == "buyer"
    assert fake.query.inserted["recipient_key_id"] == "buyer-key-1"
    assert "slice_label" not in fake.query.inserted  # no plaintext slice ever stored
    assert fake.query.updated == {"latest_envelope_id": "req-1"}
    # Owner-scoped lookup — never cross-user.
    assert ("owner_user_id", "owner") in fake.query.eqs
    assert ("id", "req-1") in fake.query.eqs


async def test_deliver_envelope_rejects_non_approved_request():
    # A pending request must be approved (by owner or agent) before delivery.
    row = {"id": "req-1", "owner_user_id": "owner", "buyer_user_id": "buyer", "status": "pending"}
    svc, fake = _service_with([row])

    result = await svc.deliver_envelope(
        owner_user_id="owner", request_id="req-1", envelope=dict(_VALID_ENVELOPE)
    )

    assert result["ok"] is False
    assert result["reason"] == "not_approved"
    assert fake.query.inserted is None  # nothing delivered


async def test_deliver_envelope_not_found_when_not_owners():
    svc, fake = _service_with([])

    result = await svc.deliver_envelope(
        owner_user_id="owner", request_id="missing", envelope=dict(_VALID_ENVELOPE)
    )

    assert result["ok"] is False
    assert result["reason"] == "not_found"
    assert fake.query.inserted is None


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


async def test_get_delivered_envelope_returns_request_and_envelope():
    row = {
        "id": "env-1",
        "request_id": "req-1",
        "owner_user_id": "owner",
        "buyer_user_id": "buyer",
        "recipient_key_id": "buyer-key-1",
        "ciphertext": "ct",
        "iv": "iv",
        "sender_ephemeral_public_key_jwk": {"kty": "EC"},
        "slice_label": "Insurance",
        "status": "approved",
    }
    svc, fake = _service_with([row])

    out = await svc.get_delivered_envelope(buyer_user_id="buyer", request_id="req-1")

    assert out is not None
    assert out["request"]["buyerUserId"] == "buyer"
    assert out["envelope"]["ciphertext"] == "ct"
    assert out["envelope"]["requestId"] == "req-1"
    assert ("buyer_user_id", "buyer") in fake.query.eqs


async def test_get_delivered_envelope_none_when_request_not_buyers():
    svc, _ = _service_with([])
    assert await svc.get_delivered_envelope(buyer_user_id="buyer", request_id="x") is None


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


_SAMPLE_JWK = {
    "kty": "EC",
    "crv": "P-256",
    "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
}


async def test_register_recipient_key_rotates_and_upserts_active_key():
    stored = {
        "user_id": "buyer",
        "key_id": "buyer-key-1",
        "public_key_jwk": _SAMPLE_JWK,
        "algorithm": "ECDH-P256-AES256-GCM",
        "created_at": "2026-07-06T00:00:00Z",
    }
    svc, fake = _service_with([stored])

    out = await svc.register_recipient_key(
        user_id="buyer", public_key_jwk=_SAMPLE_JWK, key_id="buyer-key-1"
    )

    assert out["userId"] == "buyer"
    assert out["keyId"] == "buyer-key-1"
    assert out["publicKeyJwk"] == _SAMPLE_JWK
    assert out["algorithm"] == "ECDH-P256-AES256-GCM"
    # Older active keys are rotated (scoped to this user, excluding the new key).
    assert fake.query.updated == {
        "status": "rotated",
        "updated_at": fake.query.updated["updated_at"],
    }
    assert ("user_id", "buyer") in fake.query.eqs
    assert ("status", "active") in fake.query.eqs
    assert ("key_id", "buyer-key-1") in fake.query.neqs
    # The new key is upserted active on the (user_id, key_id) conflict target.
    assert fake.query.on_conflict == "user_id,key_id"
    assert fake.query.upserted["status"] == "active"
    assert fake.query.upserted["revoked_at"] is None


async def test_register_recipient_key_defaults_key_id_to_fingerprint():
    svc, fake = _service_with([])

    await svc.register_recipient_key(user_id="buyer", public_key_jwk=_SAMPLE_JWK)

    # A stable SHA-256 fingerprint stands in when the client omits keyId.
    assert fake.query.upserted["key_id"] == fake.query.upserted["public_key_fingerprint"]
    assert len(fake.query.upserted["key_id"]) == 64


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
