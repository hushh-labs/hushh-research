"""Migration 249 (chat-history BYOK cutover) deletes only platform-key chat rows.

It runs on every deploy lane (the deploy that ships the person-key code is the
cutover), so it must be idempotent and must never touch a person-key row. Static
checks always run. The executable checks run when
``CHAT_CUTOVER_TEST_DATABASE_URL`` points at a THROWAWAY Postgres holding the real
schema (for example a schema-only dump restored locally) plus synthetic rows.
Every scenario runs in a transaction that is rolled back.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/249_one_chat_history_legacy_cutover.sql"
ROLLBACK = ROOT / "db/migrations/rollback/249_one_chat_history_legacy_cutover.rollback.sql"
MANIFEST = ROOT / "db/release_migration_manifest.json"
MARKER = "hussh-chat-v1:"


def _sql() -> str:
    return MIGRATION.read_text()


def test_cutover_is_registered_with_a_documented_rollback() -> None:
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_PREFIX

    assert CHAT_CIPHERTEXT_PREFIX == MARKER  # the SQL tests the same marker the code writes
    manifest = json.loads(MANIFEST.read_text())
    assert MIGRATION.name in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][MIGRATION.name] == f"rollback/{ROLLBACK.name}"
    assert ROLLBACK.exists() and "DELETE FROM" not in ROLLBACK.read_text().upper()
    for contract in ("prod_core_schema", "uat_integrated_schema", "dev_minimum_schema"):
        data = json.loads((ROOT / f"db/contracts/{contract}.json").read_text())
        assert data["expected_migration_version"] >= 249


def test_every_delete_targets_only_unmarked_chat_rows() -> None:
    sql = _sql()
    deletes = re.findall(r"DELETE FROM\s+(\w+)(?:\s+AS\s+\w+)?\s+WHERE([^;]+);", sql)
    assert {table for table, _ in deletes} == {
        "agent_chat_messages",
        "agent_chat_conversations",
        "one_adk_sessions",
    }
    for _table, where in deletes:
        assert re.search(r"substr\((?:\w\.)?\w+_ciphertext, 1, 14\) <> 'hussh-chat-v1:'", where)
    assert len(MARKER) == 14
    assert "one_capability_runs" not in sql.split("Not touched:")[0]
    assert "DELETE FROM one_capability_runs" not in sql
    assert "person-key rows changed" in sql  # post-condition self-guard
    assert "DROP " not in sql.upper()


# ── Executable proof against a throwaway database ─────────────────────────────

DATABASE_URL = os.getenv("CHAT_CUTOVER_TEST_DATABASE_URL", "")
needs_db = pytest.mark.skipif(not DATABASE_URL, reason="CHAT_CUTOVER_TEST_DATABASE_URL not set")


@pytest.fixture
def conn() -> Iterator:
    psycopg2 = pytest.importorskip("psycopg2")
    connection = psycopg2.connect(DATABASE_URL)
    connection.autocommit = False
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


def _run(conn) -> None:  # noqa: ANN001
    """Execute the migration body inside the test's own (rolled back) transaction."""
    body = _sql().replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n")
    assert "BEGIN;" not in body and "COMMIT;" not in body
    with conn.cursor() as cursor:
        cursor.execute(body)


def _seed(conn, *, stale_legacy: bool = True) -> dict:  # noqa: ANN001
    owner = f"cutover-{uuid.uuid4().hex[:12]}"
    ids = {
        "owner": owner,
        "legacy_conversation": str(uuid.uuid4()),
        "new_conversation": str(uuid.uuid4()),
    }
    age = "NOW() - INTERVAL '2 hours'" if stale_legacy else "NOW()"
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO vault_keys (user_id, created_at, updated_at, vault_status)
               VALUES (%s, 0, 0, 'placeholder')""",
            (owner,),
        )
        cursor.execute("INSERT INTO actor_profiles (user_id) VALUES (%s)", (owner,))
        for session_id, ciphertext in (("legacy-thread", "b2xk"), ("new-thread", MARKER + "bmV3")):
            cursor.execute(
                f"""INSERT INTO one_adk_sessions
                    (app_name, user_id, session_id, payload_ciphertext, payload_iv,
                     payload_tag, created_at, updated_at)
                    VALUES ('hussh_one', %s, %s, %s, 'iv', 'tag', {age}, {age})""",
                (owner, session_id, ciphertext),
            )
            cursor.execute(
                """INSERT INTO one_agent_message_feedback
                   (user_id, app_name, conversation_ref, message_ref, rating)
                   VALUES (%s, 'hussh_one', %s, 'm1', 'up')""",
                (owner, session_id),
            )
        cursor.execute(
            f"""INSERT INTO one_adk_sessions
                (app_name, user_id, session_id, payload_ciphertext, payload_iv, payload_tag,
                 command_status, created_at, updated_at)
                VALUES ('one.location.commands.v1', %s, 'old-command', 'b2xk', 'iv', 'tag',
                        'settled', {age}, {age})""",
            (owner,),
        )
        for key, title in (("legacy_conversation", "b2xk"), ("new_conversation", MARKER + "dA")):
            cursor.execute(
                f"""INSERT INTO agent_chat_conversations
                    (id, user_id, title_ciphertext, title_iv, title_tag, created_at, updated_at)
                    VALUES (%s, %s, %s, 'iv', 'tag', {age}, {age})""",
                (ids[key], owner, title),
            )
            cursor.execute(
                f"""INSERT INTO agent_chat_messages
                    (id, conversation_id, user_id, role, content_ciphertext, content_iv,
                     content_tag, created_at)
                    VALUES (%s, %s, %s, 'user', %s, 'iv', 'tag', {age})""",
                (str(uuid.uuid4()), ids[key], owner, title),
            )
        cursor.execute(
            """INSERT INTO one_capability_runs
               (run_id, user_id, capability_id, capability_version, graph_revision, status,
                idempotency_key, slots_hmac, expires_at, slots_ciphertext, slots_iv,
                slots_tag, slots_algorithm)
               VALUES (%s, %s, 'workflow.location.onboarding', 1, 'g1', 'needs_input',
                       %s, %s, NOW() + INTERVAL '1 day', 'cGxhdGZvcm0', 'iv', 'tag',
                       'aes-256-gcm')""",
            (f"run_{uuid.uuid4().hex}", owner, "a" * 64, "b" * 64),
        )
    return ids


def _counts(conn, owner: str) -> dict:  # noqa: ANN001
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT
                 (SELECT COUNT(*) FROM one_adk_sessions WHERE user_id = %(o)s
                    AND payload_ciphertext LIKE 'hussh-chat-v1:%%'),
                 (SELECT COUNT(*) FROM one_adk_sessions WHERE user_id = %(o)s
                    AND payload_ciphertext NOT LIKE 'hussh-chat-v1:%%'),
                 (SELECT COUNT(*) FROM agent_chat_conversations WHERE user_id = %(o)s),
                 (SELECT COUNT(*) FROM agent_chat_messages WHERE user_id = %(o)s),
                 (SELECT COUNT(*) FROM one_agent_message_feedback WHERE user_id = %(o)s),
                 (SELECT COUNT(*) FROM one_capability_runs WHERE user_id = %(o)s)""",
            {"o": owner},
        )
        row = cursor.fetchone()
    keys = ("new_sessions", "legacy_sessions", "conversations", "messages", "feedback", "runs")
    return dict(zip(keys, row, strict=True))


@needs_db
def test_cutover_deletes_only_platform_key_rows_and_is_idempotent(conn) -> None:  # noqa: ANN001
    ids = _seed(conn)
    assert _counts(conn, ids["owner"]) == {
        "new_sessions": 1,
        "legacy_sessions": 2,
        "conversations": 2,
        "messages": 2,
        "feedback": 2,
        "runs": 1,
    }
    _run(conn)
    after = {
        "new_sessions": 1,
        "legacy_sessions": 0,
        "conversations": 1,
        "messages": 1,
        "feedback": 1,
        "runs": 1,
    }
    assert _counts(conn, ids["owner"]) == after
    _run(conn)  # replay on the next deploy is a no-op
    assert _counts(conn, ids["owner"]) == after


@needs_db
def test_rows_written_moments_ago_by_old_code_are_still_removed(conn) -> None:  # noqa: ANN001
    ids = _seed(conn, stale_legacy=False)
    _run(conn)
    counts = _counts(conn, ids["owner"])
    assert counts["legacy_sessions"] == 0 and counts["new_sessions"] == 1


@needs_db
def test_a_legacy_conversation_holding_a_person_key_message_is_kept(conn) -> None:  # noqa: ANN001
    ids = _seed(conn)
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO agent_chat_messages
               (id, conversation_id, user_id, role, content_ciphertext, content_iv, content_tag)
               VALUES (%s, %s, %s, 'user', %s, 'iv', 'tag')""",
            (str(uuid.uuid4()), ids["legacy_conversation"], ids["owner"], MARKER + "eA"),
        )
    _run(conn)
    counts = _counts(conn, ids["owner"])
    # Both conversations stay (one only because it holds a person-key message);
    # both person-key messages stay; the legacy message is gone.
    assert counts["conversations"] == 2
    assert counts["messages"] == 2


@needs_db
def test_self_guard_rolls_back_if_any_person_key_row_would_go(conn) -> None:  # noqa: ANN001
    psycopg2 = pytest.importorskip("psycopg2")
    ids = _seed(conn)
    with conn.cursor() as cursor:
        # Simulate an ungoverned cascade the repository does not know about.
        cursor.execute(
            """CREATE FUNCTION pg_temp.chat_cutover_rogue() RETURNS trigger
               LANGUAGE plpgsql AS $$
               BEGIN
                 DELETE FROM one_adk_sessions
                 WHERE user_id = OLD.user_id AND payload_ciphertext LIKE 'hussh-chat-v1:%';
                 RETURN OLD;
               END $$"""
        )
        cursor.execute(
            """CREATE TRIGGER chat_cutover_rogue AFTER DELETE ON agent_chat_messages
               FOR EACH ROW EXECUTE FUNCTION pg_temp.chat_cutover_rogue()"""
        )
    with pytest.raises(psycopg2.Error, match="person-key rows changed"):
        _run(conn)
    assert ids["owner"]
