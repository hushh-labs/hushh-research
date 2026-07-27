"""DB-backed end-to-end integration test for the Preference Subscription Fabric.

This is the real-Postgres guard the route/unit tests reference: it drives the whole
lifecycle -- seed PWM -> grant -> subscriber read -> receipts + chain verify ->
brand-initiated handshake (request/approve/poll/claim) -> revoke -> fail-closed
denial -> tamper detection -- through the REAL routes, services, HFG handle signing,
Postgres, and the hash-chained receipt ledger. Only the two identity-verification
dependencies are overridden (a fixed owner uid and a fixed subscriber principal),
exactly as a verified Firebase token / developer principal would resolve.

Marked ``db`` (see pyproject markers): it needs a reachable Postgres. It is NOT in
the offline CI test manifest; run it against a real database with::

    DB_HOST=127.0.0.1 DB_PORT=6543 DB_USER=... DB_PASSWORD=... DB_NAME=... \\
        uv run pytest tests/test_fabric_e2e_db.py -m db

When no database is reachable it skips cleanly rather than failing.
"""

from __future__ import annotations

import hmac
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio

# A reachable Postgres is required; default to the documented tunnel port but let
# the environment override it. These are set before the connection pool is first used.
os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_PORT", "6543")
os.environ.setdefault("DB_USER", "postgres")
os.environ.setdefault("DB_NAME", "postgres")

from api.middleware import require_firebase_auth  # noqa: E402
from api.routes import fabric as fabric_routes  # noqa: E402
from api.routes import pwm as pwm_routes  # noqa: E402
from db.connection import get_pool  # noqa: E402
from hushh_mcp.services import fabric_receipts_service as receipts_mod  # noqa: E402
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal  # noqa: E402
from hushh_mcp.services.fabric_grant_service import get_fabric_grant_service  # noqa: E402
from hushh_mcp.services.fabric_receipts_service import get_fabric_receipts_service  # noqa: E402
from hushh_mcp.services.fabric_request_service import get_fabric_request_service  # noqa: E402
from hushh_mcp.services.pwm_service import get_pwm_service  # noqa: E402

pytestmark = pytest.mark.db

OWNER_UID = f"e2e-owner-{uuid.uuid4().hex[:12]}"
SUBSCRIBER_AGENT = f"developer:e2e-{uuid.uuid4().hex[:8]}"
# The three scopes a bank/advisor would ask for; they resolve to four PWM fields.
GRANTED_FIELDS = {"connect.want", "connect.zip", "privacy.ads", "privacy.data-sale"}
UNGRANTED_PWM = {"privacy.analytics", "privacy.marketing-email", "privacy.personalization"}


async def _db_reachable() -> bool:
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute("SELECT 1")
        return True
    except Exception:
        return False


async def _ensure_tables() -> None:
    # The services create their tables idempotently (migrations 118-120 are the
    # authoritative source; this makes the test self-standing on a fresh database).
    await get_pwm_service().ensure_table()
    await get_fabric_grant_service().ensure_table()
    await get_fabric_request_service().ensure_table()
    await get_fabric_receipts_service().ensure_table()


async def _cleanup() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM fabric_receipts WHERE user_id = $1", OWNER_UID)
        await conn.execute("DELETE FROM fabric_subscription_grants WHERE user_id = $1", OWNER_UID)
        await conn.execute(
            "DELETE FROM fabric_consent_requests WHERE subscriber_id = $1", SUBSCRIBER_AGENT
        )
        await conn.execute("DELETE FROM pwm_documents WHERE user_id = $1", OWNER_UID)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[Any]:
    import httpx
    from fastapi import FastAPI
    from httpx import ASGITransport

    if not await _db_reachable():
        pytest.skip("Postgres not reachable; set DB_HOST/DB_PORT to run -m db tests")
    await _ensure_tables()
    await _cleanup()

    app = FastAPI()
    app.include_router(pwm_routes.router)
    app.include_router(fabric_routes.router)
    app.dependency_overrides[require_firebase_auth] = lambda: OWNER_UID
    app.dependency_overrides[fabric_routes.require_subscriber_principal] = lambda: DeveloperPrincipal(
        app_id="e2e", agent_id=SUBSCRIBER_AGENT, display_name="E2E Subscriber",
        allowed_tool_groups=(),
    )
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://e2e") as c:
        try:
            yield c
        finally:
            await _cleanup()


def _owner() -> dict[str, str]:
    return {"authorization": "Bearer owner-id-token"}


def _sub() -> dict[str, str]:
    return {"authorization": "Bearer hdk_subscriber-token"}


@pytest.mark.asyncio
async def test_fabric_end_to_end_db(client: Any) -> None:
    # ---- Part A: direct grant ----
    r = await client.put("/api/pwm", headers=_owner(), json={
        "connect": {"want": "financial-advisor", "zip": "98033", "updatedAt": 1},
        "privacy": {"analytics": True, "ads": False, "marketing-email": True,
                    "personalization": True, "data-sale": False}})
    assert r.status_code == 200

    r = await client.get("/api/pwm", headers=_owner())
    assert r.status_code == 200 and r.json()["connect"]["zip"] == "98033"

    r = await client.post("/api/fabric/grants", headers=_owner(), json={
        "subscriber_id": SUBSCRIBER_AGENT,
        "scopes": ["wants.money.advisor", "privacy.ads", "privacy.data-sale"],
        "purpose": "Match me with a local fiduciary advisor", "ttl_ms": 2592000000})
    assert r.status_code == 200
    grant = r.json()
    handle = grant["handle"]
    grant_id = grant["grant_id"]
    assert handle.startswith("HFG:")
    assert set(grant["fields"]) == GRANTED_FIELDS
    assert grant["receipt"]["seq"] == 1 and set(grant["receipt"]["prev_hash"]) == {"0"}

    r = await client.get("/api/fabric/grants", headers=_owner())
    assert r.status_code == 200 and "handle" not in r.json()["grants"][0]

    r = await client.post("/api/fabric/read", headers=_sub(), json={"handle": handle})
    assert r.status_code == 200
    read = r.json()
    # Least privilege: exactly the granted fields, none of the ungranted PWM fields.
    assert set(read["fields"].keys()) == GRANTED_FIELDS
    assert UNGRANTED_PWM.isdisjoint(read["fields"].keys())
    assert read["fields"]["connect.zip"] == "98033" and read["fields"]["privacy.ads"] is False
    assert read["receipt"]["seq"] == 2 and read["receipt"]["prev_hash"] == grant["receipt"]["hash"]
    # Privacy signals project fail-closed.
    signals = read["privacy_signals"]
    assert signals["consent_mode_v2"]["ad_storage"] == "denied"
    assert signals["consent_mode_v2"]["security_storage"] == "granted"
    assert signals["gpc_opt_out"] is True

    r = await client.get("/api/fabric/receipts/verify", headers=_owner())
    assert r.json() == {"ok": True, "count": 2, "head_seq": 2, "head_hash": read["receipt"]["hash"]}

    # ---- Part B: brand-initiated handshake ----
    r = await client.post("/api/fabric/requests", headers=_sub(), json={
        "scopes": ["wants.money.advisor"], "purpose": "Match you with a local advisor",
        "ttl_ms": 2592000000})
    assert r.status_code == 200
    req = r.json()
    assert "user_id" not in req and "uid" not in req  # subscriber never learns the owner
    code = req["pairing_code"]
    assert len(code) == 9 and code[4] == "-"

    r = await client.get(f"/api/fabric/requests/code/{code}", headers=_owner())
    assert r.status_code == 200 and "user_id" not in r.json()

    r = await client.post(
        f"/api/fabric/requests/{req['request_id']}/approve",
        headers=_owner(), json={"pairing_code": code})
    assert r.status_code == 200 and "handle" not in r.json()  # owner never gets the handle
    assert r.json()["receipt"]["seq"] == 3

    r = await client.get(f"/api/fabric/requests/{req['request_id']}", headers=_sub())
    assert r.status_code == 200 and r.json()["handle"].startswith("HFG:")
    hs_handle = r.json()["handle"]

    r = await client.get(f"/api/fabric/requests/{req['request_id']}", headers=_sub())
    assert r.json()["status"] == "claimed" and "handle" not in r.json()  # single-use

    r = await client.post("/api/fabric/read", headers=_sub(), json={"handle": hs_handle})
    assert r.status_code == 200 and set(r.json()["fields"].keys()) == {"connect.want", "connect.zip"}

    # ---- Part C: revocation, no-oracle, tamper-evidence ----
    r = await client.post(f"/api/fabric/grants/{grant_id}/revoke", headers=_owner())
    assert r.status_code == 200 and r.json()["receipt"]["event_type"] == "REVOKE"

    denied_revoked = await client.post("/api/fabric/read", headers=_sub(), json={"handle": handle})
    denied_forged = await client.post(
        "/api/fabric/read", headers=_sub(), json={"handle": "HFG:not-a-real-handle.deadbeef"})
    # Fail-closed AND no oracle: revoked and forged produce the identical denial.
    assert denied_revoked.status_code == 403 and denied_forged.status_code == 403
    assert denied_revoked.json()["detail"]["code"] == "FABRIC_READ_DENIED"
    assert denied_revoked.json()["detail"] == denied_forged.json()["detail"]

    r = await client.get("/api/fabric/receipts/verify", headers=_owner())
    assert r.json()["ok"] is True and r.json()["head_seq"] == 5

    # ---- Independent cryptographic recomputation (do not trust the API) ----
    rows = await get_fabric_receipts_service().list_receipts(OWNER_UID, limit=1000)
    assert [x["seq"] for x in rows] == [1, 2, 3, 4, 5]
    assert [x["event_type"] for x in rows] == ["GRANT", "READ", "GRANT", "READ", "REVOKE"]
    prev = receipts_mod.GENESIS_HASH
    for row in rows:
        payload = receipts_mod._canonical_payload(
            user_id=OWNER_UID, seq=row["seq"], event_type=row["event_type"],
            subscriber_id=row["subscriber_id"], grant_id=row["grant_id"],
            scopes=row["scopes"], fields=row["fields"], purpose=row["purpose"],
            created_at_ms=row["created_at_ms"], metadata=row["metadata"])
        assert row["prev_hash"] == prev
        assert row["hash"] == receipts_mod._chain_hash(prev, payload)
        assert hmac.compare_digest(row["signature"], receipts_mod._sign(row["hash"]))
        prev = row["hash"]

    # Tail-truncation is detectable against a client-pinned head.
    svc = get_fabric_receipts_service()
    tampered = await svc.verify_chain(OWNER_UID, expected_head_seq=10, expected_head_hash="0" * 64)
    assert tampered["ok"] is False and tampered["reason"] == "head_regressed"
