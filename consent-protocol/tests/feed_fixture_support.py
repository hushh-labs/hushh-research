"""Schema pieces that hand-built Feed fixtures need beyond their migration lists."""

from __future__ import annotations

import asyncio
from pathlib import Path

import asyncpg
from sqlalchemy import text

from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries

ROOT = Path(__file__).resolve().parents[1]

# list_feed plans its Calendar follow-up visibility fence on every read, so these
# relations must resolve even when the fixture holds no follow-up events. Shape of
# migrations 443 and 444 for the columns the fence names.
_FOLLOWUP_FENCE_DDL = """
CREATE TABLE calendar_email_followup_monitors(
  user_id TEXT, account_id TEXT, enabled BOOLEAN, notifications_enabled BOOLEAN);
CREATE TABLE calendar_email_followup_requests(
  id UUID, user_id TEXT, account_id TEXT, revision INT,
  reminder_sent_revision INT, state TEXT);
CREATE FUNCTION calendar_email_followup_grant_current(
  m calendar_email_followup_monitors) RETURNS BOOLEAN
  LANGUAGE sql AS 'SELECT FALSE';
"""


def add_followup_fence_relations(connection) -> None:
    connection.execute(text(_FOLLOWUP_FENCE_DDL))


def apply_fixture_migrations(engine, filenames):
    async def run():
        connection = await asyncpg.connect(
            engine.url.set(drivername="postgresql").render_as_string(hide_password=False)
        )
        try:
            return await apply_manifest_entries(
                connection,
                build_manifest_entries(ROOT / "db/migrations", filenames),
                mode=MigrationMode.REPLAY,
            )
        finally:
            await connection.close()

    return asyncio.run(run())
