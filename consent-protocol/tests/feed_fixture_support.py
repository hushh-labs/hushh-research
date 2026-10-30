"""Schema pieces that hand-built Feed fixtures need beyond their migration lists."""

from __future__ import annotations

from sqlalchemy import text

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


def complete_projection_schema(connection) -> None:
    """Columns the dismissal and identity reads expect, plus the follow-up fence."""
    connection.execute(text("ALTER TABLE feed_events ADD COLUMN dismissed_at timestamptz"))
    connection.execute(text("ALTER TABLE actor_identity_cache ADD COLUMN email text"))
    add_followup_fence_relations(connection)
