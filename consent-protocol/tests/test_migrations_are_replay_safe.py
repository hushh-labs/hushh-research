"""Every `ALTER TABLE ... ADD CONSTRAINT` must survive being run twice.

Root cause this prevents
------------------------
Both consent-protocol environments run the FULL migration set in replay mode
on every deploy. There is no ledger that skips already-applied files, so a
migration is re-executed against a database it already applied cleanly to --
and Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. An unguarded add is
therefore fine exactly once and fatal from the second deploy onward.

Migration 158 shipped without that property. Its DO block dropped every stale
`member_limit` CHECK constraint *except* the one it was about to create:

    AND con.conname <> 'one_location_circles_member_limit_bounds'

so it cleared every historical name and left the target name -- which is
precisely the name its own previous run leaves behind. The next deploy that
replayed it died with `DuplicateObjectError: constraint
"one_location_circles_member_limit_bounds" ... already exists`, the
transaction aborted, the advisory unlock then failed with
`InFailedSQLTransactionError`, and the release rolled both Cloud Run
revisions back. 159 was written by copying 158's shape and inherited the same
bug before it had ever run once.

That happened, was fixed, was deleted wholesale by the mass revert
`a60c51dfc`, shipped broken a second time, and was fixed again in #5641 --
this time with no test. This file is the guard, so there is no third time.

Why a whole-set rule rather than two assertions
-----------------------------------------------
The bug is not a property of migration 158. It is a property of the idiom, and
158 got it wrong by copying a neighbour. A test pinned to 158 and 159 would
have caught neither the original nor the copy. All 96 add-constraint sites on
`main` already satisfy this rule, so it costs nothing today and refuses the
next copy of the mistake.

Static by design: this reads the shipped SQL rather than exercising a live
database, so it runs in the ordinary unit lane with no Postgres to stand up --
the same choice every other migration test in this directory makes.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "db" / "migrations"

_ADD_CONSTRAINT = re.compile(r"ADD\s+CONSTRAINT\s+([a-zA-Z0-9_]+)", re.IGNORECASE)


# `DROP CONSTRAINT x`, with or without IF EXISTS, and whether it sits at the
# top level or inside an `IF EXISTS (...) THEN ... END IF` block. Both are
# replay-safe; only the second is needed when the constraint may be absent.
def _dropped_before(name: str, text: str) -> bool:
    return bool(
        re.search(
            r"DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?" + re.escape(name) + r"\b",
            text,
            re.IGNORECASE,
        )
    )


# The other accepted idiom: the add is wrapped in a NOT EXISTS check naming
# this constraint, so a replay simply skips it. Both catalogue spellings are
# in use -- `pg_constraint.conname` and
# `information_schema.constraint_column_usage.constraint_name` -- and either
# answers the same question.
def _guarded_by_not_exists(name: str, text: str) -> bool:
    for opener in re.finditer(r"IF\s+NOT\s+EXISTS\s*\(", text, re.IGNORECASE):
        window = text[opener.start() :]
        if re.search(
            r"(?:conname|constraint_name)\s*=\s*'" + re.escape(name) + r"'",
            window,
            re.IGNORECASE,
        ):
            return True
    return False


def _executable(sql: str) -> str:
    """The executable half of a migration, with `--` commentary stripped.

    These files explain themselves at length and quote the shapes they are
    replacing, so a raw-text search would accept a migration whose only
    remaining drop lives in a sentence describing the bug it once had.
    """
    return "\n".join(
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    )


def _unguarded_adds() -> list[str]:
    findings: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        sql = _executable(path.read_text(encoding="utf-8"))
        for match in _ADD_CONSTRAINT.finditer(sql):
            name = match.group(1)
            preceding = sql[: match.start()]
            if _dropped_before(name, preceding):
                continue
            if _guarded_by_not_exists(name, preceding):
                continue
            findings.append(f"{path.name}: {name}")
    return findings


def test_every_added_constraint_survives_a_replay() -> None:
    unguarded = _unguarded_adds()
    assert not unguarded, (
        "These constraints are added without surviving a second run, which is "
        "what every deploy does:\n  "
        + "\n  ".join(unguarded)
        + "\n\nPostgres has no ADD CONSTRAINT IF NOT EXISTS. Use one of the two "
        "idioms already used throughout this directory:\n"
        "  1. DROP CONSTRAINT IF EXISTS <name>;  immediately before the ADD\n"
        "  2. wrap the ADD in IF NOT EXISTS (SELECT ... conname = '<name>')\n"
        "Excluding the target name from a cleanup loop is NOT one of them: "
        "that name is exactly what the migration's own previous run left behind."
    )


def test_the_two_circle_migrations_that_caused_this_are_covered() -> None:
    """The rule is general, but these two are why it exists.

    Named explicitly so that deleting them from the migration set -- which has
    already happened once, via the mass revert -- cannot quietly reduce this
    file to a rule with nothing left to check.
    """
    for migration, constraint in (
        (
            "158_one_location_circle_member_limit_100.sql",
            "one_location_circles_member_limit_bounds",
        ),
        (
            "159_one_location_circle_invite_max_uses_100.sql",
            "one_location_circle_invite_codes_max_uses_bounds",
        ),
    ):
        path = MIGRATIONS_DIR / migration
        assert path.exists(), f"{migration} is missing from the migration set"
        sql = _executable(path.read_text(encoding="utf-8"))

        added = re.search(
            r"ADD\s+CONSTRAINT\s+" + re.escape(constraint) + r"\b", sql, re.IGNORECASE
        )
        assert added is not None, f"{migration} no longer adds {constraint}"

        preceding = sql[: added.start()]
        assert _dropped_before(constraint, preceding) or _guarded_by_not_exists(
            constraint, preceding
        ), f"{migration} adds {constraint} without dropping or guarding it first"


@pytest.fixture
def replay_pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        yield server
    finally:
        server.stop()


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_oauth_registration_replay_preserves_records_and_enforces_policy(replay_pg):
    from psycopg2.errors import CheckViolation

    pg = replay_pg
    # Only the predecessor columns consumed by 409; no owner information or keys.
    pg.execute("""
      CREATE TABLE developer_apps (
        app_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'self_serve',
        owner_firebase_uid TEXT, crm_id TEXT,
        oauth_client_credentials_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        schema_profile TEXT NOT NULL DEFAULT 'standard',
        allowed_tool_groups JSONB NOT NULL DEFAULT '["core_consent"]',
        allowed_capabilities JSONB NOT NULL DEFAULT '[]',
        CONSTRAINT developer_apps_kind_check CHECK (kind IN ('self_serve','partner_crm')));
      CREATE TABLE developer_oauth_clients (
        app_id TEXT PRIMARY KEY, client_secret_hash TEXT NOT NULL,
        client_secret_prefix TEXT NOT NULL,
        allowed_grant_types JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]',
        mcp_execution_mode TEXT NOT NULL DEFAULT 'execute');
      CREATE TABLE developer_oauth_authorizations (id INT PRIMARY KEY);
      CREATE TABLE developer_oauth_tokens (
        app_id TEXT, authorization_id INT, revoked_at BIGINT);
    """)
    migration = MIGRATIONS_DIR / "409_mcp_oauth_client_registration.sql"
    pg.apply_file(migration)
    pg.execute("""
      INSERT INTO developer_apps(app_id,kind) VALUES ('synthetic-client','oauth_dynamic');
      INSERT INTO developer_oauth_clients
        (app_id,client_secret_hash,client_secret_prefix,registration_method,token_endpoint_auth_method)
        VALUES ('synthetic-client','','','cimd','none');
      INSERT INTO developer_oauth_authorizations(id,resource) VALUES (1,'https://mcp.example.test/mcp/');
      INSERT INTO developer_oauth_tokens(app_id,authorization_id,resource)
        VALUES ('synthetic-client',1,'https://mcp.example.test/mcp/');
    """)
    tables = (
        "developer_apps",
        "developer_oauth_clients",
        "developer_oauth_authorizations",
        "developer_oauth_tokens",
    )
    before = {table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t") for table in tables}
    pg.apply_file(migration)
    assert {table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t") for table in tables} == before
    with pytest.raises(CheckViolation):
        pg.execute("UPDATE developer_apps SET oauth_client_credentials_enabled=TRUE")
    with pytest.raises(CheckViolation):
        pg.execute("UPDATE developer_oauth_clients SET client_secret_hash='synthetic-invalid'")


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_identity_and_persona_seeds_preserve_current_authority_on_replay(replay_pg):
    pg = replay_pg
    pg.execute("INSERT INTO vault_keys(user_id) VALUES ('synthetic-owner')")
    for name in (
        "020_ria_iam_foundation.sql",
        "021_runtime_persona_state.sql",
        "037_actor_identity_cache.sql",
    ):
        pg.apply_file(MIGRATIONS_DIR / name)
    pg.execute("UPDATE runtime_persona_state SET last_active_persona='ria'")
    pg.execute("UPDATE actor_identity_cache SET display_name='Synthetic current name'")
    pg.execute("UPDATE consent_scope_templates SET active=FALSE, version=2")
    tables = (
        "actor_profiles",
        "runtime_persona_state",
        "actor_identity_cache",
        "consent_scope_templates",
    )
    before = {
        table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t ORDER BY 1") for table in tables
    }
    for name in (
        "020_ria_iam_foundation.sql",
        "021_runtime_persona_state.sql",
        "037_actor_identity_cache.sql",
    ):
        pg.apply_file(MIGRATIONS_DIR / name)
    assert {
        table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t ORDER BY 1") for table in tables
    } == before
    # The original code overwrites both current persona and template policy.
    archive = MIGRATIONS_DIR.parent / "legacy/scope-commerce-dev-2349b160/replay-source-a6b6c294"
    pg.apply_file(archive / "021_runtime_persona_state.sql")
    assert pg.execute("SELECT last_active_persona FROM runtime_persona_state") == [("investor",)]


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_pkm_cutover_imports_once_without_replacing_records_or_recreating_scopes(replay_pg):
    pg = replay_pg
    pg.execute("""
      CREATE TABLE world_model_index_v2 (
        user_id TEXT, available_domains TEXT[], domain_summaries JSONB,
        computed_tags TEXT[], activity_score DOUBLE PRECISION,
        last_active_at TIMESTAMPTZ, total_attributes INT,
        created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      INSERT INTO world_model_index_v2 VALUES
        ('synthetic-owner', ARRAY['synthetic'], '{}', ARRAY[]::TEXT[], 1, now(), 1, now(), now());
      CREATE TABLE user_domain_manifests (
        user_id TEXT, domain TEXT, manifest_version INT, structure_decision JSONB,
        summary_projection JSONB, top_level_scope_paths TEXT[], externalizable_paths TEXT[],
        path_count INT, externalizable_path_count INT, last_structured_at TIMESTAMPTZ,
        last_content_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      INSERT INTO user_domain_manifests VALUES
        ('synthetic-owner','synthetic',1,'{}','{}',ARRAY['section'],ARRAY['section'],
         1,1,now(),now(),now(),now());
      CREATE TABLE user_domain_manifest_paths (
        user_id TEXT, domain TEXT, json_path TEXT, parent_path TEXT,
        path_type TEXT, exposure_eligibility BOOLEAN, consent_label TEXT,
        sensitivity_label TEXT, source_agent TEXT, created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ);
      INSERT INTO user_domain_manifest_paths VALUES
        ('synthetic-owner','synthetic','section',NULL,'leaf',TRUE,'Synthetic',
         'confidential','synthetic',now(),now());
      CREATE TABLE world_model_domain_blobs (
        user_id TEXT, domain TEXT, encrypted_data_ciphertext TEXT,
        encrypted_data_iv TEXT, encrypted_data_tag TEXT, algorithm TEXT,
        data_version INT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      INSERT INTO world_model_domain_blobs VALUES
        ('synthetic-owner','synthetic','synthetic-old','iv','tag','aes-256-gcm',1,now(),now()),
        ('synthetic-orphan','orphan','synthetic-retained','iv','tag','aes-256-gcm',1,now(),now());
    """)
    pg.apply_file(MIGRATIONS_DIR / "030_pkm_cutover.sql")
    assert pg.execute("SELECT COUNT(*) FROM pkm_scope_registry") == [(1,)]
    assert pg.execute("SELECT ciphertext FROM pkm_blobs WHERE user_id='synthetic-orphan'") == [
        ("synthetic-retained",)
    ]
    pg.execute("""
      UPDATE pkm_index SET total_attributes=7;
      DELETE FROM pkm_blobs WHERE user_id='synthetic-owner';
      INSERT INTO pkm_blobs(user_id,domain,segment_id,ciphertext,iv,tag,content_revision)
        VALUES ('synthetic-owner','synthetic','current-segment','synthetic-current','iv','tag',7);
      DELETE FROM pkm_manifest_paths;
      UPDATE pkm_manifests SET manifest_version=7, externalizable_paths=ARRAY[]::TEXT[];
      DELETE FROM pkm_scope_registry;
    """)
    tables = ("pkm_index", "pkm_blobs", "pkm_manifests", "pkm_scope_registry", "pkm_manifest_paths")
    before = {
        table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t ORDER BY 1") for table in tables
    }
    pg.apply_file(MIGRATIONS_DIR / "030_pkm_cutover.sql")
    assert {
        table: pg.execute(f"SELECT to_jsonb(t) FROM {table} t ORDER BY 1") for table in tables
    } == before
    archive = MIGRATIONS_DIR.parent / "legacy/scope-commerce-dev-2349b160/replay-source-a6b6c294"
    pg.apply_file(archive / "030_pkm_cutover.sql")
    assert pg.execute(
        "SELECT ciphertext FROM pkm_blobs WHERE segment_id='root' AND user_id='synthetic-owner'"
    ) == [("synthetic-old",)]
    assert pg.execute("SELECT COUNT(*) FROM pkm_scope_registry") == [(1,)]
    assert pg.execute("SELECT COUNT(*) FROM pkm_manifest_paths") == [(1,)]


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_recovery_version_backfill_preserves_an_established_version_and_noop_rows():
    pg = TempPostgres()
    try:
        pg.start()
        pg.execute("""
          INSERT INTO pkm_manifests (user_id,domain,pkm_contract_version,summary_projection)
          VALUES ('synthetic-owner','versioned','9.0.0',
            '{"pkm_contract_version":"1.2.3","readable_projection_version":"2.4.6"}'),
            ('synthetic-owner','unset','0.0.0','{}');
        """)
        untouched = pg.execute("SELECT to_jsonb(t) FROM pkm_manifests t WHERE domain='unset'")
        pg.apply_file(MIGRATIONS_DIR / "098_pkm_v7_recovery_foundation.sql")
        assert pg.execute(
            "SELECT pkm_contract_version,readable_projection_version "
            "FROM pkm_manifests WHERE domain='versioned'"
        ) == [("9.0.0", "2.4.6")]
        assert (
            pg.execute("SELECT to_jsonb(t) FROM pkm_manifests t WHERE domain='unset'") == untouched
        )
        pg.execute(
            "UPDATE pkm_manifests SET readable_projection_version='0.0.0' WHERE domain='versioned'"
        )
        archive = (
            MIGRATIONS_DIR.parent / "legacy/scope-commerce-dev-2349b160/replay-source-a6b6c294"
        )
        pg.apply_file(archive / "098_pkm_v7_recovery_foundation.sql")
        assert pg.execute(
            "SELECT pkm_contract_version FROM pkm_manifests WHERE domain='versioned'"
        ) == [("1.2.3",)]
    finally:
        pg.stop()


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
def test_circle_constraint_preserves_valid_catalog_but_repairs_a_wrong_predicate(replay_pg):
    pg = replay_pg
    pg.execute("""
      CREATE TABLE one_location_circles (
        id UUID PRIMARY KEY, owner_user_id TEXT, is_system BOOLEAN,
        status TEXT, updated_at TIMESTAMPTZ);
    """)
    migration = MIGRATIONS_DIR / "163_one_location_system_circle_kinds.sql"
    pg.apply_file(migration)
    query = (
        "SELECT oid,pg_get_constraintdef(oid,TRUE) FROM pg_constraint "
        "WHERE conrelid='one_location_circles'::regclass "
        "AND conname='one_location_circles_system_kind_values'"
    )
    before = pg.execute(query)
    pg.apply_file(migration)
    assert pg.execute(query) == before
    pg.execute("""
      ALTER TABLE one_location_circles DROP CONSTRAINT one_location_circles_system_kind_values;
      ALTER TABLE one_location_circles ADD CONSTRAINT one_location_circles_system_kind_values
        CHECK (system_kind IS NULL OR system_kind IN ('sms'));
    """)
    wrong = pg.execute(query)
    pg.apply_file(migration)
    assert pg.execute(query) != wrong
    pg.execute(
        "INSERT INTO one_location_circles(id,system_kind) "
        "VALUES ('00000000-0000-0000-0000-000000000001','trusted')"
    )


@pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")
@pytest.mark.parametrize("rich_dev", [False, True], ids=["canonical-417", "accepted-dev-972"])
def test_private_agent_graduation_preserves_owners_and_refuses_drift(
    replay_pg, monkeypatch, rich_dev
):
    """Actual canonical startup plus the accepted dev lineage; never a cloud DB."""
    import asyncio
    import json
    from contextlib import closing

    import asyncpg
    import psycopg2

    from db import migrate
    from db.account_cleanup_replay import SOURCES
    from db.migration_authority import MigrationAuthorityError, _replay_sql, build_manifest_entries
    from db.private_agent_adoption import execution_sql
    from tests.private_agent_release_postgres_support import (
        apply_release_successors,
        verify_managed_custody_roundtrip,
        verify_release_contract,
        verify_retained_release_records,
    )

    cp = MIGRATIONS_DIR.parent.parent
    server = replay_pg
    database = "synthetic_private_agent_release"
    server.execute("CREATE DATABASE " + database)
    server.execute(
        "CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN"
    )
    monkeypatch.setattr(
        migrate,
        "release_migration_files",
        lambda _environment: tuple(
            name for name in migrate.RELEASE_MIGRATION_FILES if int(name[:3]) <= 417
        ),
    )
    for name, value in {
        "DB_USER": "hushh",
        "DB_PASSWORD": "synthetic",
        "DB_HOST": "127.0.0.1",
        "DB_PORT": str(server.port),
        "DB_NAME": database,
        "DB_UNIX_SOCKET": server.dir,
        "GCP_PROJECT_ID": "local-schema-qualification",
        "ENVIRONMENT": "test",
        "HUSHH_RELEASE_ENVIRONMENT": "production",
        "HUSHH_MIGRATION_MODE": "replay",
    }.items():
        monkeypatch.setenv(name, value)

    with closing(
        psycopg2.connect(host=server.dir, port=server.port, user="hushh", dbname=database)
    ) as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute((cp / "db/legacy/init_legacy_schema.sql").read_text())
            if rich_dev:
                cur.execute((MIGRATIONS_DIR / "parked/900_personal_agent_registry.sql").read_text())

        async def initialize():
            pool = await asyncpg.create_pool(
                host=server.dir,
                port=server.port,
                user="hushh",
                database=database,
                min_size=1,
                max_size=2,
                command_timeout=60,
            )
            try:
                await migrate.run_init_migration(pool)
            finally:
                await pool.close()

        asyncio.run(initialize())
        if rich_dev:
            manifest = json.loads((cp / "db/dev_migration_manifest.json").read_text())
            for filename in manifest["ordered_migrations"]:
                if int(filename[:3]) in {900, 944, 955, 958, 965}:
                    continue
                with conn.cursor() as cur:
                    cur.execute((MIGRATIONS_DIR / "parked" / filename).read_text())
        apply_release_successors(conn, cp, retained_consumer=rich_dev)
        # Run the release guard's actual catalog reader against this disposable DB.
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "synthetic_release_db_guard", cp.parent / "scripts/ops/db_migration_release_guard.py"
        )
        guard = importlib.util.module_from_spec(spec)
        import sys

        monkeypatch.setitem(sys.modules, spec.name, guard)
        spec.loader.exec_module(guard)
        monkeypatch.setattr(
            guard,
            "_build_database_url_from_env",
            lambda: f"postgresql://hushh@/{database}?host={server.dir}&port={server.port}",
        )

        verify_release_contract(guard, cp, "prod_core_schema")
        verify_release_contract(guard, cp, "dev_minimum_schema")
        verify_retained_release_records(conn, cp)
        verify_managed_custody_roundtrip(conn, cp)
        verify_release_contract(guard, cp, "uat_integrated_schema")
        foundation = execution_sql(
            build_manifest_entries(MIGRATIONS_DIR, ["420_private_agent_lifecycle_foundation.sql"])[
                0
            ],
            replay=_replay_sql,
        )
        with conn.cursor() as cur:
            # Unrelated performance indexes remain valid; unreviewed effects do not.
            cur.execute("CREATE INDEX synthetic_performance ON personal_agent_registry(updated_at)")
            # Existing client/default grants must not survive adoption.
            cur.execute(
                "GRANT ALL ON personal_agent_cloud_removals TO anon,authenticated; GRANT ALL ON SEQUENCE personal_agent_deletion_tombstones_id_seq TO anon,authenticated; GRANT EXECUTE ON FUNCTION personal_agent_cloud_removal_ready() TO anon,authenticated"
            )
            cur.execute(foundation)
            for role in ("anon", "authenticated"):
                cur.execute(
                    "SELECT has_table_privilege(%s,'personal_agent_cloud_removals','SELECT'), has_sequence_privilege(%s,'personal_agent_deletion_tombstones_id_seq','USAGE'), has_function_privilege(%s,'personal_agent_cloud_removal_ready()','EXECUTE')",
                    (role, role, role),
                )
                assert cur.fetchone() == (False, False, False)
            cur.execute("SET ROLE service_role")
            try:
                cur.execute("SELECT personal_agent_cloud_removal_ready()")
                assert cur.fetchone() == (True,)
                cur.execute("SELECT count(*) FROM personal_agent_cloud_removals")
                assert cur.fetchone() == (1,)
                cur.execute(
                    "INSERT INTO personal_agent_deletion_tombstones(hushh_id) VALUES('synthetic-service-role-proof') RETURNING id"
                )
                assert cur.fetchone()[0] > 0
            finally:
                cur.execute("RESET ROLE")
            for ddl, cleanup, expected in (
                (
                    "CREATE UNIQUE INDEX synthetic_new_authority ON personal_agent_registry(space_id)",
                    "DROP INDEX synthetic_new_authority",
                    "indexes",
                ),
                (
                    "CREATE FUNCTION synthetic_bad_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER synthetic_bad BEFORE UPDATE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION synthetic_bad_trigger()",
                    "DROP TRIGGER synthetic_bad ON personal_agent_registry; DROP FUNCTION synthetic_bad_trigger()",
                    "triggers",
                ),
                (
                    "CREATE FUNCTION personal_agent_cloud_removal_ready(integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
                    "DROP FUNCTION personal_agent_cloud_removal_ready(integer)",
                    "function overload",
                ),
            ):
                cur.execute(ddl)
                with pytest.raises(psycopg2.errors.RaiseException, match=expected):
                    cur.execute(foundation)
                cur.execute("ROLLBACK")
                cur.execute(cleanup)
            # A missing forward helper must never restore a pre-cleanup function.
            cur.execute(
                "ALTER FUNCTION account_provider_cleanup_pending(text) RENAME TO synthetic_pending"
            )
            entry = build_manifest_entries(MIGRATIONS_DIR, ["201_account_deletion_tombstones.sql"])[
                0
            ]
            with pytest.raises(psycopg2.errors.RaiseException, match="successor missing"):
                cur.execute(execution_sql(entry, replay=_replay_sql))
            cur.execute("ROLLBACK")
            cur.execute(
                "ALTER FUNCTION synthetic_pending(text) RENAME TO account_provider_cleanup_pending"
            )
        with conn.cursor() as cur:
            for stem in (
                "418_account_provider_cleanup_staging",
                "419_account_generations",
                "420_private_agent_lifecycle_foundation",
                "421_cloud_removal_recovery",
            ):
                with pytest.raises(
                    psycopg2.errors.ObjectNotInPrerequisiteState, match="forward recovery"
                ):
                    cur.execute(
                        (MIGRATIONS_DIR / "rollback" / (stem + ".rollback.sql")).read_text()
                    )
                cur.execute("ROLLBACK")
        from dataclasses import replace

        for _version, filename in SOURCES:
            entry = build_manifest_entries(MIGRATIONS_DIR, [filename])[0]
            with pytest.raises(MigrationAuthorityError, match="checksum changed"):
                _replay_sql(replace(entry, sql=entry.sql + "\n-- unqualified source"))
