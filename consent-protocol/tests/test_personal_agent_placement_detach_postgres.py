"""Detaching a placement keeps the agent's identity and data, on a real PostgreSQL.

The detach is one conditional UPDATE under the registry's real guard triggers
(provision admission 917, the erasure guard chain through 943, the signing-key
trigger 947). Fakes cannot prove a WHERE clause or a trigger, so this runs them.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.personal_agent_placement_detach import detach_placement, plan_detach
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
OWNER = "synthetic-owner"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"


class _Db:
    """The ``execute_raw`` surface of the app's DB client, over the temp server."""

    def __init__(self, server: TempPostgres) -> None:
        from sqlalchemy import create_engine

        self._engine = create_engine(
            f"postgresql+psycopg2://hushh@/postgres?host={server.dir}&port={server.port}"
        )

    def execute_raw(self, sql: str, params: dict) -> SimpleNamespace:
        from sqlalchemy import text

        with self._engine.begin() as conn:
            result = conn.execute(text(sql), params)
            rows = [dict(row._mapping) for row in result] if result.returns_rows else []
        return SimpleNamespace(data=rows)


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
        server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        server.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
        server.apply_file(PARKED / "915_personal_agent_renewal_authority.sql")
        for name in (
            "900_personal_agent_registry.sql", "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql", "907_pod_lifecycle_events.sql",
            "908_personal_agent_tombstone_metadata.sql", "911_pod_migration_jobs.sql",
            "912_personal_agent_status_migrating.sql", "914_personal_agent_billing_space_id.sql",
            "916_personal_agent_erasure_admission.sql", "917_personal_agent_provision_admission.sql",
            "909_byoc_setup_jobs.sql",
        ):  # fmt: skip
            server.apply_file(PARKED / name)
        for path in sorted(PARKED.glob("*.sql")):
            if 918 <= int(path.name.split("_", 1)[0]) <= 943:
                server.apply_file(path)
        for name in (
            "947_pod_request_signing.sql",
            "948_personal_agent_user_azure.sql",
            "949_personal_agent_owner_access_erasure.sql",
        ):
            server.apply_file(PARKED / name)
        yield server
    finally:
        server.stop()


def _provisioned(pg: TempPostgres, *, project: str = "owner-project") -> None:
    metadata = {"serviceUid": "incarnation-1", "url": "https://agent.example.test"}
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend,external_agent_id,"
        "a2a_route,deployment_target,model_credential_mode,user_cloud_project,user_cloud_region,"
        "user_cloud_authorized_at,pod_pubkey,pod_key_id,backend_metadata) VALUES "
        "(%s,%s,'provisioned','user_gcp','svc-1','https://a2a.example/u/x','user_gcp','user_adc',"
        "%s,'us-central1',now(),'cHVi','podk_1',%s::jsonb)",
        (OWNER, HUSHH_ID, project, json.dumps(metadata)),
    )
    pg.execute(
        "UPDATE personal_agent_registry SET pod_signing_pubkey=%s, pod_signing_key_id=%s, "
        "identity_mode='signed' WHERE user_id=%s",
        ("A" * 43 + "=", "pods_" + "a" * 32, OWNER),
    )


def _row(pg: TempPostgres) -> dict:
    cols = [
        "user_id", "hushh_id", "status", "external_agent_id", "a2a_route", "deployment_target",
        "user_cloud_project", "user_cloud_authorized_at", "pod_pubkey", "pod_key_id",
        "pod_signing_pubkey", "pod_signing_key_id", "identity_mode", "backend_metadata",
        "updated_at",
    ]  # fmt: skip
    values = pg.execute(
        f"SELECT {', '.join(cols)} FROM personal_agent_registry WHERE user_id=%s", (OWNER,)
    )[0]  # noqa: S608 - fixed column list
    return dict(zip(cols, values, strict=True))


def test_detach_keeps_identity_records_the_placement_and_frees_the_slot(pg):
    _provisioned(pg)
    before = _row(pg)

    result = asyncio.run(detach_placement(row=before, reason="moving to Azure", db=_Db(pg)))

    assert result == {"user_id": OWNER, "detached_count": 1}
    after = _row(pg)
    # Identity stays.
    assert (after["hushh_id"], after["a2a_route"]) == (HUSHH_ID, before["a2a_route"])
    assert after["identity_mode"] == "signed"
    # The slot reads unassigned under record_cloud's own rule.
    assert after["status"] == "unprovisioned" and after["external_agent_id"] is None
    assert after["deployment_target"] is None and after["user_cloud_project"] is None
    # Pod keys released; the 947 trigger retires the signing key with them.
    assert after["pod_pubkey"] is None and after["pod_key_id"] is None
    assert after["pod_signing_pubkey"] is None and after["pod_signing_key_id"] is None
    # Every coordinate needed to resume is kept, newest last.
    [snapshot] = after["backend_metadata"]["detachedPlacements"]
    assert snapshot["user_cloud_project"] == "owner-project"
    assert snapshot["external_agent_id"] == "svc-1"
    assert snapshot["pod_key_id"] == "podk_1"
    assert snapshot["backend_metadata"]["url"] == "https://agent.example.test"
    assert snapshot["reason"] == "moving to Azure" and snapshot["detachedAt"].endswith("Z")
    assert set(after["backend_metadata"]) == {"detachedPlacements"}


def test_a_stale_observation_cannot_detach(pg):
    _provisioned(pg)
    stale = _row(pg)
    pg.execute("UPDATE personal_agent_registry SET updated_at = now() + interval '1 second'")
    assert asyncio.run(detach_placement(row=stale, reason="r", db=_Db(pg))) is None
    assert _row(pg)["status"] == "provisioned"


def test_a_second_detach_appends_rather_than_replaces(pg):
    _provisioned(pg)
    asyncio.run(detach_placement(row=_row(pg), reason="first", db=_Db(pg)))
    pg.execute(
        "UPDATE personal_agent_registry SET status='provisioned', external_agent_id='svc-2', "
        "deployment_target='user_gcp', user_cloud_project='second-project', backend='user_gcp' "
        "WHERE user_id=%s",
        (OWNER,),
    )
    result = asyncio.run(detach_placement(row=_row(pg), reason="second", db=_Db(pg)))
    assert result["detached_count"] == 2
    projects = [p["user_cloud_project"] for p in _row(pg)["backend_metadata"]["detachedPlacements"]]
    assert projects == ["owner-project", "second-project"]


@pytest.mark.parametrize(
    ("row", "refusal"),
    [
        ({"status": "pending", "external_agent_id": None}, "only a provisioned"),
        ({"status": "provisioned", "external_agent_id": "x", "backend_metadata": {"erasure": {}}}, "erasure"),
        (
            {"status": "provisioned", "external_agent_id": "x",
             "backend_metadata": {"provisionAttempt": {"phase": "reserved"}}},
            "unfinished",
        ),
    ],
)  # fmt: skip
def test_the_plan_refuses_rows_it_must_not_touch(row, refusal):
    plan = plan_detach({"user_id": OWNER, "hushh_id": HUSHH_ID, "updated_at": "t", **row})
    assert plan is not None and refusal in (plan.refusal or "")
    with pytest.raises(ValueError, match=refusal):
        asyncio.run(detach_placement(row={"user_id": OWNER, "updated_at": "t", **row}, reason="r"))
