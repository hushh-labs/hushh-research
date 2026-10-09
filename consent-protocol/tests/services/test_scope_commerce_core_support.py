"""Money and activation contracts against an explicit isolated PostgreSQL DB.

Never use environment application credentials or db.connection.get_pool here.
Each test owns a disposable schema in the parent-authorized local test database.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import asyncpg
import pytest

from hushh_mcp.consent.export_envelope import connector_key_fingerprint, digest_bytes
from hushh_mcp.services.scope_commerce import ScopeCommerceService
from hushh_mcp.services.scope_commerce.provider_config import (
    CountryPayoutPolicy,
    ScopeCommerceProviderConfig,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
PUBLIC_KEY = base64.b64encode(b"k" * 32).decode()
KEY_FINGERPRINT = connector_key_fingerprint(PUBLIC_KEY)


def isolated_commerce_dsn():
    dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN")
    if not dsn:
        supplied = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
        if supplied:
            from sqlalchemy.engine import make_url

            url = make_url(supplied)
            if (
                url.host not in {"127.0.0.1", "localhost"}
                or url.database != "command_test"
                or url.username != "command_test"
                or url.port not in {None, 5432}
            ):
                pytest.fail("Scope commerce tests refuse a non-isolated PostgreSQL target")
            dsn = url.set(drivername="postgresql").render_as_string(hide_password=False)
    if not dsn:
        if os.getenv("CI") == "true":
            pytest.fail("Scope commerce financial acceptance requires isolated PostgreSQL")
        pytest.skip("SCOPE_COMMERCE_TEST_DSN must name an isolated PostgreSQL test database")
    parsed = urlparse(dsn)
    query = parse_qs(parsed.query)
    local = parsed.hostname in {None, "localhost", "127.0.0.1"} and query.get("host", [""])[0] in {
        "",
        "/tmp",  # noqa: S108 -- explicit parent-authorized local PostgreSQL socket
    }
    database = parsed.path.lstrip("/")
    if not local or not (
        database.startswith("hushh_scope_commerce_agent_") or database == "command_test"
    ):
        pytest.fail("Scope commerce tests refuse a runtime database")
    return dsn


@pytest.fixture
async def commerce_db():
    schema = "scope_commerce_test_" + uuid4().hex
    dsn = isolated_commerce_dsn()
    admin = await asyncpg.connect(dsn)
    await admin.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(
        dsn, min_size=1, max_size=5, server_settings={"search_path": schema}
    )
    try:
        async with pool.acquire() as c:
            await c.execute(
                "CREATE TABLE pkm_manifests(user_id TEXT,domain TEXT,manifest_version BIGINT); CREATE TABLE pkm_blobs(user_id TEXT,domain TEXT,content_revision BIGINT,manifest_revision BIGINT)"
            )
            await c.execute(
                "CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY); CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$; CREATE TABLE consent_audit(user_id TEXT,agent_id TEXT,scope TEXT,action TEXT,token_id TEXT,request_id TEXT,metadata JSONB,issued_at BIGINT)"
            )
            for migration in (
                "009_consent_exports.sql",
                "035_strict_zero_knowledge_consent_exports.sql",
                "088_consent_export_envelope_v2.sql",
            ):
                await c.execute((MIGRATIONS / migration).read_text())
            await c.execute((MIGRATIONS / "292_consumer_scope_commerce.sql").read_text())
            await c.execute(
                "CREATE TABLE developer_apps(app_id TEXT PRIMARY KEY,owner_firebase_uid TEXT,status TEXT)"
            )
            await c.execute(
                "CREATE TABLE developer_connector_keys(app_id TEXT,connector_key_id TEXT,connector_public_key TEXT,connector_wrapping_alg TEXT,status TEXT)"
            )
            await c.execute("INSERT INTO developer_apps VALUES('app','payer','active')")
            await c.execute(
                "INSERT INTO developer_connector_keys VALUES('app','key',$1,'X25519-AES256-GCM','active')",
                PUBLIC_KEY,
            )
            await c.execute(
                "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible) VALUES('owner','acct_test','US',false,true)"
            )
        config = ScopeCommerceProviderConfig(
            enabled=True,
            platform_account_id="acct_platform_test",
            frontend_origin="https://test.hushh.ai",
            countries={"US": CountryPayoutPolicy(50, 90, 0, 0)},
        )
        service = ScopeCommerceService(pool, enabled=True, provider_config=config)
        await service.bind_environment(
            platform_account_id=config.platform_account_id, livemode=False
        )
        yield service, pool
    finally:
        await pool.close()
        await admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.close()


async def fund(service, amount=100, fee=0):
    funding_id = str(uuid4())
    await service.reserve_funding(payer_user_id="payer", funding_id=funding_id, amount_cents=amount)
    refs = {
        "payment_intent_id": "pi_" + funding_id,
        "charge_id": "ch_" + funding_id,
        "balance_transaction_id": "txn_" + funding_id,
        "provider_event_id": "evt_" + funding_id,
    }
    await service.settle_funding(
        payer_user_id="payer",
        buyer_app_id="shared",
        funding_id=funding_id,
        amount_cents=amount,
        fee_micro_usd=fee,
        livemode=False,
        **refs,
    )
    return funding_id, refs


async def purchase(
    service, price=10, duration=60, request_id=None, request_deadline=None, owner_user_id="owner"
):
    await service.set_tariff(
        owner_user_id=owner_user_id,
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        price_cents=price,
        base_duration_seconds=duration,
        idempotency_key=str(uuid4()),
    )
    request_id = request_id or "req_" + uuid4().hex
    quote = await service.quote(
        owner_user_id=owner_user_id,
        buyer_app_id="app",
        payer_user_id="payer",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        duration_seconds=duration,
        recipient_key_fingerprint=KEY_FINGERPRINT,
        idempotency_key=str(uuid4()),
        request_id=request_id,
        purpose="contract test",
        refresh_policy="snapshot",
        scope_manifest_revision="1",
        request_deadline=request_deadline,
    )
    p = await service.approve_quote(
        owner_user_id=owner_user_id, quote_id=quote["quoteId"], request_id=request_id
    )
    return quote, p


async def staged(service, p, callback=None, owner_user_id="owner"):
    from hushh_mcp.services.scope_commerce.cost_review import read_negative_net_review

    async def reviewed_terms(c):
        row = await service._row(
            c, "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1", UUID(p["purchaseId"])
        )
        review = await read_negative_net_review(c, row)
        return (
            {"version": 1, "binding": review["binding"], "acknowledged": True} if review else None
        )

    acknowledgement = await service._transaction(reviewed_terms)
    ctx = await service.preparation_context(
        owner_user_id=owner_user_id,
        purchase_id=p["purchaseId"],
        source_revisions={"contentRevision": 1, "manifestRevision": 1},
        negative_net_acknowledgement=acknowledgement,
    )
    from hushh_mcp.consent.export_envelope import canonical_aad_bytes

    aad = {
        "version": 2,
        "app_id": "app",
        "grant_id": p["requestId"],
        "export_id": ctx["exportId"],
        "revision": 1,
        "machine_scope": p["machineScope"],
        "scope_handle": p["scopeHandle"],
        "recipient_key_fingerprint": KEY_FINGERPRINT,
        "payload_algorithm": "AES-256-GCM",
        "expires_at_ms": ctx["expiresAtMs"],
    }
    metadata = {
        "version": 2,
        "export_id": ctx["exportId"],
        "aad": aad,
        "aad_sha256": digest_bytes(canonical_aad_bytes(aad)),
        "ciphertext_sha256": digest_bytes(b"encrypted"),
        "ciphertext_bytes": 9,
    }
    envelope = {
        "ciphertext": base64.b64encode(b"encrypted").decode(),
        "iv": "aXY=",
        "tag": "dGFn",
        "wrappedKey": {"wrapped_export_key": "Y2lwaGVy"},
        "exportEnvelope": metadata,
        "sourceRevisions": ctx["sourceRevisions"],
    }

    async def finalize(c, row):
        # Integration seam, not a fake runtime consent authority: real callers
        # must validate crypto and write their canonical grant in this callback.
        await c.execute("CREATE TABLE IF NOT EXISTS test_canonical_grants(id TEXT PRIMARY KEY)")
        await c.execute("INSERT INTO test_canonical_grants VALUES($1)", row["request_id"])
        return {"consent_token": "synthetic-token-" + row["request_id"]}

    return await service.stage_export(
        owner_user_id=owner_user_id,
        request_id=p["requestId"],
        preparation_id=ctx["preparationId"],
        envelope=envelope,
        authority_check=callback or finalize,
        negative_net_acknowledgement=acknowledgement,
    )


async def matured(service, pool, price=100, owner_user_id="owner"):
    q, p = await purchase(service, price, owner_user_id=owner_user_id)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key=str(uuid4())
    )
    await staged(service, p, owner_user_id=owner_user_id)
    # Synthetic historical financial fixture only: no export is retrieved or
    # crypto expiry rewritten by production code. Model an already ended term.
    async with pool.acquire() as c:
        await c.execute(
            "WITH t AS(SELECT clock_timestamp()-interval '2 minutes' AS v) UPDATE scope_commerce_purchases SET activation_at=t.v,expires_at=t.v+duration_seconds*interval '1 second' FROM t WHERE purchase_id=$1",
            UUID(p["purchaseId"]),
        )
    await service.settle_expired_earnings()
    return p
