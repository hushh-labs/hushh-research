"""An Azure setup job runs start to recorded under the FULL dev migration chain.

The first live Connect Azure (2026-10-03) was refused at its first write: the
project-grant fence (927) admitted only a Google Cloud project id, and an Azure
job's project_id is a resource group's ARM id. The Azure tests before this one
loaded a partial schema without 927, so they could not see it. This one loads
every parked migration through 951 and drives the real job store and the real
registry publication. A negative control loads the chain WITHOUT 951 and must
be refused, so the test fails if the admission widening is ever lost.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.azure_cloud_publication import record_proven_azure_cloud
from hushh_mcp.services.azure_setup_plan import group_id
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
OWNER = "synthetic-owner"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
TENANT = "11111111-1111-1111-1111-111111111111"
SUB = "22222222-2222-2222-2222-222222222222"
GROUP = "rg-hussh-one-0123456789abcdef0123"
FIRST = (
    "900_personal_agent_registry.sql", "905_personal_agent_liveness.sql",
    "906_personal_agent_user_cloud.sql", "907_pod_lifecycle_events.sql",
    "908_personal_agent_tombstone_metadata.sql", "911_pod_migration_jobs.sql",
    "912_personal_agent_status_migrating.sql", "914_personal_agent_billing_space_id.sql",
    "916_personal_agent_erasure_admission.sql", "917_personal_agent_provision_admission.sql",
    "909_byoc_setup_jobs.sql",
)  # fmt: skip


class _Client:
    """The ``execute_raw`` surface of the app's DB client, over the temp server."""

    def __init__(self, server: TempPostgres) -> None:
        from sqlalchemy import create_engine

        self._engine = create_engine(
            f"postgresql+psycopg2://hushh@/postgres?host={server.dir}&port={server.port}"
        )

    def execute_raw(self, sql: str, params: dict | None = None) -> SimpleNamespace:
        from sqlalchemy import text

        with self._engine.begin() as conn:
            result = conn.execute(text(sql), params or {})
            rows = [dict(row._mapping) for row in result] if result.returns_rows else []
        return SimpleNamespace(data=rows)


def _server(monkeypatch, *, last: int) -> TempPostgres:
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    server.start()
    schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
    table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
    server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
    server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
    server.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
    server.apply_file(PARKED / "915_personal_agent_renewal_authority.sql")
    for name in FIRST:
        server.apply_file(PARKED / name)
    for path in sorted(PARKED.glob("*.sql")):
        number = int(path.name.split("_", 1)[0])
        # 944 (chat-history cutover) and 945 (MCP action authority) need chat and
        # action tables this fixture omits; neither touches setup jobs or the registry.
        if 918 <= number <= last and number not in (944, 945):
            server.apply_file(path)
    return server


@pytest.fixture
def pg(monkeypatch):
    server = _server(monkeypatch, last=951)
    try:
        yield server
    finally:
        server.stop()


def _reserved_owner(pg: TempPostgres) -> None:
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES (%s,%s,'unprovisioned')",
        (OWNER, HUSHH_ID),
    )


def _start(pg: TempPostgres, project_id: str, job: str = "job-1") -> bool:
    repo = ByocSetupJobRepo(client=_Client(pg))
    return asyncio.run(repo.start(user_id=OWNER, job_id=job, project_id=project_id))


def test_an_azure_setup_job_runs_from_start_to_recorded(pg):
    _reserved_owner(pg)
    repo = ByocSetupJobRepo(client=_Client(pg))
    group_ref = group_id(SUB, GROUP)

    # The insert the live run was refused at, through the real store.
    assert asyncio.run(repo.start(user_id=OWNER, job_id="job-1", project_id=group_ref))
    # advance()/finish() use the query-builder client; the same UPDATEs, raw.
    for stage in ("creating_resource_group", "deploying_agent", "proving"):
        pg.execute(
            "UPDATE byoc_setup_jobs SET stage=%s, updated_at=now() WHERE user_id=%s AND job_id='job-1'",
            (stage, OWNER),
        )
    asyncio.run(
        record_proven_azure_cloud(
            repo, user_id=OWNER, job_id="job-1", tenant_id=TENANT, subscription_id=SUB,
            resource_group=GROUP, location="eastus2", model_credential_mode="user_azure_mi",
        )
    )  # fmt: skip
    pg.execute(
        "UPDATE byoc_setup_jobs SET status='recorded', updated_at=now() WHERE user_id=%s AND job_id='job-1'",
        (OWNER,),
    )

    [job] = pg.execute("SELECT status, project_id FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))
    assert job == ("recorded", group_ref)
    [row] = pg.execute(
        "SELECT deployment_target, user_cloud_subscription_id, user_cloud_resource_group,"
        " user_cloud_project FROM personal_agent_registry WHERE user_id=%s",
        (OWNER,),
    )
    assert row == ("user_azure", SUB, GROUP, None)


def test_a_google_cloud_project_is_still_admitted(pg):
    _reserved_owner(pg)
    assert _start(pg, "owner-project-123")


@pytest.mark.parametrize(
    "project_id",
    [
        "/subscriptions/not-a-guid/resourceGroups/rg-x",
        f"/subscriptions/{SUB}/resourceGroups/",
        f"/subscriptions/{SUB}/resourceGroups/rg-ends-with-dot.",
        f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.App/containerApps/x",
        f"/subscriptions/{SUB}/resourceGroups/rg;drop",
        "Owner-Project",
    ],
)
def test_a_malformed_target_is_refused(pg, project_id):
    _reserved_owner(pg)
    with pytest.raises(Exception, match="project grant admission unavailable"):
        _start(pg, project_id)


def test_an_erasure_reserving_the_group_still_refuses_admission(pg):
    group_ref = group_id(SUB, GROUP)
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES ('other','ha1_other','unprovisioned')"
    )
    pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=jsonb_build_object('erasure',"
        " jsonb_build_object('grantRelease', jsonb_build_object('project', %s::text)))"
        " WHERE user_id='other'",
        (group_ref,),
    )
    pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")
    _reserved_owner(pg)
    with pytest.raises(Exception, match="project grant release reserved"):
        _start(pg, group_ref)


def test_without_951_an_azure_job_is_refused(monkeypatch):
    """Negative control: the chain through 950 reproduces the live refusal."""
    server = _server(monkeypatch, last=950)
    try:
        _reserved_owner(server)
        with pytest.raises(Exception, match="project grant admission unavailable"):
            _start(server, group_id(SUB, GROUP))
    finally:
        server.stop()
