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
# migrations 443 through 445 for the columns the fence names.
_FOLLOWUP_FENCE_DDL = """
CREATE TABLE calendar_email_followup_monitors(
  user_id TEXT, account_id TEXT, enabled BOOLEAN, notifications_enabled BOOLEAN);
CREATE TABLE calendar_email_followup_requests(
  id UUID, user_id TEXT, account_id TEXT, revision INT,
  reminder_sent_revision INT, state TEXT, suppressed_at TIMESTAMPTZ);
CREATE FUNCTION calendar_email_followup_grant_current(
  m calendar_email_followup_monitors) RETURNS BOOLEAN
  LANGUAGE sql AS 'SELECT FALSE';
"""


def add_followup_fence_relations(connection) -> None:
    connection.execute(text(_FOLLOWUP_FENCE_DDL))
    add_feed_presentation_relations(connection)


def add_feed_presentation_relations(connection) -> None:
    # Production counterpart and Circle ownership relations also fence the
    # important-incoming projection in hand-built Feed fixtures.
    connection.execute(
        text("""
      CREATE TABLE IF NOT EXISTS feed_event_counterparts (
        feed_event_id BIGINT PRIMARY KEY REFERENCES feed_events(id) ON DELETE CASCADE,
        counterpart_user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_location_circles (
        id UUID PRIMARY KEY, owner_user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_location_share_grants (
        id UUID PRIMARY KEY, recipient_user_id TEXT, recipient_cleared_at TIMESTAMPTZ);
      ALTER TABLE one_location_share_grants
        ADD COLUMN IF NOT EXISTS recipient_cleared_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recipient_user_id TEXT;
    """)
    )


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
