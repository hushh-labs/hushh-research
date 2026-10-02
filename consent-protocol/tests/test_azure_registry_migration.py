"""Parked migration 948: owner Azure coordinates, user_azure in, anypoint out.

Static shape always; behaviour against a disposable PostgreSQL when one is installed:
the constraints, the one-owner index, the job-locked publication SQL, and a rollback
that refuses while an Azure placement exists."""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

_BACKEND = Path(__file__).resolve().parents[1]
_PARKED = _BACKEND / "db/migrations/parked"
_MIGRATION = _PARKED / "948_personal_agent_user_azure.sql"
_ROLLBACK = _BACKEND / "db/migrations/rollback/948_personal_agent_user_azure.rollback.sql"
_BASE = (
    "900_personal_agent_registry.sql",
    "905_personal_agent_liveness.sql",
    "906_personal_agent_user_cloud.sql",
    "909_byoc_setup_jobs.sql",
    "914_personal_agent_billing_space_id.sql",
)
_TENANT = "11111111-1111-1111-1111-111111111111"
_SUB = "22222222-2222-2222-2222-222222222222"
_GROUP = "rg-hussh-one-0123456789abcdef0123"
_needs_pg = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


# -- static shape --------------------------------------------------------------------


def test_948_is_manifested_after_946_with_a_rollback():
    ordered = json.loads((_BACKEND / "db/dev_migration_manifest.json").read_text())[
        "ordered_migrations"
    ]
    assert ordered.index("948_personal_agent_user_azure.sql") > ordered.index(
        "946_personal_agent_files_provision_admission.sql"
    )
    assert _ROLLBACK.is_file()


def test_the_target_check_admits_user_azure_and_retires_anypoint():
    sql = _MIGRATION.read_text()
    check = re.search(r"deployment_target IN \(([^)]*)\)", sql).group(1)  # type: ignore[union-attr]
    assert "'user_azure'" in check and "'anypoint'" not in check
    mode = re.search(r"model_credential_mode IN \(([^)]*)\)", sql).group(1)  # type: ignore[union-attr]
    assert "'user_azure_mi'" in mode and "'user_adc'" in mode
    assert "RAISE EXCEPTION" in sql and "deployment_target = 'anypoint'" in sql


def test_every_constraint_is_dropped_before_it_is_added():
    sql = _MIGRATION.read_text()
    added = re.findall(r"ADD CONSTRAINT (\w+)", sql)
    dropped = re.findall(r"DROP CONSTRAINT IF EXISTS (\w+)", sql)
    assert added and added == dropped


def test_the_stale_anypoint_column_text_is_rewritten():
    comments = " ".join(re.findall(r"COMMENT ON COLUMN[^;]*;", _MIGRATION.read_text()))
    assert "personal_agent_registry.backend" in comments
    assert "personal_agent_registry.external_agent_id" in comments
    assert "anypoint" not in comments.lower()


def test_the_data_plane_contract_declares_948():
    contract = json.loads(
        (
            _BACKEND.parent / "docs/reference/architecture/runtime-db-data-plane-contract.json"
        ).read_text()
    )
    family = next(f for f in contract["table_families"] if f["id"] == "personal_agent_registry")
    assert "migration948" in family["primary_access_path"]


# -- behaviour against PostgreSQL ------------------------------------------------------


def _server(*, with_948: bool) -> TempPostgres:
    original = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    try:
        server = TempPostgres()
        server.start()
    finally:
        postgres_harness.MIGRATIONS = original
    for name in _BASE:
        server.apply_file(_PARKED / name)
    if with_948:
        server.apply_file(_MIGRATION)
        server.apply_file(_MIGRATION)  # the dev lane may replay it: idempotent
    return server


@pytest.fixture(scope="module")
def pg():
    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    server = _server(with_948=True)
    yield server
    server.stop()


def _azure_row(pg, user: str, **overrides) -> None:
    row = {
        "user_id": user,
        "hushh_id": f"ha1_{user}",
        "status": "pending",
        "deployment_target": "user_azure",
        "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": f"{_GROUP}-{user}",
        "user_cloud_region": "eastus2",
        **overrides,
    }
    columns = ", ".join(row)
    pg.execute(
        f"INSERT INTO personal_agent_registry ({columns}) VALUES ({', '.join(['%s'] * len(row))})",  # noqa: S608 - fixed column names
        tuple(row.values()),
    )


def _refused(pg, statement) -> bool:
    try:
        statement()
    except Exception:  # noqa: BLE001 - the database's refusal is the assertion
        pg.execute("ROLLBACK")
        return True
    return False


@_needs_pg
def test_the_schema_refuses_anypoint_and_an_incomplete_azure_row(pg):
    assert _refused(pg, lambda: _azure_row(pg, "a1", deployment_target="anypoint"))
    assert _refused(pg, lambda: _azure_row(pg, "a2", user_cloud_resource_group=None))
    assert _refused(pg, lambda: _azure_row(pg, "a3", user_cloud_region=None))
    upper = "ABCDEF12-1111-1111-1111-111111111111"
    assert _refused(pg, lambda: _azure_row(pg, "a4", user_cloud_tenant_id=upper))
    assert _refused(pg, lambda: _azure_row(pg, "a6", user_cloud_subscription_id="not-a-guid"))
    _azure_row(pg, "a5", model_credential_mode="user_azure_mi")
    assert pg.execute("SELECT deployment_target FROM personal_agent_registry WHERE user_id='a5'")


@_needs_pg
def test_two_people_can_never_share_one_agent_group(pg):
    _azure_row(pg, "b1", user_cloud_resource_group=f"{_GROUP}-shared")
    assert _refused(pg, lambda: _azure_row(pg, "b2", user_cloud_resource_group=f"{_GROUP}-shared"))


def _client(pg):
    from sqlalchemy import create_engine, text

    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")

    class Client:
        def execute_raw(self, sql, params=None):
            with engine.begin() as connection:
                result = connection.execute(text(sql), params or {})
                rows = [dict(r) for r in result.mappings()] if result.returns_rows else []
                return SimpleNamespace(data=rows)

    return SimpleNamespace(_db=lambda: Client())


async def _publish(pg, user: str, job: str):
    from hushh_mcp.services.azure_cloud_publication import record_proven_azure_cloud

    await record_proven_azure_cloud(
        _client(pg), user_id=user, job_id=job, tenant_id=_TENANT, subscription_id=_SUB,
        resource_group=f"{_GROUP}-{user}", location="eastus2", model_credential_mode="user_azure_mi",
    )  # fmt: skip


@_needs_pg
async def test_publication_attaches_the_subscription_and_clears_gcp_coordinates(pg):
    pg.execute(
        "INSERT INTO personal_agent_registry (user_id, hushh_id, status, deployment_target,"
        " user_cloud_project, user_cloud_bootstrap_sa) VALUES ('c1','ha1_c1','pending',"
        " 'user_gcp','old-project','one-bootstrap@old-project.iam.gserviceaccount.com')"
    )
    group_ref = f"/subscriptions/{_SUB}/resourceGroups/{_GROUP}-c1"
    pg.execute(
        "INSERT INTO byoc_setup_jobs (user_id, job_id, project_id, status, stage)"
        " VALUES ('c1', 'job-1', %s, 'running', 'proving')",
        (group_ref,),
    )
    await _publish(pg, "c1", "job-1")
    row = pg.execute(
        "SELECT deployment_target, model_credential_mode, user_cloud_tenant_id,"
        " user_cloud_resource_group, user_cloud_project, user_cloud_bootstrap_sa,"
        " user_cloud_authorized_at IS NOT NULL FROM personal_agent_registry WHERE user_id='c1'"
    )[0]
    assert row == ("user_azure", "user_azure_mi", _TENANT, f"{_GROUP}-c1", None, None, True)


@_needs_pg
async def test_publication_refuses_a_superseded_job_and_an_assigned_pod(pg):
    _azure_row(pg, "d1")
    group_ref = f"/subscriptions/{_SUB}/resourceGroups/{_GROUP}-d1"
    pg.execute(
        "INSERT INTO byoc_setup_jobs (user_id, job_id, project_id, status, stage)"
        " VALUES ('d1', 'job-current', %s, 'running', 'proving')",
        (group_ref,),
    )
    with pytest.raises(AzureSetupRefused) as exc:
        await _publish(pg, "d1", "job-stale")
    assert exc.value.code == "CLOUD_NOT_RECORDED"
    pg.execute("UPDATE personal_agent_registry SET external_agent_id='live-pod' WHERE user_id='d1'")
    with pytest.raises(AzureSetupRefused):
        await _publish(pg, "d1", "job-current")


@_needs_pg
def test_948_refuses_while_anypoint_placements_exist_and_rolls_back_safely():
    server = _server(with_948=False)
    try:
        server.execute(
            "INSERT INTO personal_agent_registry (user_id, hushh_id, status, deployment_target)"
            " VALUES ('e1', 'ha1_e1', 'pending', 'anypoint')"
        )
        assert _refused(server, lambda: server.apply_file(_MIGRATION))
        server.execute("DELETE FROM personal_agent_registry WHERE user_id='e1'")
        server.apply_file(_MIGRATION)
        _azure_row(server, "e2")
        assert _refused(server, lambda: server.apply_file(_ROLLBACK))
        server.execute("DELETE FROM personal_agent_registry WHERE user_id='e2'")
        server.apply_file(_ROLLBACK)
        server.execute(
            "INSERT INTO personal_agent_registry (user_id, hushh_id, status, deployment_target)"
            " VALUES ('e3', 'ha1_e3', 'pending', 'anypoint')"
        )
        columns = {
            r[0]
            for r in server.execute(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_name='personal_agent_registry'"
            )
        }
        assert "user_cloud_tenant_id" not in columns
    finally:
        server.stop()
