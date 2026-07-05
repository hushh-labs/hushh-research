"""Tests for the anonymized cross-user Buyer directory + cross-account requests.

Injects a fake Supabase client (chainable query stub) and a stub PKM service so
the anonymization, viewer-exclusion, listing resolution, and cross-account
request wiring are covered without a real database.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.marketplace_catalog_service import (
    MarketplaceCatalogService,
    _owner_ref,
)


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Records the chained filters and returns a preset result on execute()."""

    def __init__(self, result):
        self._result = result
        self.eqs: list[tuple] = []
        self.neqs: list[tuple] = []
        self.selected = None

    def select(self, cols):
        self.selected = cols
        return self

    def is_(self, *_a):
        return self

    def neq(self, key, value):
        self.neqs.append((key, value))
        return self

    def eq(self, key, value):
        self.eqs.append((key, value))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        return self._result


class _FakeTable:
    def __init__(self, query):
        self._query = query

    def select(self, cols):
        return self._query.select(cols)


class _FakeDB:
    def __init__(self, result):
        self.query = _FakeQuery(result)

    def table(self, _name):
        return _FakeTable(self.query)


class _StubPkm:
    """Manifest is unavailable -> catalog falls back to preview-derived pricing."""

    async def get_domain_manifest(self, _user_id, _domain):
        return None


def _service_with(rows) -> tuple[MarketplaceCatalogService, _FakeDB]:
    svc = MarketplaceCatalogService(pkm_service=_StubPkm())
    fake = _FakeDB(_FakeResult(rows))
    svc._supabase = fake
    return svc, fake


def _row(**over):
    row = {
        "id": 7,
        "user_id": "owner-A",
        "domain": "personal_data",
        "scope": "personal_data.insurance",
        "scope_handle": "h-ins",
        "top_level_scope_path": "insurance",
        "projection_payload": {
            "label": "Insurance renewal",
            "section": "insurance",
            "presentation": {
                "title": "Insurance renewal",
                "stats": [],
                "groups": [
                    {"kind": "fields", "fields": [{"label": "Carrier", "value": "Acme"}]},
                ],
            },
        },
        "updated_at": "2026-07-05T00:00:00Z",
    }
    row.update(over)
    return row


async def test_list_excludes_viewer_via_neq_and_anonymizes():
    svc, fake = _service_with([_row()])

    listings = await svc.list_available_listings(viewer_user_id="viewer-B")

    # Viewer's own rows are excluded at the query layer.
    assert ("user_id", "viewer-B") in fake.query.neqs
    assert len(listings) == 1
    listing = listings[0]
    # Anonymized: opaque refs only, never the raw owner id or a name.
    assert listing["ownerRef"] == _owner_ref("owner-A")
    assert listing["ownerRef"].startswith("own_")
    assert "owner-A" not in str(listing)
    assert "ownerUserId" not in listing
    assert "userId" not in listing
    assert listing["listingId"] == "7"
    assert listing["label"] == "Insurance renewal"
    assert listing["preview"]["title"] == "Insurance renewal"
    assert listing["suggestedPriceCents"] > 0


async def test_list_drops_viewer_owned_rows_defensively():
    # Even if the DB filter somehow returned a viewer-owned row, code drops it.
    svc, _ = _service_with([_row(user_id="viewer-B"), _row(id=8, user_id="owner-A")])

    listings = await svc.list_available_listings(viewer_user_id="viewer-B")

    assert [item["listingId"] for item in listings] == ["8"]


async def test_resolve_listing_returns_internal_owner_and_price():
    svc, fake = _service_with([_row()])

    resolved = await svc.resolve_listing(listing_id="7")

    assert ("id", 7) in fake.query.eqs
    assert resolved is not None
    # Internal descriptor keeps the real owner (server-side only) for filing.
    assert resolved["ownerUserId"] == "owner-A"
    assert resolved["sliceLabel"] == "Insurance renewal"
    assert resolved["domain"] == "personal_data"
    assert resolved["scopeHandle"] == "h-ins"
    assert resolved["priceCents"] > 0


async def test_resolve_listing_missing_returns_none():
    svc, _ = _service_with([])
    assert await svc.resolve_listing(listing_id="999") is None


async def test_resolve_listing_non_numeric_returns_none():
    svc, _ = _service_with([_row()])
    assert await svc.resolve_listing(listing_id="not-a-number") is None


async def test_owner_ref_is_stable_and_opaque():
    assert _owner_ref("owner-A") == _owner_ref("owner-A")
    assert _owner_ref("owner-A") != _owner_ref("owner-B")
    assert "owner-A" not in _owner_ref("owner-A")


# --- cross-account request endpoint wiring --------------------------------


class _RecordingRequests:
    def __init__(self):
        self.kwargs = None

    async def create_request(self, **kwargs):
        self.kwargs = kwargs
        return {"id": "req-1", "status": "pending", **kwargs}


async def test_request_endpoint_files_cross_account_request(monkeypatch):
    from api.routes.one import marketplace_catalog as mod

    resolved = {
        "ownerUserId": "owner-A",
        "domain": "personal_data",
        "scopeHandle": "h-ins",
        "sliceLabel": "Insurance renewal",
        "priceCents": 250,
        "currency": "USD",
    }

    class _Catalog:
        async def resolve_listing(self, *, listing_id):
            assert listing_id == "7"
            return resolved

    async def _fake_label(buyer_user_id):
        return "Buyer abc123"

    recorder = _RecordingRequests()
    monkeypatch.setattr(mod, "_catalog", lambda: _Catalog())
    monkeypatch.setattr(mod, "_requests", lambda: recorder)
    monkeypatch.setattr(mod, "_buyer_label", _fake_label)

    out = await mod.request_available_listing(listing_id="7", token_data={"user_id": "buyer-B"})

    assert out["request"]["status"] == "pending"
    # Owner is the resolved listing owner; buyer is the caller.
    assert recorder.kwargs["owner_user_id"] == "owner-A"
    assert recorder.kwargs["buyer_user_id"] == "buyer-B"
    assert recorder.kwargs["slice_label"] == "Insurance renewal"
    assert recorder.kwargs["price_cents"] == 250
    # Buyer label is best-effort and never the raw buyer id.
    assert "buyer-B" not in str(recorder.kwargs["buyer_label"])


async def test_request_endpoint_rejects_self_request(monkeypatch):
    from fastapi import HTTPException

    from api.routes.one import marketplace_catalog as mod

    class _Catalog:
        async def resolve_listing(self, *, listing_id):
            return {
                "ownerUserId": "buyer-B",  # same as caller
                "domain": "d",
                "scopeHandle": None,
                "sliceLabel": "s",
                "priceCents": 0,
                "currency": "USD",
            }

    monkeypatch.setattr(mod, "_catalog", lambda: _Catalog())

    with pytest.raises(HTTPException) as exc:
        await mod.request_available_listing(listing_id="7", token_data={"user_id": "buyer-B"})
    assert exc.value.status_code == 400


async def test_request_endpoint_404_when_listing_missing(monkeypatch):
    from fastapi import HTTPException

    from api.routes.one import marketplace_catalog as mod

    class _Catalog:
        async def resolve_listing(self, *, listing_id):
            return None

    monkeypatch.setattr(mod, "_catalog", lambda: _Catalog())

    with pytest.raises(HTTPException) as exc:
        await mod.request_available_listing(listing_id="404", token_data={"user_id": "buyer-B"})
    assert exc.value.status_code == 404
