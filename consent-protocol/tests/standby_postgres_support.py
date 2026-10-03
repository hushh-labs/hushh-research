"""Shared disposable-Postgres harness for the standby placement tests (migration 950).

Migrations 900-950 are applied verbatim, so the registry's real guard triggers
(provision admission 917, the erasure chain, the signing-key trigger 947, Azure
coordinates 948) judge every statement the store sends. Used by
``test_personal_agent_standby_store_postgres.py`` and
``test_personal_agent_standby_swap_postgres.py``; it holds no tests itself.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from hushh_mcp.services.personal_agent_standby_store import PersonalAgentStandbyStore
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
OWNER = "synthetic-owner"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
OTHER = "synthetic-other"
OTHER_HUSHH_ID = "ha1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
TENANT = "11111111-2222-3333-4444-555555555555"
SUBSCRIPTION = "66666666-7777-8888-9999-000000000000"
HEAD_A = "a" * 64
HEAD_B = "b" * 64


def signing(seed: int) -> tuple[str, str]:
    public = public_key_b64(Ed25519PrivateKey.from_private_bytes(bytes([seed]) * 32))
    return public, signing_key_id(public)


PRIMARY_SIGNING = signing(1)
STANDBY_SIGNING = signing(2)


class Db:
    """The ``execute_raw`` surface of the app's DB client, over the temp server."""

    def __init__(self, server: TempPostgres) -> None:
        from sqlalchemy import create_engine

        self.engine = create_engine(
            f"postgresql+psycopg2://hushh@/postgres?host={server.dir}&port={server.port}"
        )

    def execute_raw(self, sql: str, params: dict) -> SimpleNamespace:
        from sqlalchemy import text

        with self.engine.begin() as conn:
            result = conn.execute(text(sql), params)
            rows = [dict(row._mapping) for row in result] if result.returns_rows else []
        return SimpleNamespace(data=rows)


def start_server():
    """Start a disposable server with migrations 900-950 applied; yields it, then stops."""
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    pg = TempPostgres()
    try:
        pg.start()
        _apply_chain(pg)
        yield pg
    finally:
        postgres_harness.MIGRATIONS = old
        pg.stop()


def _apply_chain(pg: TempPostgres) -> None:
    schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
    table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
    pg.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
    pg.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
    pg.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
    pg.apply_file(PARKED / "915_personal_agent_renewal_authority.sql")
    for name in (
        "900_personal_agent_registry.sql", "905_personal_agent_liveness.sql",
        "906_personal_agent_user_cloud.sql", "907_pod_lifecycle_events.sql",
        "908_personal_agent_tombstone_metadata.sql", "911_pod_migration_jobs.sql",
        "912_personal_agent_status_migrating.sql", "914_personal_agent_billing_space_id.sql",
        "916_personal_agent_erasure_admission.sql", "917_personal_agent_provision_admission.sql",
        "909_byoc_setup_jobs.sql",
    ):  # fmt: skip
        pg.apply_file(PARKED / name)
    for path in sorted(PARKED.glob("*.sql")):
        if 918 <= int(path.name.split("_", 1)[0]) <= 943:
            pg.apply_file(path)
    for name in (
        "947_pod_request_signing.sql",
        "948_personal_agent_user_azure.sql",
        "949_personal_agent_owner_access_erasure.sql",
        "950_personal_agent_standby_placements.sql",
    ):
        pg.apply_file(PARKED / name)


def reset(pg: TempPostgres) -> TempPostgres:
    pg.execute("TRUNCATE personal_agent_standby_placements, personal_agent_registry CASCADE")
    return pg


def store_for(pg: TempPostgres) -> PersonalAgentStandbyStore:
    return PersonalAgentStandbyStore(client=Db(pg))


def seed_primary(
    pg: TempPostgres,
    *,
    owner: str = OWNER,
    hushh_id: str = HUSHH_ID,
    project: str = "owner-project",
    status: str = "provisioned",
    metadata: dict | None = None,
    signed: bool = True,
) -> None:
    meta = {"serviceUid": "incarnation-1", "url": "https://agent.example.test"}
    meta.update(metadata or {})
    public, kid = (PRIMARY_SIGNING if owner == OWNER else signing(9)) if signed else (None, None)
    # One INSERT: the guard triggers (rightly) refuse later updates to rows under
    # erasure or with an unfinished provision, which is the state some tests need.
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend,external_agent_id,"
        "a2a_route,deployment_target,model_credential_mode,user_cloud_project,user_cloud_region,"
        "user_cloud_authorized_at,pod_pubkey,pod_key_id,runtime_version,backend_metadata,"
        "pod_signing_pubkey,pod_signing_key_id) VALUES "
        "(%s,%s,%s,'user_gcp',%s,'https://a2a.example/u/x','user_gcp','user_adc',%s,"
        "'us-central1',now(),'cHVi',%s,'v1',%s::jsonb,%s,%s)",
        (owner, hushh_id, status, f"svc-{owner}", project, f"podk_{owner}", json.dumps(meta),
         public, kid),
    )  # fmt: skip


def placement(**overrides) -> dict:
    public, kid = STANDBY_SIGNING
    placement = {
        "deployment_target": "user_azure",
        "backend": "user_azure",
        "external_agent_id": "/subscriptions/x/resourceGroups/rg-one/containerApps/ca-one",
        "model_credential_mode": "user_azure_mi",
        "user_cloud_region": "eastus2",
        "user_cloud_tenant_id": TENANT,
        "user_cloud_subscription_id": SUBSCRIPTION,
        "user_cloud_resource_group": "rg-one",
        "url": "https://ca-one.example.azurecontainerapps.io",
        "pod_pubkey": "c3RhbmRieQ==",
        "pod_key_id": "podk_standby",
        "pod_signing_pubkey": public,
        "pod_signing_key_id": kid,
        "runtime_version": "v1",
        "backend_metadata": {"serviceUid": "azure-uid"},
    }
    placement.update(overrides)
    return placement


def seed_standby(pg: TempPostgres, *, owner: str = OWNER, hushh_id: str = HUSHH_ID) -> None:
    """Insert a standby directly, for rows ``add_standby`` would (rightly) refuse."""
    public, kid = STANDBY_SIGNING
    pg.execute(
        "INSERT INTO personal_agent_standby_placements(user_id,hushh_id,deployment_target,"
        "external_agent_id,user_cloud_region,user_cloud_tenant_id,user_cloud_subscription_id,"
        "user_cloud_resource_group,url,pod_pubkey,pod_key_id,pod_signing_pubkey,"
        "pod_signing_key_id) VALUES (%s,%s,'user_azure','ca-direct','eastus2',%s,%s,%s,"
        "'https://direct.example','c3Q=','podk_direct',%s,%s)",
        (owner, hushh_id, TENANT, SUBSCRIPTION, f"rg-{owner}", public, kid),
    )


def registry_row(pg: TempPostgres, owner: str = OWNER) -> dict:
    [(row,)] = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry AS r WHERE user_id=%s", (owner,)
    )
    return row


def standby_row(pg: TempPostgres, owner: str = OWNER) -> dict | None:
    rows = pg.execute(
        "SELECT to_jsonb(s) FROM personal_agent_standby_placements AS s WHERE user_id=%s", (owner,)
    )
    return rows[0][0] if rows else None


def run(coro):
    return asyncio.run(coro)


def added(pg, store) -> dict:
    seed_primary(pg)
    run(store.add_standby(OWNER, 0, placement()))
    return run(store.read_standby(OWNER))


def claim(store, observed) -> str:
    lease = uuid4().hex
    assert run(store.claim_sync_lease(OWNER, observed, lease, 0))
    return lease
