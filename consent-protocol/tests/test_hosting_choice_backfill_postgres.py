"""Migration 955 keeps today's Shared owners Shared, on a real PostgreSQL.

Before 955, choosing Shared wrote only the ``cloud`` setup marker. Without a
backfill every working Shared owner would read ``unplaced`` and lose hub chat.
The backfill must pick exactly those people and never a person with a
placement, a detach or a setup job. A WHERE clause needs a real server to prove.
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

#: The minimum neighbours 955 reads; columns match migrations 029, 900, 906 and 909.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS vault_keys (user_id TEXT PRIMARY KEY);
ALTER TABLE vault_keys ADD COLUMN IF NOT EXISTS setup_capability_ids TEXT;
CREATE TABLE personal_agent_registry (
  user_id TEXT PRIMARY KEY, deployment_target TEXT, backend_metadata JSONB
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
            "INSERT INTO personal_agent_registry VALUES (%s, %s, %s)",
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
