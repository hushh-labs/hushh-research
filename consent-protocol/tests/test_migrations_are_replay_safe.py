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
