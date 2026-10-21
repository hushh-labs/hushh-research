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
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.azure_cloud_publication import record_proven_azure_cloud
from hushh_mcp.services.azure_setup_plan import group_id
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo, JobSuperseded
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

    def table(self, name):
        from db.db_client import TableQuery

        return TableQuery(name, self._engine)


def _server(monkeypatch, *, last: int) -> TempPostgres:
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
        for name in FIRST:
            server.apply_file(PARKED / name)
        for path in sorted(PARKED.glob("*.sql")):
            number = int(path.name.split("_", 1)[0])
            # 944 (chat-history cutover) and 945 (MCP action authority) need chat and
            # action tables this fixture omits; neither touches setup jobs or the registry.
            if 918 <= number <= last and number not in (944, 945):
                server.apply_file(path)
        return server

    except BaseException:
        server.stop()
        raise


def test_failed_schema_setup_closes_its_temporary_database(monkeypatch):
    from unittest.mock import Mock

    failed = RuntimeError("synthetic schema setup failure")
    server = SimpleNamespace(start=Mock(), execute=Mock(side_effect=failed), stop=Mock())
    monkeypatch.setattr(f"{__name__}.TempPostgres", lambda: server)
    with pytest.raises(RuntimeError, match="synthetic schema setup failure"):
        _server(monkeypatch, last=951)
    server.stop.assert_called_once_with()


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


@pytest.mark.parametrize("files_enabled", [False, True])
def test_an_azure_setup_job_runs_from_start_to_recorded(pg, files_enabled):
    _reserved_owner(pg)
    repo = ByocSetupJobRepo(client=_Client(pg))
    group_ref = group_id(SUB, GROUP)

    # The insert the live run was refused at, through the real store.
    assert asyncio.run(
        repo.start(user_id=OWNER, job_id="job-1", project_id=group_ref, files_enabled=files_enabled)
    )
    if not files_enabled:
        asyncio.run(
            repo._guarded_update(
                user_id=OWNER, job_id="job-1", data={"stages": []}, expected_stages=[]
            )
        )
    for stage in ("creating_resource_group", "deploying_agent", "proving"):
        asyncio.run(repo.advance(user_id=OWNER, job_id="job-1", stage=stage))
    asyncio.run(
        record_proven_azure_cloud(
            repo, user_id=OWNER, job_id="job-1", tenant_id=TENANT, subscription_id=SUB,
            resource_group=GROUP, location="eastus2", model_credential_mode="user_azure_mi",
            files_enabled=files_enabled,
        )
    )  # fmt: skip
    asyncio.run(repo.finish(user_id=OWNER, job_id="job-1", status="recorded"))

    [job] = pg.execute("SELECT status, project_id FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))
    assert job == ("recorded", group_ref)
    [row] = pg.execute(
        "SELECT deployment_target, user_cloud_subscription_id, user_cloud_resource_group,"
        " user_cloud_project FROM personal_agent_registry WHERE user_id=%s",
        (OWNER,),
    )
    assert row == ("user_azure", SUB, GROUP, None)
    from hushh_mcp.services.pod_files.selection import selected_for_row

    [stored] = pg.execute(
        "SELECT row_to_json(r) FROM personal_agent_registry r WHERE user_id=%s", (OWNER,)
    )
    assert selected_for_row(stored[0]) is files_enabled
    changed = {**stored[0], "user_cloud_subscription_id": TENANT}
    assert selected_for_row(changed) is False


def test_a_google_cloud_project_is_still_admitted(pg):
    _reserved_owner(pg)
    assert _start(pg, "owner-project-123")


def test_setup_binding_survives_erasure_and_stops_further_cloud_mutations(pg):
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    # An unused migration can roll back; retained bindings below must refuse it.
    pg.apply_file(ROOT / "db/migrations/rollback/961_azure_setup_erasure_binding.rollback.sql")
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    _reserved_owner(pg)
    assert _start(pg, group_id(SUB, GROUP))
    repo = ByocSetupJobRepo(client=_Client(pg))
    intent = {
        "version": 1,
        "jobId": "job-1",
        "hushhId": HUSHH_ID,
        "tenantId": TENANT,
        "subscriptionId": SUB,
        "resourceGroup": GROUP,
        "location": "eastus2",
        "setupNonce": "0" * 16,
    }

    def retain(value, owner=OWNER, job="job-1"):
        return asyncio.run(repo.retain_azure_setup_intent(user_id=owner, job_id=job, intent=value))

    with pytest.raises(JobSuperseded):
        asyncio.run(repo.assert_azure_worker_admitted(user_id=OWNER, job_id="job-1"))
    pg.execute("ALTER TABLE byoc_setup_jobs DISABLE TRIGGER zw_byoc_azure_erasure")
    assert retain(intent) is False
    pg.execute("ALTER TABLE byoc_setup_jobs ENABLE TRIGGER zw_byoc_azure_erasure")
    assert retain(intent) is True and retain(intent) is True
    pg.execute(
        "ALTER TABLE personal_agent_registry DISABLE TRIGGER zz_personal_agent_erasure_registry"
    )
    with pytest.raises(JobSuperseded):
        asyncio.run(repo.assert_azure_worker_admitted(user_id=OWNER, job_id="job-1"))
    pg.execute(
        "ALTER TABLE personal_agent_registry ENABLE TRIGGER zz_personal_agent_erasure_registry"
    )
    for changed in (
        {**intent, "setupNonce": "1" * 16},
        {**intent, "jobId": "job-2"},
        {**intent, "ownerToken": "forbidden"},
        {**intent, "resourceGroup": "foreign"},
    ):
        assert retain(changed) is False
    assert retain(intent, owner="foreign") is False
    asyncio.run(repo.assert_azure_worker_admitted(user_id=OWNER, job_id="job-1"))
    pg.execute("SELECT reserve_personal_agent_erasure(%s,%s)", (OWNER, "attempt-1"))
    assert retain(intent) is False
    with pytest.raises(JobSuperseded):
        asyncio.run(repo.assert_azure_worker_admitted(user_id=OWNER, job_id="job-1"))
    # No job replacement/deletion may discard the original evidence during cleanup.
    for query in (
        "DELETE FROM byoc_setup_jobs WHERE user_id=%s",
        "UPDATE byoc_setup_jobs SET job_id='replacement' WHERE user_id=%s",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="fenced for erasure"):
            pg.execute(query, (OWNER,))
    stages = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert stages == [{"stage": "azure_setup_intent", "intent": intent}]
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    rollback = ROOT / "db/migrations/rollback/961_azure_setup_erasure_binding.rollback.sql"
    with pytest.raises(psycopg2.errors.RaiseException, match="forward recovery"):
        pg.apply_file(rollback)


def test_raw_job_replacement_cannot_race_an_erasure_owner_lock(pg):
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    _reserved_owner(pg)
    assert _start(pg, group_id(SUB, GROUP))
    blocker = psycopg2.connect(host=str(pg.dir), port=pg.port, user="hushh", dbname="postgres")
    try:
        with blocker.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,171))", (OWNER,))
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="admission is busy"):
            pg.execute(
                "UPDATE byoc_setup_jobs SET job_id='replacement',stages='[]'::jsonb "
                "WHERE user_id=%s",
                (OWNER,),
            )
        assert (
            pg.execute("SELECT job_id FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
            == "job-1"
        )
    finally:
        blocker.rollback()
        blocker.close()


@pytest.mark.parametrize("method", ["advance", "touch", "finish"])
async def test_progress_waits_for_owner_lock_and_preserves_concurrent_worker_receipt(pg, method):
    from tests.fixtures.azure_hosted_worker import _prepared_worker

    repo, _ = await _prepared_worker(pg)
    blocker = psycopg2.connect(host=str(pg.dir), port=pg.port, user="hushh", dbname="postgres")
    task = None
    try:
        with blocker.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,171))", (OWNER,))
        options = {"stage": "importing_image"} if method == "advance" else {}
        if method == "finish":
            options = {"status": "recorded"}
        task = asyncio.create_task(getattr(repo, method)(user_id=OWNER, job_id="job-1", **options))
        deadline = time.monotonic() + 5
        while True:
            if task.done():
                await task  # the original row-first implementation is refused here
                pytest.fail("progress did not wait for its owner lock")
            waiting = pg.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' "
                "AND query LIKE '%%byoc_setup_jobs%%'"
            )[0][0]
            if waiting:
                break
            assert time.monotonic() < deadline, "progress never reached its lock"
            await asyncio.sleep(0.01)
        with blocker.cursor() as cursor:
            cursor.execute(
                "SELECT begin_byoc_azure_worker(%s,%s,%s)",
                (OWNER, "job-1", "11111111-1111-4111-8111-111111111111"),
            )
            assert cursor.fetchone()[0] is True
        blocker.commit()
        result = await asyncio.wait_for(task, 5)
        if method == "touch":
            assert result is True
        journal = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
        assert journal[0]["stage"] == "azure_setup_intent"
        assert journal[1]["stage"] == "azure_worker_started"
        assert journal[1]["executionId"] == "11111111-1111-4111-8111-111111111111"
        assert [event["stage"] for event in journal[2:]] == (
            ["importing_image"] if method == "advance" else []
        )
        with pytest.raises(JobSuperseded):
            await repo.advance(user_id=OWNER, job_id="wrong-job", stage="proving")
        assert await repo.touch(user_id="other-owner", job_id="job-1") is False
    finally:
        blocker.rollback()
        blocker.close()
        if task is not None and not task.done():
            await asyncio.wait_for(task, 5)
        repo._db()._engine.dispose()


async def test_progress_keeps_erasure_refusal_and_stage_replacement_cas(pg):
    from sqlalchemy.exc import ProgrammingError

    from tests.fixtures.azure_hosted_worker import _prepared_worker

    repo, _ = await _prepared_worker(pg)
    old = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    await repo.advance(user_id=OWNER, job_id="job-1", stage="importing_image")
    with pytest.raises(JobSuperseded):
        await repo._guarded_update(
            user_id=OWNER, job_id="job-1", data={"stages": old}, expected_stages=old
        )
    with pytest.raises(ValueError, match="observed journal"):
        await repo._guarded_update(user_id=OWNER, job_id="job-1", data={"stages": []})
    retained = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
    assert len(retained) == 2 and retained[0] == old[0]
    pg.execute("SELECT reserve_personal_agent_erasure(%s,%s)", (OWNER, "attempt-progress"))
    with pytest.raises(ProgrammingError, match="fenced for erasure") as refusal:
        await repo.advance(user_id=OWNER, job_id="job-1", stage="proving")
    assert isinstance(refusal.value.orig, psycopg2.errors.InsufficientPrivilege)
    with pytest.raises(ProgrammingError, match="fenced for erasure") as refusal:
        await repo.finish(user_id=OWNER, job_id="job-1", status="recorded")
    assert isinstance(refusal.value.orig, psycopg2.errors.InsufficientPrivilege)
    await repo.finish(user_id=OWNER, job_id="job-1", status="failed")
    assert (
        pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
        == retained
    )
    repo._db()._engine.dispose()


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


async def test_retry_preserves_original_azure_setup_binding_and_refuses_stale_running_reset(pg):
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    _reserved_owner(pg)
    repo = ByocSetupJobRepo(client=_Client(pg))
    target = group_id(SUB, GROUP)
    assert await repo.start(user_id=OWNER, job_id="original", project_id=target)
    intent = {
        "version": 1,
        "jobId": "original",
        "hushhId": HUSHH_ID,
        "tenantId": TENANT,
        "subscriptionId": SUB,
        "resourceGroup": GROUP,
        "location": "eastus2",
        "setupNonce": "0" * 16,
    }
    assert await repo.retain_azure_setup_intent(user_id=OWNER, job_id="original", intent=intent)
    pg.execute(
        "UPDATE byoc_setup_jobs SET updated_at=now()-interval '1 hour' WHERE user_id=%s", (OWNER,)
    )
    assert await repo.start(user_id=OWNER, job_id="retry", project_id=target) is False
    assert (
        pg.execute("SELECT job_id FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0]
        == "original"
    )
    # A terminal local failure can retry in the same cloud without discarding
    # which resources the previous attempt may have created.
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    assert await repo.start(user_id=OWNER, job_id="retry", project_id=target)
    history = [{"stage": "azure_setup_prior_intent", "intent": intent}]
    assert (
        pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0] == history
    )
    next_intent = {**intent, "jobId": "retry", "setupNonce": "1" * 16}
    assert await repo.retain_azure_setup_intent(user_id=OWNER, job_id="retry", intent=next_intent)
    for query in (
        "UPDATE byoc_setup_jobs SET stages='[]'::jsonb WHERE user_id=%s",
        "UPDATE byoc_setup_jobs SET project_id='owner-project-123' WHERE user_id=%s",
        "DELETE FROM byoc_setup_jobs WHERE user_id=%s",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="Azure setup recovery"):
            pg.execute(query, (OWNER,))
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    assert await repo.start(user_id=OWNER, job_id="third", project_id=target)
    assert pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,))[0][0] == [
        *history,
        {"stage": "azure_setup_prior_intent", "intent": next_intent},
    ]


async def test_setup_history_cap_refuses_new_writes_but_allows_failure_settlement(pg):
    pg.apply_file(PARKED / "961_azure_setup_erasure_binding.sql")
    _reserved_owner(pg)
    repo = ByocSetupJobRepo(client=_Client(pg))
    target = group_id(SUB, GROUP)
    for number in range(64):
        job = f"attempt-{number}"
        assert await repo.start(user_id=OWNER, job_id=job, project_id=target)
        intent = {
            "version": 1,
            "jobId": job,
            "hushhId": HUSHH_ID,
            "tenantId": TENANT,
            "subscriptionId": SUB,
            "resourceGroup": GROUP,
            "location": "eastus2",
            "setupNonce": format(number, "016x"),
        }
        assert await repo.retain_azure_setup_intent(user_id=OWNER, job_id=job, intent=intent)
        pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    assert await repo.start(user_id=OWNER, job_id="overflow", project_id=target)
    assert (
        await repo.retain_azure_setup_intent(
            user_id=OWNER,
            job_id="overflow",
            intent={**intent, "jobId": "overflow"},
        )
        is False
    )
    # Refusing the 65th binding must not wedge the job's terminal bookkeeping.
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
    status, stages = pg.execute(
        "SELECT status,stages FROM byoc_setup_jobs WHERE user_id=%s", (OWNER,)
    )[0]
    assert status == "failed" and len(stages) == 64
