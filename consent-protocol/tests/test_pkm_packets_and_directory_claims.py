"""PKM packets and White Pages listing claims.

Covers the trust boundaries: a packet is never listed without contents and a
price, a claim needs a verified phone, and the public lookup shows only
verified claims' for-sale packet names and prices, never a user id or contents.
"""

from __future__ import annotations

import inspect
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.middlewares.rate_limit import limiter
from api.routes import white_pages_public
from api.routes.one import directory_claims, pkm_packets
from db.db_client import JsonParam
from hushh_mcp.services.directory_claim_service import ClaimError, DirectoryClaimService
from hushh_mcp.services.pkm_packet_service import PacketValidationError, PkmPacketService


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Applies eq/in_ filters to an in-memory table so behaviour is real."""

    def __init__(self, store: list[dict]):
        self.store = store
        self.op = "select"
        self.payload = None
        self.filters: list = []
        self.limit_n = None

    def select(self, *_a):
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, k, v):
        self.filters.append(lambda r, k=k, v=v: r.get(k) == v)
        return self

    def in_(self, k, vs):
        self.filters.append(lambda r, k=k, vs=tuple(vs): r.get(k) in vs)
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def _match(self):
        return [r for r in self.store if all(f(r) for f in self.filters)]

    def execute(self):
        if self.op == "insert":
            row = {k: (v.value if isinstance(v, JsonParam) else v) for k, v in self.payload.items()}
            row = {"id": str(uuid.uuid4()), "created_at": "2026-10-02", **row}
            self.store.append(row)
            return _Result([row])
        rows = self._match()
        if self.op == "update":
            for r in rows:
                r.update(
                    {
                        k: (v.value if isinstance(v, JsonParam) else v)
                        for k, v in self.payload.items()
                    }
                )
        if self.op == "delete":
            for r in rows:
                self.store.remove(r)
        return _Result(rows[: self.limit_n] if self.limit_n else rows)


class _DB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}

    def table(self, name):
        return _Query(self.tables.setdefault(name, []))


@pytest.fixture
def db():
    return _DB()


@pytest.fixture
def packets(db):
    svc = PkmPacketService()
    svc._db = db
    return svc


@pytest.fixture
def claims(db):
    svc = DirectoryClaimService()
    svc._db = db
    return svc


BANK = [{"domain": "financial", "scopeHandle": "financial.accounts", "label": "Accounts"}]


# --- packets ---------------------------------------------------------------


async def test_standard_packet_takes_catalogue_title_and_is_not_for_sale_by_default(packets):
    p = await packets.create_packet(owner_user_id="u1", body={"kind": "bank_statements"})
    assert p["title"] == "Bank statements"
    assert p["forSale"] is False


async def test_packet_cannot_be_listed_without_contents_and_price(packets):
    with pytest.raises(PacketValidationError):
        await packets.create_packet(owner_user_id="u1", body={"kind": "lifestyle", "forSale": True})
    with pytest.raises(PacketValidationError):
        await packets.create_packet(
            owner_user_id="u1",
            body={"kind": "lifestyle", "contents": BANK, "priceCents": 500, "forSale": True},
        )
    ok = await packets.create_packet(
        owner_user_id="u1",
        body={
            "kind": "lifestyle",
            "contents": BANK,
            "priceCents": 500,
            "creditCost": 2,
            "forSale": True,
        },
    )
    assert ok["forSale"] is True


async def test_standard_kind_once_per_owner_custom_unlimited(packets):
    await packets.create_packet(owner_user_id="u1", body={"kind": "tax_documents"})
    with pytest.raises(PacketValidationError):
        await packets.create_packet(owner_user_id="u1", body={"kind": "tax_documents"})
    await packets.create_packet(owner_user_id="u1", body={"kind": "custom", "title": "Recipes"})
    await packets.create_packet(owner_user_id="u1", body={"kind": "custom", "title": "Running"})
    assert len(await packets.list_packets(owner_user_id="u1")) == 3


async def test_price_floor_and_owner_scoping(packets):
    with pytest.raises(PacketValidationError):
        await packets.create_packet(
            owner_user_id="u1", body={"kind": "insurance", "priceCents": 10}
        )
    p = await packets.create_packet(owner_user_id="u1", body={"kind": "insurance"})
    assert (
        await packets.update_packet(owner_user_id="u2", packet_id=p["id"], body={"title": "x"})
        is None
    )
    assert await packets.delete_packet(owner_user_id="u2", packet_id=p["id"]) is False


# --- claims ----------------------------------------------------------------


async def test_claim_is_pending_idempotent_and_one_per_person(claims):
    c = await claims.create_claim(
        user_id="u1", listing_id="npi1-1234567890", listing_name="Ada Lovelace"
    )
    assert c["status"] == "pending"
    again = await claims.create_claim(
        user_id="u1", listing_id="npi1-1234567890", listing_name="Ada Lovelace"
    )
    assert again["id"] == c["id"]
    with pytest.raises(ClaimError):
        await claims.create_claim(
            user_id="u1", listing_id="roster-tx-1", listing_name="Someone Else"
        )


async def test_verified_listing_cannot_be_claimed_again(claims):
    c = await claims.create_claim(
        user_id="u1", listing_id="roster-tx-77", listing_name="A Producer"
    )
    await claims.resolve_claim(claim_id=c["id"], verified=True)
    with pytest.raises(ClaimError) as exc:
        await claims.create_claim(
            user_id="u2", listing_id="roster-tx-77", listing_name="A Producer"
        )
    assert exc.value.code == "LISTING_ALREADY_VERIFIED"


async def test_bad_listing_id_rejected(claims):
    with pytest.raises(ClaimError):
        await claims.create_claim(user_id="u1", listing_id="../etc/passwd", listing_name="x")


# --- routes ----------------------------------------------------------------


def _app(db, monkeypatch, *, phone_verified=True, uid="u1"):
    def packet_svc():
        s = PkmPacketService()
        s._db = db
        return s

    def claim_svc():
        s = DirectoryClaimService()
        s._db = db
        return s

    monkeypatch.setattr(pkm_packets, "_service", packet_svc)
    monkeypatch.setattr(directory_claims, "_service", claim_svc)
    monkeypatch.setattr(white_pages_public, "_packets", packet_svc)
    monkeypatch.setattr(white_pages_public, "_claims", claim_svc)

    class _Identities:
        async def sync_from_firebase(self, *_a, **_k):
            return None

        async def get_many(self, ids):
            return {i: {"phone_verified": phone_verified} for i in ids}

    monkeypatch.setattr(directory_claims, "ActorIdentityService", _Identities)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    for r in (pkm_packets.router, directory_claims.router, white_pages_public.router):
        app.include_router(r)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": uid}
    app.dependency_overrides[require_firebase_auth] = lambda: uid
    return TestClient(app)


def test_claim_requires_verified_phone(db, monkeypatch):
    client = _app(db, monkeypatch, phone_verified=False)
    r = client.post("/api/one/directory-claims", json={"listingId": "npi1-1", "listingName": "Ada"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "VERIFIED_PHONE_REQUIRED"
    assert db.tables.get("directory_listing_claims", []) == []


def test_public_lookup_shows_only_verified_for_sale_packets_and_no_ids(db, monkeypatch):
    client = _app(db, monkeypatch)
    client.post(
        "/api/one/packets",
        json={
            "kind": "bank_statements",
            "contents": BANK,
            "priceCents": 300,
            "creditCost": 3,
            "forSale": True,
        },
    )
    client.post("/api/one/packets", json={"kind": "tax_documents"})  # not for sale
    claim = client.post(
        "/api/one/directory-claims", json={"listingId": "npi1-42", "listingName": "Ada"}
    ).json()

    # Pending: nothing public yet.
    pending = client.post(
        "/api/public/white-pages/listings", json={"listingIds": ["npi1-42", "npi1-99"]}
    )
    assert pending.json() == {"listings": {}}

    db.tables["directory_listing_claims"][0]["status"] = "verified"
    body = client.post(
        "/api/public/white-pages/listings", json={"listingIds": ["npi1-42", "npi1-99"]}
    ).json()
    assert list(body["listings"]) == ["npi1-42"]
    listing = body["listings"]["npi1-42"]
    assert [p["title"] for p in listing["packets"]] == ["Bank statements"]
    assert listing["packets"][0]["priceCents"] == 300
    flat = repr(body)
    assert "u1" not in flat and "contents" not in flat and claim["claim"]["id"] not in flat


def test_public_lookup_is_rate_limited():
    src = inspect.getsource(white_pages_public.lookup_listings)
    assert "limiter.shared_limit" in src
