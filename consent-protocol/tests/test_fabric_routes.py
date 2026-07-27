"""Tests for the Preference Subscription Fabric (grants, receipts, subscriber read).

Route tests mock the service layer (no DB); the full DB-backed grant -> read ->
revoke -> chain-verify flow is exercised against a real Postgres in
scripts/smoke (see PR notes). Scope-registry and receipt-hash tests are pure.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import fabric
from hushh_mcp.services import fabric_receipts_service as receipts_mod
from hushh_mcp.services.fabric_receipts_service import FabricReceiptsService
from hushh_mcp.services.fabric_scope_registry import project_fields, resolve_fields

_UID = "owner-uid-1"
_SUBSCRIBER = "developer:acme-rialabs"


# ---------------------------------------------------------------------------
# Scope registry (pure, fail-closed)
# ---------------------------------------------------------------------------


def test_resolve_fields_maps_known_scope():
    fields, unmapped = resolve_fields(["wants.money.advisor"])
    assert fields == ["connect.want", "connect.zip"]
    assert unmapped == []


def test_resolve_fields_is_fail_closed_for_unknown_scope():
    fields, unmapped = resolve_fields(["favorites.secret-unmodelled"])
    assert fields == []
    assert unmapped == ["favorites.secret-unmodelled"]


def test_resolve_fields_dedupes_across_scopes():
    fields, _ = resolve_fields(["wants.money.advisor", "wants.financial-services"])
    assert fields == ["connect.want", "connect.zip"]


def test_project_fields_returns_only_present_paths():
    doc = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1}}
    out = project_fields(doc, ["connect.want", "connect.zip", "connect.missing"])
    assert out == {"connect.want": "wants.money.advisor", "connect.zip": "98033"}


# ---------------------------------------------------------------------------
# Receipt hashing (pure, deterministic + chain-linked)
# ---------------------------------------------------------------------------


def test_receipt_hash_is_deterministic_and_chains():
    payload = receipts_mod._canonical_payload(
        user_id=_UID,
        seq=1,
        event_type="GRANT",
        subscriber_id=_SUBSCRIBER,
        grant_id="g1",
        scopes=["wants.money.advisor"],
        fields=["connect.want"],
        purpose="local match",
        created_at_ms=1000,
        metadata={},
    )
    h1 = receipts_mod._chain_hash(receipts_mod.GENESIS_HASH, payload)
    h1_again = receipts_mod._chain_hash(receipts_mod.GENESIS_HASH, payload)
    assert h1 == h1_again  # deterministic
    # next link folds the previous hash in -> different hash for same payload
    h2 = receipts_mod._chain_hash(h1, payload)
    assert h2 != h1
    # signature is stable HMAC over the hash
    assert receipts_mod._sign(h1) == receipts_mod._sign(h1)
    assert receipts_mod._sign(h1) != receipts_mod._sign(h2)


# ---------------------------------------------------------------------------
# verify_chain whole-chain invariants (gap-free sequence + head anchoring).
# Pure logic: a real service with list_receipts stubbed to a crafted chain, so
# no DB is needed. Truncation/wipe of the head is the nation-state/insider case
# a naive prev_hash walk cannot see.
# ---------------------------------------------------------------------------


def _valid_chain(user_id: str, n: int) -> list[dict]:
    """Build n correctly-linked, correctly-signed receipts (seq 1..n)."""
    chain: list[dict] = []
    prev_hash = receipts_mod.GENESIS_HASH
    for seq in range(1, n + 1):
        payload = receipts_mod._canonical_payload(
            user_id=user_id,
            seq=seq,
            event_type="READ",
            subscriber_id=_SUBSCRIBER,
            grant_id="g1",
            scopes=["wants.money.advisor"],
            fields=["connect.zip"],
            purpose="local match",
            created_at_ms=1000 + seq,
            metadata={},
        )
        hash_hex = receipts_mod._chain_hash(prev_hash, payload)
        chain.append(
            {
                "seq": seq,
                "event_type": "READ",
                "subscriber_id": _SUBSCRIBER,
                "grant_id": "g1",
                "scopes": ["wants.money.advisor"],
                "fields": ["connect.zip"],
                "purpose": "local match",
                "prev_hash": prev_hash,
                "hash": hash_hex,
                "signature": receipts_mod._sign(hash_hex),
                "metadata": {},
                "created_at_ms": 1000 + seq,
            }
        )
        prev_hash = hash_hex
    return chain


def _verify(chain: list[dict], **kwargs) -> dict:
    svc = FabricReceiptsService()
    svc.list_receipts = AsyncMock(return_value=chain)  # type: ignore[method-assign]
    return asyncio.run(svc.verify_chain(_UID, **kwargs))


def test_verify_chain_ok_returns_head():
    chain = _valid_chain(_UID, 3)
    out = _verify(chain)
    assert out["ok"] is True
    assert out["head_seq"] == 3
    assert out["head_hash"] == chain[-1]["hash"]


def test_verify_chain_detects_sequence_gap():
    chain = _valid_chain(_UID, 3)
    del chain[1]  # drop seq 2 -> remaining seqs are 1,3
    out = _verify(chain)
    assert out["ok"] is False
    assert out["reason"] in {"sequence_gap", "prev_hash_mismatch"}


def test_verify_chain_detects_tail_truncation_against_pinned_head():
    """The blind spot a naive walk misses: dropping the newest receipts leaves
    1..k linking perfectly. A client that pinned head_seq=3 must see the
    regression to head_seq=2."""
    full = _valid_chain(_UID, 3)
    truncated = full[:2]  # newest receipt (seq 3) dropped
    # Without a pin, the truncated chain looks internally valid (the gap the
    # attacker relies on).
    assert _verify(truncated)["ok"] is True
    # With the pinned head, truncation is caught and fails closed.
    out = _verify(
        truncated, expected_head_seq=3, expected_head_hash=full[-1]["hash"]
    )
    assert out["ok"] is False
    assert out["reason"] == "head_regressed"


def test_verify_chain_detects_head_divergence():
    chain = _valid_chain(_UID, 2)
    out = _verify(chain, expected_head_seq=2, expected_head_hash="deadbeef")
    assert out["ok"] is False
    assert out["reason"] == "head_diverged"


def test_verify_chain_detects_full_wipe_against_pin():
    out = _verify([], expected_head_seq=2, expected_head_hash="whatever")
    assert out["ok"] is False
    assert out["reason"] == "head_regressed"


# ---------------------------------------------------------------------------
# Owner routes (Firebase auth; service mocked)
# ---------------------------------------------------------------------------


def _owner_app() -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return app


def test_create_grant_returns_handle_and_receipt():
    created = {
        "grant_id": "g-abc",
        "handle": "HCT:payload.sig",
        "subscriber_id": _SUBSCRIBER,
        "scopes": ["wants.money.advisor"],
        "fields": ["connect.want", "connect.zip"],
        "purpose": "local match",
        "price_cents": None,
        "currency": None,
        "expires_at_ms": 9999,
        "receipt": {"seq": 1, "hash": "abc", "event_type": "GRANT"},
    }
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.create_grant = AsyncMock(return_value=created)
        resp = TestClient(_owner_app()).post(
            "/api/fabric/grants",
            json={
                "subscriber_id": _SUBSCRIBER,
                "scopes": ["wants.money.advisor"],
                "purpose": "local match",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handle"] == "HCT:payload.sig"
    assert body["receipt"]["event_type"] == "GRANT"
    # uid passed to the service is the verified token's, not the body's.
    assert factory.return_value.create_grant.await_args.kwargs["user_id"] == _UID


def test_create_grant_maps_service_error_to_http():
    from hushh_mcp.services.fabric_grant_service import FabricGrantError

    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.create_grant = AsyncMock(
            side_effect=FabricGrantError("FABRIC_SCOPES_REQUIRED", "At least one scope.", 422)
        )
        resp = TestClient(_owner_app()).post(
            "/api/fabric/grants",
            json={"subscriber_id": _SUBSCRIBER, "scopes": ["x"], "purpose": "p"},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "FABRIC_SCOPES_REQUIRED"


def test_revoke_grant():
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.revoke_grant = AsyncMock(
            return_value={"grant_id": "g1", "status": "revoked", "already": False}
        )
        resp = TestClient(_owner_app()).post("/api/fabric/grants/g1/revoke")
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"


def test_list_receipts():
    with patch.object(fabric, "get_fabric_receipts_service") as factory:
        factory.return_value.list_receipts = AsyncMock(
            return_value=[{"seq": 1, "event_type": "GRANT", "hash": "h1"}]
        )
        resp = TestClient(_owner_app()).get("/api/fabric/receipts")
    assert resp.status_code == 200
    assert resp.json()["count"] == 1


# ---------------------------------------------------------------------------
# Subscriber read route (developer-principal auth; service mocked)
# ---------------------------------------------------------------------------


def _subscriber_app(agent_id: str = _SUBSCRIBER) -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[fabric.require_subscriber_principal] = lambda: SimpleNamespace(
        agent_id=agent_id, app_id="acme"
    )
    return app


def test_subscriber_read_returns_only_granted_fields():
    result = {
        "user_id": _UID,
        "subscriber_id": _SUBSCRIBER,
        "grant_id": "g1",
        "scopes": ["wants.money.advisor"],
        "fields": {"connect.want": "wants.money.advisor", "connect.zip": "98033"},
        "receipt": {"seq": 2, "hash": "h2", "event_type": "READ"},
    }
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.read_for_subscriber = AsyncMock(return_value=result)
        resp = TestClient(_subscriber_app()).post(
            "/api/fabric/read", json={"handle": "HCT:cGF5bG9hZA.c2lnbmF0dXJl"}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"] == {"connect.want": "wants.money.advisor", "connect.zip": "98033"}
    assert body["receipt"]["event_type"] == "READ"
    # the subscriber id used is the authenticated principal's, never the body's.
    assert (
        factory.return_value.read_for_subscriber.await_args.kwargs["subscriber_id"] == _SUBSCRIBER
    )


def test_subscriber_read_denied_codes_collapse_to_generic_no_oracle():
    """Every handle/grant authz failure must return one generic 403 so the read
    response cannot be used as a signature/existence oracle (forged vs.
    valid-but-wrong-subscriber vs. revoked vs. expired must be indistinguishable
    to the caller). The specific reason is logged server-side only."""
    from hushh_mcp.services.fabric_grant_service import FabricGrantError

    for specific_code in (
        "FABRIC_HANDLE_INVALID",
        "FABRIC_HANDLE_EXPIRED",
        "FABRIC_SUBSCRIBER_MISMATCH",
        "FABRIC_GRANT_NOT_FOUND",
        "FABRIC_GRANT_REVOKED",
    ):
        with patch.object(fabric, "get_fabric_grant_service") as factory:
            factory.return_value.read_for_subscriber = AsyncMock(
                side_effect=FabricGrantError(specific_code, "denied", 403)
            )
            resp = TestClient(_subscriber_app()).post(
                "/api/fabric/read", json={"handle": "HCT:cGF5bG9hZA.c2lnbmF0dXJl"}
            )
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        # Generic to the caller; the specific reason is never leaked.
        assert detail["code"] == "FABRIC_READ_DENIED"
        assert specific_code not in resp.text
