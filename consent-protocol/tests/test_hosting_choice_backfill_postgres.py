"""Qualify legacy Shared continuity on real PostgreSQL.

955 handles the branch's older cloud marker. Main's completed accounts lack that
marker: 958 captures that existing cohort once, excluding placements, detaches,
setup jobs and malformed authority. Replay cannot opt new accounts into Shared.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

MIGRATION = Path(__file__).resolve().parents[1] / "db/migrations/parked/955_one_hosting_choice.sql"
CONTINUITY = MIGRATION.with_name("958_one_shared_legacy_continuity.sql")

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
