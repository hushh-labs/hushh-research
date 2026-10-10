"""Function-scoped PostgreSQL authority fixtures for the paid consent contracts."""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI, Header
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.routes import scope_commerce as routes
from api.routes import scope_commerce_contracts, scope_commerce_exports, scope_commerce_reads
from db.db_client import DatabaseClient
from hushh_mcp.consent import paid_admission
from hushh_mcp.consent.scope_generator import DynamicScopeGenerator
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.scope_commerce import ScopeCommerceService
from tests.scope_commerce_contract_harness import (
    FINGERPRINT,
    HANDLE,
    PUBLIC_KEY,
    SCOPE,
    PaidContract,
)
from tests.services.test_external_connector_lifecycle_postgres import connector_postgres_url

# Importing this strict fixture registers its CI disposable-database fallback.
__all__ = ["connector_postgres_url", "paid_contract_dsn", "paid_contract"]
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"

AUTHORITY_DDL = """
CREATE TABLE contract_clock(observed_at TIMESTAMPTZ NOT NULL);
INSERT INTO contract_clock VALUES(pg_catalog.clock_timestamp());
CREATE FUNCTION clock_timestamp() RETURNS TIMESTAMPTZ LANGUAGE SQL VOLATILE AS $$
 SELECT observed_at FROM contract_clock
$$;
CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
CREATE FUNCTION update_updated_at_column() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TABLE consent_audit(
 id BIGSERIAL PRIMARY KEY, user_id TEXT, agent_id TEXT, scope TEXT, action TEXT,
 token_id TEXT, request_id TEXT, scope_description TEXT, issued_at BIGINT,
 expires_at BIGINT, poll_timeout_at BIGINT, metadata JSONB
);
CREATE TABLE developer_apps(
 app_id TEXT PRIMARY KEY, owner_firebase_uid TEXT, agent_id TEXT, status TEXT
);
CREATE TABLE developer_connector_keys(
 app_id TEXT, connector_key_id TEXT, connector_public_key TEXT,
 connector_wrapping_alg TEXT, status TEXT
);
CREATE TABLE one_information_request_bundles(
 bundle_id UUID PRIMARY KEY, requester_user_id TEXT, subject_user_id TEXT,
 requester_principal TEXT, connector_key_id TEXT, duration_seconds INTEGER, purpose TEXT
);
CREATE TABLE one_information_request_items(bundle_id UUID, request_id TEXT);
CREATE TABLE feed_events(
 user_id TEXT, source_domain TEXT, event_type TEXT, metadata JSONB, source_row_id TEXT
);
CREATE TABLE pkm_index(user_id TEXT, available_domains JSONB);
CREATE TABLE pkm_manifests(
 user_id TEXT, domain TEXT, manifest_version INTEGER,
 top_level_scope_paths JSONB, externalizable_paths JSONB, summary_projection JSONB
);
CREATE TABLE pkm_blobs(
 user_id TEXT, domain TEXT, content_revision INTEGER, manifest_revision INTEGER
);
CREATE TABLE pkm_manifest_paths(
 user_id TEXT, domain TEXT, json_path TEXT, path_type TEXT, segment_id TEXT,
 exposure_eligibility BOOLEAN, consent_label TEXT, scope_handle TEXT, sensitivity_label TEXT
);
CREATE TABLE pkm_scope_registry(
 user_id TEXT, domain TEXT, scope_handle TEXT, scope_label TEXT, exposure_enabled BOOLEAN,
 visibility_posture TEXT, default_projection_ready BOOLEAN,
 default_projection_updated_at TIMESTAMPTZ, summary_projection JSONB, manifest_version INTEGER
);
"""


@pytest.fixture(scope="module")
def paid_contract_dsn(request: pytest.FixtureRequest) -> str:
    dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN")
    if dsn:
        url = make_url(dsn)
        if (
            url.host not in {None, "localhost", "127.0.0.1"}
            or url.database != "hushh_scope_commerce_agent_20261006"
            or url.query.get("host") not in {None, "/tmp"}  # noqa: S108 - authorized isolated socket
        ):
            pytest.fail("Paid consent contracts refuse a non-isolated PostgreSQL target")
        return dsn
    url = request.getfixturevalue("connector_postgres_url")
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def configure_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {
        "SCOPE_COMMERCE_ENABLED": "true",
        "DB_OFFLINE": "false",
        "ENVIRONMENT": "local",
        "HUSHH_DEPLOY_ENV": "local",
        "SCOPE_COMMERCE_PROVIDER_ENABLED": "true",
        "SCOPE_COMMERCE_STRIPE_LIVEMODE": "false",
        "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID": "acct_contract_platform",
        "SCOPE_COMMERCE_FRONTEND_ORIGIN": "https://contract.local",
        "SCOPE_COMMERCE_COUNTRY_POLICIES_JSON": json.dumps(
            {
                "US": {
                    "currency": "usd",
                    "minimum_cents": 50,
                    "retention_days": 90,
                    "fixed_fee_micro_usd": 0,
                    "fee_basis_points": 0,
                    "unattributed_fees": False,
                }
            }
        ),
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def bind_authorities(
    monkeypatch: pytest.MonkeyPatch,
    pool: asyncpg.Pool,
    database: DatabaseClient,
    service: ScopeCommerceService,
) -> None:
    catalog = DynamicScopeGenerator()
    catalog._db = database

    async def test_pool() -> asyncpg.Pool:
        return pool

    monkeypatch.setattr("db.connection.get_pool", test_pool)
    monkeypatch.setattr(paid_admission, "get_pool", test_pool)
    monkeypatch.setattr(routes, "get_pool", test_pool)
    monkeypatch.setattr(scope_commerce_exports, "get_pool", test_pool)
    monkeypatch.setattr(scope_commerce_reads, "get_pool", test_pool)
    monkeypatch.setattr("hushh_mcp.services.scope_commerce_requests.get_pool", test_pool)
    monkeypatch.setattr(
        "hushh_mcp.services.scope_commerce_requests.get_scope_generator", lambda: catalog
    )
    monkeypatch.setattr(ConsentDBService, "_get_db", lambda _self: database)

    # Consent helpers construct the same canonical facade within caller-owned
    # transactions. Bind that facade's configured test instance too; never
    # fabricate process Stripe credentials merely to exercise real accounting.
    def consent_commerce_service():
        from hushh_mcp.services.scope_commerce.provider_config import ScopeCommerceProviderConfig

        if service.provider_config is None:
            return ScopeCommerceService(pool)
        return ScopeCommerceService(pool, provider_config=ScopeCommerceProviderConfig.from_env())

    monkeypatch.setattr(
        "hushh_mcp.services.scope_commerce.service.ScopeCommerceService", consent_commerce_service
    )
    for module in (routes, scope_commerce_contracts, scope_commerce_exports, scope_commerce_reads):
        monkeypatch.setattr(module, "_service", lambda: service)


def contract_app() -> FastAPI:
    app = FastAPI()
    app.include_router(routes.router)

    async def payer(x_contract_identity: str = Header(default="payer")) -> str:
        return x_contract_identity

    async def owner(x_contract_identity: str = Header(default="owner")) -> dict[str, str]:
        return {"user_id": x_contract_identity}

    app.dependency_overrides[require_firebase_auth_read_only] = payer
    app.dependency_overrides[require_vault_owner_token] = owner
    return app


async def seed_authorities(
    pool: asyncpg.Pool, service: ScopeCommerceService, request_id: str
) -> None:
    metadata = {
        "developer_app_id": "app",
        "scope_handle": HANDLE,
        "connector_key_id": "key",
        "recipient_key_fingerprint": FINGERPRINT,
        "expiry_hours": 1,
        "reason": "Synthetic scope contract",
        "refresh_policy": "snapshot",
        "commercial_required": True,
    }
    async with pool.acquire() as conn:
        await conn.execute(AUTHORITY_DDL)
        for migration in (
            "009_consent_exports.sql",
            "035_strict_zero_knowledge_consent_exports.sql",
            "088_consent_export_envelope_v2.sql",
            "296_consumer_scope_commerce.sql",
        ):
            await conn.execute((MIGRATIONS / migration).read_text())
        await service.bind_environment(
            platform_account_id="acct_contract_platform", livemode=False, conn=conn
        )
        await conn.execute("INSERT INTO vault_keys VALUES('owner')")
        await conn.execute(
            "INSERT INTO developer_apps VALUES('app','payer','developer:app','active')"
        )
        await conn.execute(
            "INSERT INTO developer_connector_keys VALUES('app','key',$1,'X25519-AES256-GCM','active')",
            PUBLIC_KEY,
        )
        await conn.execute(
            "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible) VALUES('owner','acct_contract','US',false,true)"
        )
        await conn.execute("INSERT INTO pkm_index VALUES('owner','[\"travel\"]')")
        await conn.execute(
            "INSERT INTO pkm_manifests VALUES('owner','travel',1,'[\"preferences\"]','[]',$1::jsonb)",
            json.dumps(
                {
                    "scope_materialization": {
                        "preferences": {"state": "materialized", "materialized_leaf_count": 1}
                    }
                }
            ),
        )
        await conn.execute("INSERT INTO pkm_blobs VALUES('owner','travel',1,1)")
        await conn.execute(
            "INSERT INTO pkm_scope_registry VALUES('owner','travel',$1,'Travel Preferences',true,'consent_required',false,NULL,$2::jsonb,1)",
            HANDLE,
            json.dumps(
                {
                    "top_level_scope_path": "preferences",
                    "consumer_visible": True,
                    "internal_only": False,
                }
            ),
        )
        await ConsentDBService().insert_event(
            user_id="owner",
            agent_id="developer:app",
            scope=SCOPE,
            action="REQUESTED",
            request_id=request_id,
            metadata=metadata,
            connection=conn,
        )


@pytest.fixture
async def paid_contract(
    monkeypatch: pytest.MonkeyPatch, paid_contract_dsn: str
) -> AsyncIterator[PaidContract]:
    """Every security contract owns a new schema and canonical authority state."""
    schema = "paid_contract_" + uuid4().hex
    admin = await asyncpg.connect(paid_contract_dsn)
    await admin.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(
        paid_contract_dsn,
        min_size=1,
        max_size=5,
        server_settings={"search_path": schema + ",pg_catalog"},
    )
    engine = create_engine(
        paid_contract_dsn.replace("postgresql:", "postgresql+psycopg2:", 1),
        connect_args={"options": f"-csearch_path={schema},pg_catalog"},
    )
    request_id = "req_paid_" + uuid4().hex
    configure_environment(monkeypatch)
    from hushh_mcp.services.scope_commerce.provider_config import ScopeCommerceProviderConfig

    # Explicit canonical test adapter: financial/consent tests do not require
    # process Stripe credentials. Default-runtime prerequisite checks are tested
    # separately, without a provider call or credential fixture.
    service = ScopeCommerceService(pool, provider_config=ScopeCommerceProviderConfig.from_env())
    bind_authorities(monkeypatch, pool, DatabaseClient(engine), service)
    try:
        await seed_authorities(pool, service, request_id)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=contract_app()), base_url="http://contract.local"
        ) as client:
            yield PaidContract(client, pool, service, request_id)
    finally:
        engine.dispose()
        await pool.close()
        await admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.close()
