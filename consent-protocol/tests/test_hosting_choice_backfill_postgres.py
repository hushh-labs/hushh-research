"""Qualify legacy Shared continuity on real PostgreSQL.

955 handles the branch's older cloud marker. Main's completed accounts lack that
marker: 958 captures that existing cohort once, excluding placements, detaches,
setup jobs and malformed authority. Replay cannot opt new accounts into Shared.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

from db.db_client import DatabaseClient, DatabaseExecutionError
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from hushh_mcp.services.owner_hosting_choice import HostingChoiceRepo
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.placement_observation import read_optional_placement
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

MIGRATION = Path(__file__).resolve().parents[1] / "db/migrations/parked/955_one_hosting_choice.sql"
CONTINUITY = MIGRATION.with_name("958_one_shared_legacy_continuity.sql")
RELEASE_CHOICE = MIGRATION.parent.parent / "290_one_shared_hosting_choice.sql"
RELEASE_DOWN = MIGRATION.parent.parent / "rollback/290_one_shared_hosting_choice.rollback.sql"

#: The minimum neighbours 955 reads; columns match migrations 029, 900, 906 and 909.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS vault_keys (user_id TEXT PRIMARY KEY);
ALTER TABLE vault_keys ADD COLUMN IF NOT EXISTS setup_capability_ids TEXT;
ALTER TABLE vault_keys ADD COLUMN IF NOT EXISTS setup_completed BOOLEAN;
CREATE TABLE personal_agent_registry (
  user_id TEXT PRIMARY KEY, deployment_target TEXT, backend_metadata JSONB,
  backend TEXT, external_agent_id TEXT, a2a_route TEXT, pod_key_id TEXT, pod_pubkey TEXT,
  status TEXT DEFAULT 'unprovisioned'
);
CREATE TABLE byoc_setup_jobs (user_id TEXT PRIMARY KEY, stage TEXT);
"""

_CLOUD = json.dumps(["cloud"])


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        server.execute(_SCHEMA)
        yield server
    finally:
        server.stop()


def _person(pg, uid: str, capabilities: str | None, registry=None, job: bool = False) -> None:
    pg.execute(
        "INSERT INTO vault_keys (user_id, setup_capability_ids) VALUES (%s, %s)",
        (uid, capabilities),
    )
    if registry is not None:
        target, metadata = registry
        pg.execute(
            "INSERT INTO personal_agent_registry (user_id,deployment_target,backend_metadata) VALUES (%s, %s, %s)",
            (uid, target, json.dumps(metadata) if metadata is not None else None),
        )
    if job:
        pg.execute("INSERT INTO byoc_setup_jobs VALUES (%s, 'consent_pending')", (uid,))


def _choices(pg) -> dict[str, str | None]:
    rows = pg.execute("SELECT user_id, one_hosting_choice FROM vault_keys ORDER BY user_id")
    return dict(rows)


def test_only_working_shared_owners_are_backfilled(pg):
    _person(pg, "shared-no-row", _CLOUD)
    _person(pg, "shared-unprovisioned-row", json.dumps(["cloud", "ai"]), registry=(None, {}))
    _person(pg, "never-finished-cloud", json.dumps(["ai"]))
    _person(pg, "no-capabilities", None)
    _person(pg, "malformed", "not json at all")
    _person(pg, "hussh-pod", _CLOUD, registry=("gcp", {}))
    _person(pg, "own-cloud", _CLOUD, registry=("user_gcp", None))
    _person(pg, "detached", _CLOUD, registry=(None, {"detachedPlacements": [{"x": 1}]}))
    _person(pg, "begun-setup", _CLOUD, job=True)

    pg.apply_file(MIGRATION)

    assert _choices(pg) == {
        "begun-setup": None,
        "detached": None,
        "hussh-pod": None,
        "malformed": None,
        "never-finished-cloud": None,
        "no-capabilities": None,
        "own-cloud": None,
        "shared-no-row": "shared",
        "shared-unprovisioned-row": "shared",
    }
    stamped = pg.execute(
        "SELECT count(*) FROM vault_keys WHERE one_hosting_choice = 'shared'"
        " AND one_hosting_choice_at IS NOT NULL"
    )
    assert stamped == [(2,)]


def test_rerunning_the_migration_keeps_the_first_choice_time(pg):
    _person(pg, "shared", _CLOUD)
    pg.apply_file(MIGRATION)
    first = pg.execute("SELECT one_hosting_choice_at FROM vault_keys")
    pg.apply_file(MIGRATION)
    assert pg.execute("SELECT one_hosting_choice_at FROM vault_keys") == first


def test_completed_legacy_accounts_preserve_shared_without_a_branch_cloud_marker(pg):
    for uid in (
        "legacy",
        "gcp",
        "azure",
        "pending",
        "detached",
        "broken",
        "unfinished",
        "explicit",
    ):
        _person(pg, uid, json.dumps(["connections"]))
    pg.execute("UPDATE vault_keys SET setup_completed=TRUE WHERE user_id <> 'unfinished'")
    pg.execute(
        "INSERT INTO personal_agent_registry (user_id,deployment_target) VALUES ('gcp','user_gcp'),('azure','user_azure')"
    )
    pg.execute("INSERT INTO personal_agent_registry (user_id,status) VALUES ('pending','pending')")
    pg.execute(
        "INSERT INTO personal_agent_registry (user_id,backend_metadata) VALUES ('detached','{\"detachedPlacements\":[]}'::jsonb),('broken','[null]'::jsonb)"
    )
    for key in ("url", "erasure", "upgradeLease", "provisionAttempt"):
        _person(pg, key, json.dumps(["connections"]), registry=(None, {key: "unresolved"}))
        pg.execute("UPDATE vault_keys SET setup_completed=TRUE WHERE user_id=%s", (key,))
    _person(pg, "begun", json.dumps(["connections"]), job=True)
    pg.execute("UPDATE vault_keys SET setup_completed=TRUE WHERE user_id='begun'")
    pg.apply_file(MIGRATION)
    pg.execute(
        "UPDATE vault_keys SET one_hosting_choice='shared',one_hosting_choice_at='2026-01-01' WHERE user_id='explicit'"
    )
    pg.apply_file(CONTINUITY)
    assert {k: v for k, v in _choices(pg).items() if v} == {
        "legacy": "shared",
        "explicit": "shared",
    }
    assert pg.execute(
        "SELECT one_hosting_choice_at=one_hosting_legacy_shared_at FROM vault_keys WHERE user_id='legacy'"
    ) == [(True,)]
    assert pg.execute(
        "SELECT one_hosting_legacy_shared_at FROM vault_keys WHERE user_id='explicit'"
    ) == [(None,)]


def test_legacy_snapshot_replay_never_opts_new_or_later_completed_accounts_into_shared(pg):
    _person(pg, "legacy", json.dumps(["connections"]))
    _person(pg, "unfinished", json.dumps(["connections"]))
    pg.execute("UPDATE vault_keys SET setup_completed=TRUE WHERE user_id='legacy'")
    pg.apply_file(MIGRATION)
    pg.apply_file(CONTINUITY)
    first = pg.execute("SELECT one_hosting_choice_at FROM vault_keys WHERE user_id='legacy'")
    _person(pg, "new", json.dumps(["connections"]))
    pg.execute("UPDATE vault_keys SET setup_completed=TRUE")
    pg.apply_file(CONTINUITY)
    assert _choices(pg) == {"legacy": "shared", "new": None, "unfinished": None}
    assert (
        pg.execute("SELECT one_hosting_choice_at FROM vault_keys WHERE user_id='legacy'") == first
    )


def test_release_only_choice_never_backfills_and_rollback_preserves_owner_decision(pg):
    pg.execute("DROP TABLE personal_agent_registry, byoc_setup_jobs")
    _person(pg, "unplaced", _CLOUD)
    _person(pg, "chosen", None)
    pg.apply_file(RELEASE_CHOICE)
    assert _choices(pg) == {"chosen": None, "unplaced": None}
    pg.execute(
        "UPDATE vault_keys SET one_hosting_choice='shared', one_hosting_choice_at=now()"
        " WHERE user_id='chosen'"
    )
    before = pg.execute("SELECT user_id, one_hosting_choice, one_hosting_choice_at FROM vault_keys")
    pg.apply_file(RELEASE_CHOICE)
    pg.apply_file(RELEASE_DOWN)
    assert (
        pg.execute("SELECT user_id, one_hosting_choice, one_hosting_choice_at FROM vault_keys")
        == before
    )
    for tier, at in [(None, "2026-01-01"), ("shared", None), ("pods", "2026-01-01")]:
        with pytest.raises(psycopg2.errors.CheckViolation):
            pg.execute(
                "UPDATE vault_keys SET one_hosting_choice=%s, one_hosting_choice_at=%s"
                " WHERE user_id='unplaced'",
                (tier, at),
            )


async def test_release_only_first_run_observes_absent_pods_and_records_shared(pg, monkeypatch):
    from api.routes.one import personal_agent, runtime

    pg.execute("DROP TABLE personal_agent_registry, byoc_setup_jobs")
    pg.apply_file(RELEASE_CHOICE)
    _person(pg, "owner", None)
    engine = create_engine(
        URL.create(
            "postgresql+psycopg2",
            username="hushh",
            database="postgres",
            query={"host": pg.dir, "port": str(pg.port)},
        )
    )
    client = DatabaseClient(engine=engine)

    class ExistingPreVault:
        async def get_pre_vault_state(self, user_id):
            assert user_id == "owner"
            return {}

    choice = HostingChoiceRepo(client=client, vault_keys=ExistingPreVault())
    registry = PersonalAgentRegistryRepo(client=client)
    jobs = ByocSetupJobRepo(client=client)
    monkeypatch.setattr(personal_agent, "PersonalAgentRegistryRepo", lambda: registry)
    monkeypatch.setattr(runtime, "PersonalAgentRegistryRepo", lambda: registry)
    monkeypatch.setattr("hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", lambda: jobs)
    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", lambda: choice)
    marks = []

    async def mark(user_id):
        marks.append(user_id)

    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", mark)
    try:
        # Strict repository reads (provisioning authority) still refuse absent stores.
        with pytest.raises(DatabaseExecutionError):
            await registry.get("owner")
        assert await read_optional_placement(jobs, "owner", table="byoc_setup_jobs") is None
        status = await personal_agent.resolve_personal_agent_status(user_id="owner")
        assert status["hostingMode"] == "unplaced"
        await runtime.select_shared_hosting.__wrapped__(request=None, firebase_uid="owner")
        status = await personal_agent.resolve_personal_agent_status(user_id="owner")
        assert status["hostingMode"] == "shared"
        assert marks == ["owner"]
        setup = await runtime.byoc_setup_status.__wrapped__(request=None, firebase_uid="owner")
        assert setup.status == "none"

        probes = []

        async def ready():
            probes.append(True)
            return runtime.ManagedGeminiReadinessResponse(
                status="ready", model="synthetic-model", location="global"
            )

        monkeypatch.setattr(runtime, "_managed_readiness", ready)
        monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "false")
        selected = await runtime.select_managed_gemini(request=None, firebase_uid="owner")
        assert selected.status == "ready"
        assert selected.agentScheduled is False
        assert selected.agentReason == "personal agent is off"
        assert probes == [True]

        # The same reader must immediately honor a newly installed pending placement.
        pg.execute("CREATE TABLE personal_agent_registry (user_id TEXT, status TEXT)")
        pg.execute("INSERT INTO personal_agent_registry VALUES ('owner', 'pending')")
        status = await personal_agent.resolve_personal_agent_status(user_id="owner")
        assert status["hostingMode"] == "pending"
        pg.execute("ALTER TABLE personal_agent_registry RENAME COLUMN user_id TO broken_owner")
        status = await personal_agent.resolve_personal_agent_status(user_id="owner")
        assert status["hostingMode"] == "unknown"
        with pytest.raises(HTTPException) as failure:
            await runtime.select_shared_hosting.__wrapped__(request=None, firebase_uid="owner")
        assert failure.value.status_code == 503
        assert marks == ["owner"]
    finally:
        engine.dispose()
