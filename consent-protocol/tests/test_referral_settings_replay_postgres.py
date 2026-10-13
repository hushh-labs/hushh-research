"""Release replay preserves intentionally retired referral settings on PostgreSQL."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixture

from __future__ import annotations

from pathlib import Path

import asyncpg
import pytest

from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
V1 = "270_one_referral_gamification_settings.sql"
V2 = "289_one_referral_program_settings_v2.sql"


async def _replay(connection):
    await apply_manifest_entries(
        connection,
        build_manifest_entries(MIGRATIONS, (V1, V2)),
        mode=MigrationMode.REPLAY,
    )


async def _snapshot(connection):
    return await connection.fetch(
        "SELECT xmin::text AS row_version, * FROM one_referral_program_settings ORDER BY version"
    )


@pytest.mark.asyncio
async def test_retired_settings_replay_preserves_history_and_rejects_drift(connector_postgres_url):
    url = connector_postgres_url
    connection = await asyncpg.connect(
        user=url.username,
        password=url.password,
        database=url.database,
        host=url.query.get("host") or url.host,
        port=int(url.query.get("port") or url.port or 5432),
    )
    try:
        await connection.execute("""CREATE TABLE one_referral_policies(version INTEGER PRIMARY KEY);
          INSERT INTO one_referral_policies VALUES (1),(2);""")
        # Fresh databases still get the original v1 -> v2 transition.
        await _replay(connection)
        assert (
            await connection.fetchval(
                "SELECT version FROM one_referral_program_settings WHERE retired_at IS NULL"
            )
            == 2
        )
        active = await _snapshot(connection)
        await _replay(connection)
        assert await _snapshot(connection) == active
        await connection.execute("""INSERT INTO one_referral_reward_rounds
          (settings_version,cutoff_at,timezone) VALUES (2,'2026-10-01Z','Asia/Kolkata')""")

        # Reproduce the actual deployment failure after the published rollback.
        await connection.execute(
            (MIGRATIONS / "rollback" / V2.replace(".sql", ".rollback.sql")).read_text()
        )
        retired = await _snapshot(connection)
        with pytest.raises(asyncpg.RaiseError, match="not the active settings version"):
            await connection.execute((MIGRATIONS / V2).read_text())
        await connection.execute("ROLLBACK")
        await _replay(connection)
        await _replay(connection)
        assert await _snapshot(connection) == retired
        assert (
            await connection.fetchval("SELECT settings_version FROM one_referral_reward_rounds")
            == 2
        )

        # A later operator-selected version remains current; historical v2 is
        # not reactivated and no configuration or retirement timestamp changes.
        await connection.execute("""BEGIN;
          UPDATE one_referral_program_settings SET retired_at=clock_timestamp() WHERE version=1;
          INSERT INTO one_referral_program_settings
          SELECT (jsonb_populate_record(NULL::one_referral_program_settings,
            to_jsonb(s) || jsonb_build_object('version',3,'retired_at',NULL,
              'activated_at',clock_timestamp(),'feature_active',TRUE))).*
          FROM one_referral_program_settings s WHERE version=2;
          COMMIT;""")
        later = await _snapshot(connection)
        await _replay(connection)
        assert await _snapshot(connection) == later

        # A retired row is accepted only if every immutable policy value matches.
        original = dict(next(row for row in later if row["version"] == 2))
        changes = {
            "qualification_policy_version": 2,
            "points": '{"changed":1}',
            "milestones": '[{"changed":1}]',
            "streak_rules": '{"changed":1}',
            "flash_windows": '[{"changed":1}]',
            "weekly_schedule": '{"changed":1}',
            "prize_catalogue": '[{"changed":1}]',
            "tie_break_rules": '{"changed":1}',
            "fulfillment_config": '{"changed":1}',
            "feature_active": True,
        }
        for field, value in changes.items():
            query = f"UPDATE one_referral_program_settings SET {field}=$1 WHERE version=2"
            await connection.execute(query, value)
            drifted = await _snapshot(connection)
            with pytest.raises(asyncpg.RaiseError, match="configuration does not match"):
                await _replay(connection)
            assert await _snapshot(connection) == drifted
            await connection.execute(query, original[field])

        await connection.execute(
            "UPDATE one_referral_program_settings SET activated_at=NULL WHERE version=2"
        )
        unactivated = await _snapshot(connection)
        with pytest.raises(asyncpg.RaiseError, match="not the active settings version"):
            await _replay(connection)
        assert await _snapshot(connection) == unactivated
        await connection.execute(
            "UPDATE one_referral_program_settings SET activated_at=$1 WHERE version=2",
            original["activated_at"],
        )
        await connection.execute(
            "UPDATE one_referral_program_settings SET retired_at=clock_timestamp() WHERE version=3"
        )
        zero_active = await _snapshot(connection)
        with pytest.raises(asyncpg.RaiseError, match="expected exactly one active"):
            await _replay(connection)
        assert await _snapshot(connection) == zero_active
        assert await connection.fetchval("SELECT to_regclass('schema_migrations')") is None
    finally:
        await connection.close()
