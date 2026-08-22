"""Static UAT-overlay release-contract tests for migration 162.

The UAT release runner replays the base lane plus this isolated overlay, so
this suite verifies additive, replay-safe DDL and the frozen service columns.
It does not require a live database.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "164_hushh_tech_uat_client_foundation.sql"
ROLLBACK_NAME = "164_hushh_tech_uat_client_foundation.rollback.sql"
MIGRATION = ROOT / "db" / "migrations" / MIGRATION_NAME
ROLLBACK = ROOT / "db" / "migrations" / "rollback" / ROLLBACK_NAME
MANIFEST = ROOT / "db" / "release_migration_manifest.json"
CONTRACTS = ROOT / "db" / "contracts"
REPO_ROOT = ROOT.parent
SYNTHETIC_LEGACY_PROJECT = "hushh-tech-uat-synthetic"

EXPECTED_TABLES: dict[str, set[str]] = {
    "hushh_tech_launch_authorizations": {
        "authorization_id",
        "code_hash",
        "firebase_uid",
        "audience",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "firebase_valid_after_ms",
        "created_at_ms",
        "expires_at_ms",
        "consumed_at_ms",
    },
    "hushh_tech_account_links": {
        "link_id",
        "legacy_project",
        "legacy_user_uuid",
        "firebase_uid",
        "status",
        "linked_at_ms",
        "revoked_at_ms",
        "created_by_app_id",
        "provenance",
    },
    "hushh_tech_link_events": {
        "event_id",
        "link_id",
        "firebase_uid",
        "legacy_project",
        "legacy_user_uuid",
        "event_type",
        "app_id",
        "proof_session_id",
        "metadata",
        "created_at_ms",
    },
    "hushh_tech_shadow_records": {
        "record_id",
        "legacy_project",
        "legacy_user_uuid",
        "record_type",
        "payload",
        "source_hash",
        "source_deleted",
        "imported_at_ms",
        "updated_at_ms",
    },
    "hushh_tech_migration_runs": {
        "run_id",
        "fixture_name",
        "fixture_hash",
        "status",
        "record_count",
        "applied_count",
        "skipped_count",
        "checkpoint_sequence",
        "started_at_ms",
        "completed_at_ms",
        "updated_at_ms",
        "error_code",
    },
    "hushh_tech_migration_events": {
        "event_id",
        "run_id",
        "fixture_hash",
        "phase",
        "outcome",
        "sequence",
        "event_at_ms",
        "metadata",
    },
}

_LINE_COMMENT = re.compile(r"--.*?$", re.MULTILINE)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_SINGLE_QUOTED = re.compile(r"'(?:[^']|'')*'", re.DOTALL)


def _statements_only(sql: str) -> str:
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", sql))


def _ddl_without_literals(sql: str) -> str:
    return _SINGLE_QUOTED.sub("''", _statements_only(sql))


def test_migration_is_registered_only_in_the_uat_overlay() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]
    overlay = manifest["environment_overlays"]["uat"]

    assert MIGRATION.exists()
    assert ROLLBACK.exists()
    assert MIGRATION_NAME not in ordered
    assert overlay == [MIGRATION_NAME]
    assert MIGRATION_NAME not in manifest["groups"]["iam"]
    assert len(ordered) == len(set(ordered))
    assert "161_atomic_pkm_scope_exposure.sql" in ordered
    assert not set(ordered).intersection(overlay)
    assert ROLLBACK_NAME not in ordered
    assert ROLLBACK_NAME not in overlay


def test_only_uat_contract_advances_and_names_the_frozen_columns() -> None:
    dev = json.loads((CONTRACTS / "dev_minimum_schema.json").read_text(encoding="utf-8"))
    prod = json.loads((CONTRACTS / "prod_core_schema.json").read_text(encoding="utf-8"))
    uat = json.loads((CONTRACTS / "uat_integrated_schema.json").read_text(encoding="utf-8"))

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    base_head = int(manifest["ordered_migrations"][-1].split("_", 1)[0])
    uat_head = int(manifest["environment_overlays"]["uat"][-1].split("_", 1)[0])

    assert dev["expected_migration_version"] == base_head
    assert prod["expected_migration_version"] == base_head
    assert uat["expected_migration_version"] == uat_head
    for contract in (dev, prod):
        assert not set(EXPECTED_TABLES).intersection(contract["required_tables"])
    for table, expected_columns in EXPECTED_TABLES.items():
        assert set(uat["required_tables"][table]) == expected_columns

    assert prod["migration_version_policy"] == "exact"
    assert uat["migration_version_policy"] == "exact"
    assert dev["migration_version_policy"] == "minimum"
    assert set(uat["required_tables"]) - set(prod["required_tables"]) == set(EXPECTED_TABLES)


def test_release_runner_selects_the_safe_base_or_explicit_uat_overlay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from db import migrate

    production = migrate.release_migration_files("production")
    uat = migrate.release_migration_files("uat")

    assert production == migrate.BASE_RELEASE_MIGRATION_FILES
    assert MIGRATION_NAME not in production
    assert uat == production + (MIGRATION_NAME,)
    with pytest.raises(ValueError, match="Unsupported release environment"):
        migrate.release_migration_files("development")

    for key in (
        "HUSSH_RELEASE_ENVIRONMENT",
        "GCP_PROJECT_ID",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
    ):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError, match="UAT release target verification failed"):
        migrate.assert_uat_release_target("uat")

    monkeypatch.setenv("HUSSH_RELEASE_ENVIRONMENT", "uat")
    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-uat")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )
    migrate.assert_uat_release_target("uat")


class _StopAfterFirstDdl(RuntimeError):
    pass


class _AttestationConnection:
    def __init__(
        self, events: list[str], *, row: dict | None = None, error: Exception | None = None
    ):
        self.events = events
        self.row = row
        self.error = error

    async def fetchrow(self, _sql: str):
        self.events.append("attestation")
        if self.error is not None:
            raise self.error
        return self.row


class _AcquireConnection:
    def __init__(self, connection: _AttestationConnection):
        self.connection = connection

    async def __aenter__(self) -> _AttestationConnection:
        return self.connection

    async def __aexit__(self, *_args: object) -> None:
        return None


class _AttestationPool:
    def __init__(self, connection: _AttestationConnection, events: list[str]):
        self.connection = connection
        self.events = events

    def acquire(self) -> _AcquireConnection:
        return _AcquireConnection(self.connection)

    async def execute(self, _sql: str):
        self.events.append("ddl")
        raise _StopAfterFirstDdl


def _attested_uat_row(**overrides: object) -> dict[str, object]:
    from hushh_mcp.services.hushh_tech_uat_database_attestation import (
        UAT_POSTGRES_SYSTEM_IDENTIFIER,
    )

    row: dict[str, object] = {
        "database_name": "postgres",
        "database_role": "hushh_uat_app",
        "server_version_num": 150018,
        "system_identifier": UAT_POSTGRES_SYSTEM_IDENTIFIER,
    }
    row.update(overrides)
    return row


def _set_uat_target_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSSH_RELEASE_ENVIRONMENT", "uat")
    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-uat")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )


@pytest.mark.parametrize(
    ("row", "error", "message"),
    [
        (
            _attested_uat_row(system_identifier="9999999999999999999"),
            None,
            "not the attested UAT target",
        ),
        (None, PermissionError("pg_control_system denied"), "identity is unavailable"),
        ({"database_name": "postgres"}, None, "identity is unavailable"),
    ],
)
def test_release_runner_rejects_wrong_or_unavailable_connected_uat_identity(
    monkeypatch: pytest.MonkeyPatch,
    row: dict[str, object] | None,
    error: Exception | None,
    message: str,
) -> None:
    from db import migrate

    _set_uat_target_environment(monkeypatch)
    events: list[str] = []
    connection = _AttestationConnection(events, row=row, error=error)
    pool = _AttestationPool(connection, events)

    with pytest.raises(RuntimeError, match=message):
        asyncio.run(migrate.run_release_migration(pool, release_environment="uat"))

    assert events == ["attestation"]


def test_uat_release_attests_the_same_connection_before_migration_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from db import migrate

    _set_uat_target_environment(monkeypatch)
    events: list[str] = []
    connection = _AttestationConnection(events, row=_attested_uat_row())
    pool = _AttestationPool(connection, events)

    async def record_apply(
        _pool: object,
        _filenames: tuple[str, ...],
        *,
        label: str,
        mode: object,
        connection: object | None = None,
    ) -> None:
        del label, mode
        assert connection is pool.connection
        events.append("migration_authority")

    monkeypatch.setattr(migrate, "apply_migration_files", record_apply)
    asyncio.run(migrate.run_release_migration(pool, release_environment="uat"))

    assert events == ["attestation", "migration_authority"]


@pytest.mark.parametrize("release_environment", ["UAT", " uat ", "uat ", " uat"])
def test_programmatic_release_runner_rejects_noncanonical_uat_lane_before_sql(
    monkeypatch: pytest.MonkeyPatch,
    release_environment: str,
) -> None:
    from db import migrate

    _set_uat_target_environment(monkeypatch)
    events: list[str] = []
    connection = _AttestationConnection(events, row=_attested_uat_row())
    pool = _AttestationPool(connection, events)

    with pytest.raises(ValueError, match="Unsupported release environment"):
        asyncio.run(
            migrate.run_release_migration(
                pool,
                release_environment=release_environment,
            )
        )

    assert events == []


@pytest.mark.parametrize("operation", ["init", "full"])
def test_uat_init_and_full_attest_before_the_first_ddl(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    from db import migrate

    _set_uat_target_environment(monkeypatch)
    events: list[str] = []
    connection = _AttestationConnection(events, row=_attested_uat_row())
    pool = _AttestationPool(connection, events)

    async def stop_at_first_init_ddl(_pool: object) -> None:
        events.append("ddl")
        raise _StopAfterFirstDdl

    monkeypatch.setattr(migrate, "create_vault_keys", stop_at_first_init_ddl)
    runner = migrate.run_init_migration if operation == "init" else migrate.run_full_migration
    with pytest.raises(_StopAfterFirstDdl):
        asyncio.run(runner(pool, release_environment="uat"))

    assert events[:2] == ["attestation", "ddl"]


def test_deploy_workflows_select_explicit_release_lanes_and_uat_target() -> None:
    uat_workflow = (REPO_ROOT / ".github" / "workflows" / "deploy-uat.yml").read_text(
        encoding="utf-8"
    )
    prod_workflow = (REPO_ROOT / ".github" / "workflows" / "deploy-production.yml").read_text(
        encoding="utf-8"
    )

    assert "db/migrate.py --release" in uat_workflow
    assert uat_workflow.count("--release-environment uat") >= 3
    assert "export HUSSH_RELEASE_ENVIRONMENT=uat" in uat_workflow
    assert 'export CLOUDSQL_INSTANCE_CONNECTION_NAME="${UAT_CLOUDSQL_INSTANCE}"' in uat_workflow
    assert "hushh-pda-uat:us-central1:hushh-uat-pg" in uat_workflow
    assert "db/migrate.py --release" in prod_workflow
    assert prod_workflow.count("--release-environment production") >= 2


def test_migration_creates_only_additive_replay_safe_tables_and_indexes() -> None:
    ddl = _ddl_without_literals(MIGRATION.read_text(encoding="utf-8"))
    lowered = ddl.lower()

    for table in EXPECTED_TABLES:
        assert f"create table if not exists {table}" in lowered
    assert lowered.count("create table if not exists hushh_tech_") == len(EXPECTED_TABLES)
    assert "create index " not in lowered.replace("create index if not exists", "")
    for forbidden in (
        "alter table",
        "drop table",
        "drop column",
        "delete from",
        "insert into",
        "truncate",
    ):
        assert forbidden not in lowered
    assert not re.search(r"\bupdate\s+hushh_tech_[a-z0-9_]+\s+set\b", lowered)


def test_launch_codes_are_hashed_pkce_s256_single_use_state() -> None:
    sql = " ".join(_statements_only(MIGRATION.read_text(encoding="utf-8")).split())

    assert "authorization_id TEXT PRIMARY KEY" in sql
    assert "code_hash TEXT NOT NULL UNIQUE" in sql
    assert "code_challenge TEXT NOT NULL" in sql
    assert "code_challenge_method TEXT NOT NULL DEFAULT 'S256'" in sql
    assert "CHECK (code_challenge_method = 'S256')" in sql
    assert "firebase_valid_after_ms BIGINT NOT NULL" in sql
    assert "expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms)" in sql
    assert "consumed_at_ms BIGINT" in sql
    assert "WHERE consumed_at_ms IS NULL" in sql


def test_active_link_uniqueness_and_append_only_event_shape_are_present() -> None:
    sql = " ".join(_statements_only(MIGRATION.read_text(encoding="utf-8")).split())

    assert "legacy_user_uuid TEXT NOT NULL" in sql
    assert "status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))" in sql
    assert (
        "ON hushh_tech_account_links (legacy_project, legacy_user_uuid) WHERE status = 'active'"
        in sql
    )
    assert (
        "ON hushh_tech_account_links (legacy_project, firebase_uid) WHERE status = 'active'" in sql
    )
    event_table = sql.split("CREATE TABLE IF NOT EXISTS hushh_tech_link_events", 1)[1]
    event_table = event_table.split("CREATE INDEX", 1)[0]
    assert "link_id TEXT," in event_table
    assert "firebase_uid TEXT NOT NULL," in event_table
    assert "REFERENCES hushh_tech_account_links" not in event_table
    assert "REFERENCES actor_profiles" not in event_table
    assert "proof_session_id TEXT UNIQUE" in event_table
    for event_type in (
        "attempted",
        "relink_attempt",
        "activated",
        "conflict",
        "revoked",
        "recovery_attempted",
        "recovered",
        "migration_imported",
    ):
        assert f"'{event_type}'" in sql


def test_link_event_insert_is_allowed_while_update_and_delete_are_rejected() -> None:
    sql = " ".join(_statements_only(MIGRATION.read_text(encoding="utf-8")).split())
    function_name = "hushh_tech_link_events_enforce_append_only"
    function = sql.split(f"CREATE OR REPLACE FUNCTION {function_name}()", 1)[1]
    function = function.split("DROP TRIGGER", 1)[0]
    trigger = sql.split(f"CREATE TRIGGER {function_name}", 1)[1]
    trigger = trigger.split("CREATE TABLE IF NOT EXISTS hushh_tech_shadow_records", 1)[0]

    assert "RAISE EXCEPTION" in function
    assert "USING ERRCODE = '55000'" in function
    assert "BEFORE UPDATE OR DELETE ON hushh_tech_link_events" in trigger
    assert f"EXECUTE FUNCTION {function_name}()" in trigger
    # INSERT is deliberately outside the trigger event list, so normal event
    # appends remain possible while either mutation path invokes the exception.
    assert "INSERT" not in trigger


def test_migration_event_ledger_is_bounded_and_append_only() -> None:
    sql = " ".join(_statements_only(MIGRATION.read_text(encoding="utf-8")).split())
    table = sql.split("CREATE TABLE IF NOT EXISTS hushh_tech_migration_events", 1)[1]
    table = table.split("CREATE INDEX", 1)[0]

    assert "run_id TEXT NOT NULL" in table
    assert "fixture_hash TEXT NOT NULL CHECK (fixture_hash ~ '^[0-9a-f]{64}$')" in table
    assert "phase TEXT NOT NULL CHECK (phase IN ('start', 'record', 'terminal'))" in table
    assert "'started'" in table
    assert "'applied'" in table
    assert "'skipped'" in table
    assert "'failed'" in table
    assert "'completed'" in table
    assert "sequence INTEGER NOT NULL CHECK (sequence >= 0)" in table
    assert "event_at_ms BIGINT NOT NULL CHECK (event_at_ms >= 0)" in table
    assert "jsonb_typeof(metadata) = 'object'" in table
    assert "octet_length(metadata::TEXT) <= 2048" in table
    assert "REFERENCES hushh_tech_migration_runs" not in table

    function_name = "hushh_tech_migration_events_enforce_append_only"
    function = sql.split(f"CREATE OR REPLACE FUNCTION {function_name}()", 1)[1]
    function = function.split("DROP TRIGGER", 1)[0]
    trigger = sql.split(f"CREATE TRIGGER {function_name}", 1)[1]
    trigger = trigger.split("COMMENT ON TABLE", 1)[0]

    assert "RAISE EXCEPTION" in function
    assert "USING ERRCODE = '55000'" in function
    assert "BEFORE UPDATE OR DELETE ON hushh_tech_migration_events" in trigger
    assert f"EXECUTE FUNCTION {function_name}()" in trigger
    # INSERT is deliberately outside the trigger event list.
    assert "INSERT" not in trigger


@pytest.mark.parametrize(
    ("legacy_project", "accepted"),
    [
        (SYNTHETIC_LEGACY_PROJECT, True),
        ("hushh-tech-production", False),
        ("hushh-tech-uat", False),
        ("", False),
    ],
)
def test_mapping_audit_and_shadow_tables_accept_only_the_synthetic_project(
    legacy_project: str,
    accepted: bool,
) -> None:
    sql = _statements_only(MIGRATION.read_text(encoding="utf-8"))
    for table in (
        "hushh_tech_account_links",
        "hushh_tech_link_events",
        "hushh_tech_shadow_records",
    ):
        table_ddl = sql.split(f"CREATE TABLE IF NOT EXISTS {table}", 1)[1]
        table_ddl = table_ddl.split(");", 1)[0]
        match = re.search(r"CHECK \(legacy_project = '([^']+)'\)", table_ddl)
        assert match is not None, f"{table} lacks the synthetic-project CHECK"
        assert (legacy_project == match.group(1)) is accepted


def test_shadow_table_has_only_the_frozen_metadata_record_types() -> None:
    statements = " ".join(_statements_only(MIGRATION.read_text(encoding="utf-8")).split())
    shadow = statements.split("CREATE TABLE IF NOT EXISTS hushh_tech_shadow_records", 1)[1]
    shadow = shadow.split("CREATE INDEX", 1)[0]

    for record_type in ("profile", "onboarding", "access_state", "report_asset"):
        assert f"'{record_type}'" in shadow
    for forbidden in ("consent", "revocation", "email", "phone", "token", "private_key"):
        assert f"'{forbidden}'" not in shadow.lower()
    assert "UNIQUE (legacy_project, legacy_user_uuid, record_type)" in shadow
    assert "source_deleted BOOLEAN NOT NULL DEFAULT FALSE" in shadow
    assert "source_hash TEXT NOT NULL" in shadow


def test_migration_statements_store_no_sensitive_credentials_or_production_source() -> None:
    ddl = _ddl_without_literals(MIGRATION.read_text(encoding="utf-8")).lower()

    for forbidden in (
        "supabase_url",
        "supabase_key",
        "firebase_refresh_token",
        "legacy_session_token",
        "owner_token",
        "private_key",
        "pkm_plaintext",
        "email text",
        "phone text",
    ):
        assert forbidden not in ddl


def test_rollback_refuses_nonempty_tables_and_drops_only_migration_162_tables() -> None:
    raw = ROLLBACK.read_text(encoding="utf-8")
    statements = _statements_only(raw)
    lowered = _ddl_without_literals(raw).lower()

    assert "raise exception" in statements.lower()
    assert "select exists" in statements.lower()
    assert "to_regclass" in statements.lower()
    dropped = set(re.findall(r"drop\s+table\s+if\s+exists\s+([a-z0-9_]+)", lowered))
    assert dropped == set(EXPECTED_TABLES)
    assert "DROP FUNCTION IF EXISTS hushh_tech_link_events_enforce_append_only()" in statements
    assert "DROP FUNCTION IF EXISTS hushh_tech_migration_events_enforce_append_only()" in statements
    assert "alter table" not in lowered
    assert "cascade" not in lowered
