"""Migration 944 (chat-history BYOK cutover) deletes only platform-key chat rows.

The compatibility release parks this destructive migration until BYOK-only writers
serve and older writers are drained. It must never touch a person-key row. Static
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
from urllib.parse import urlparse

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/parked/944_one_chat_history_legacy_cutover.sql"
ROLLBACK = ROOT / "db/migrations/rollback/944_one_chat_history_legacy_cutover.rollback.sql"
MANIFEST = ROOT / "db/release_migration_manifest.json"
MARKER = "hussh-chat-v1:"


def _sql() -> str:
    return MIGRATION.read_text()


def test_compatibility_release_defers_cutover_with_a_documented_recovery_boundary() -> None:
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_PREFIX

    assert CHAT_CIPHERTEXT_PREFIX == MARKER  # the SQL tests the same marker the code writes
    manifest = json.loads(MANIFEST.read_text())
    assert MIGRATION.name not in manifest["ordered_migrations"]
    assert MIGRATION.name not in manifest["rollback_migrations"]
    assert ROLLBACK.exists() and "DELETE FROM" not in ROLLBACK.read_text().upper()
    for contract in ("prod_core_schema", "uat_integrated_schema", "dev_minimum_schema"):
        data = json.loads((ROOT / f"db/contracts/{contract}.json").read_text())
        assert data["expected_migration_version"] == 256


def test_every_delete_targets_only_unmarked_chat_rows() -> None:
    sql = _sql()
    deletes = re.findall(r"DELETE FROM\s+(?:public\.)?(\w+)(?:\s+AS\s+\w+)?\s+WHERE([^;]+);", sql)
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


@pytest.fixture
def conn() -> Iterator:
    database_url = os.getenv("CHAT_CUTOVER_TEST_DATABASE_URL", "")
    if not database_url:
        pytest.skip("CHAT_CUTOVER_TEST_DATABASE_URL not set")
    target = urlparse(database_url)
    if target.hostname not in {"127.0.0.1", "localhost"} or target.username != "cutover_test":
        pytest.fail("Cutover tests require a disposable local cutover_test database identity")
    psycopg2 = pytest.importorskip("psycopg2")
    connection = psycopg2.connect(database_url)
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


@pytest.mark.parametrize(
    "table", ["agent_chat_messages", "agent_chat_conversations", "one_adk_sessions"]
)
def test_recent_legacy_writer_refuses_without_deleting(conn, table):
    ids = _seed(conn)
    before = _counts(conn, ids["owner"])
    column = "created_at" if table == "agent_chat_messages" else "updated_at"
    with conn.cursor() as cursor:
        cursor.execute(f"UPDATE {table} SET {column}=NOW() WHERE user_id=%s", (ids["owner"],))
        cursor.execute("SAVEPOINT refusal")
    with pytest.raises(Exception, match="recent legacy writes"):
        _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("ROLLBACK TO SAVEPOINT refusal")
    assert _counts(conn, ids["owner"]) == before


@pytest.mark.parametrize("status", ["ready", "admitted"])
def test_live_checkpoint_refuses_without_deleting(conn, status):
    ids = _seed(conn)
    before = _counts(conn, ids["owner"])
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE one_adk_sessions SET command_status=%s WHERE user_id=%s AND session_id='old-command'",
            (status, ids["owner"]),
        )
        cursor.execute("SAVEPOINT refusal")
    with pytest.raises(Exception, match="live legacy command"):
        _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("ROLLBACK TO SAVEPOINT refusal")
    assert _counts(conn, ids["owner"]) == before


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


@pytest.mark.parametrize("channel", ["typed_chat", "adk_chat", "command"])
@pytest.mark.parametrize(
    "state,expired,consumed,refused",
    [
        ("issued", False, False, True),
        ("confirmed", False, False, True),
        ("consumed", True, True, True),
        ("issued", True, True, True),
        ("confirmed", True, True, True),
        ("issued", True, False, False),
        ("settled", True, True, False),
        ("cancelled", True, False, False),
    ],
)
def test_affected_authority_controls_deletion(conn, channel, state, expired, consumed, refused):
    ids = _seed(conn)
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO one_action_directive_ledger
            (directive_id,user_id,channel,conversation_id,session_id,adk_app_name,
             action_id,context_revision,action_contract_digest,slots_hmac,
             resource_binding_hmac,requires_confirmation,trusted_activation_required,
             state,expires_at,consumed_at,command_step,operation_id)
            VALUES (%s,%s,%s,%s,%s,%s,'synthetic','r1','d1','h1','binding',true,true,
                    %s,NOW() + (%s * INTERVAL '1 hour'),
                    CASE WHEN %s THEN NOW() - INTERVAL '2 hours' ELSE NULL END,%s,%s)""",
            (
                str(uuid.uuid4()),
                ids["owner"],
                channel,
                ids["legacy_conversation"] if channel == "typed_chat" else None,
                "legacy-thread"
                if channel == "adk_chat"
                else "old-command"
                if channel == "command"
                else None,
                "hussh_one" if channel == "adk_chat" else None,
                state,
                -1 if expired else 1,
                consumed,
                0 if channel == "command" else None,
                str(uuid.uuid4()) if channel == "command" else None,
            ),
        )
        cursor.execute("SAVEPOINT refusal")
    before = _counts(conn, ids["owner"])
    if refused:
        with pytest.raises(Exception, match="unsettled authority"):
            _run(conn)
        with conn.cursor() as cursor:
            cursor.execute("ROLLBACK TO SAVEPOINT refusal")
        assert _counts(conn, ids["owner"]) == before
    else:
        _run(conn)
        assert _counts(conn, ids["owner"])["legacy_sessions"] == 0
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM public.one_action_directive_ledger WHERE user_id=%s AND channel=%s",
                (ids["owner"], channel),
            )
            assert cursor.fetchone()[0] == (1 if channel == "command" else 0)


def test_cutover_targets_public_tables_despite_shadow_search_path(conn):
    ids = _seed(conn)
    with conn.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE one_adk_sessions AS TABLE public.one_adk_sessions")
        cursor.execute("SELECT count(*) FROM pg_temp.one_adk_sessions")
        shadow_before = cursor.fetchone()[0]
        cursor.execute("SET LOCAL search_path = pg_temp, public")
    _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM pg_temp.one_adk_sessions")
        assert cursor.fetchone()[0] == shadow_before
        cursor.execute("SET LOCAL search_path = pg_catalog, public, pg_temp")
    assert _counts(conn, ids["owner"])["legacy_sessions"] == 0


def test_unreviewed_session_namespace_refuses_without_deletion(conn):
    ids = _seed(conn)
    before = _counts(conn, ids["owner"])
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE public.one_adk_sessions SET app_name='future_unknown' WHERE user_id=%s AND session_id='old-command'",
            (ids["owner"],),
        )
        cursor.execute("SAVEPOINT refusal")
    with pytest.raises(Exception, match="unreviewed legacy session namespace"):
        _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("ROLLBACK TO SAVEPOINT refusal")
    assert _counts(conn, ids["owner"]) == before


@pytest.mark.parametrize("proof", ["execution", "active_run"])
def test_expired_directive_with_effect_evidence_refuses(conn, proof):
    ids = _seed(conn)
    directive = str(uuid.uuid4())
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO public.one_action_directive_ledger
          (directive_id,user_id,channel,session_id,action_id,context_revision,
           action_contract_digest,slots_hmac,resource_binding_hmac,
           requires_confirmation,trusted_activation_required,state,expires_at,
           command_step,operation_id,execution_receipt_hash)
          VALUES (%s,%s,'command','old-command','synthetic','r1','d1','h1','binding',
           true,true,'issued',NOW()-INTERVAL '1 hour',0,%s,%s)""",
            (
                directive,
                ids["owner"],
                str(uuid.uuid4()),
                "synthetic-proof" if proof == "execution" else None,
            ),
        )
        if proof == "active_run":
            cursor.execute(
                """INSERT INTO public.one_capability_runs
              (run_id,user_id,capability_id,capability_version,graph_revision,status,
               pending_directive_id,idempotency_key,slots_hmac,expires_at)
              VALUES (%s,%s,'synthetic',1,'test','executing',%s,%s,%s,NOW()+INTERVAL '1 hour')""",
                ("run_" + uuid.uuid4().hex, ids["owner"], directive, "c" * 64, "d" * 64),
            )
        cursor.execute("SAVEPOINT refusal")
    before = _counts(conn, ids["owner"])
    with pytest.raises(Exception, match="unsettled authority"):
        _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("ROLLBACK TO SAVEPOINT refusal")
        cursor.execute(
            "SELECT count(*) FROM public.one_action_directive_ledger WHERE directive_id=%s",
            (directive,),
        )
        assert cursor.fetchone()[0] == 1
    assert _counts(conn, ids["owner"]) == before


def test_concurrent_writer_blocks_cutover_without_partial_deletion(conn):
    from concurrent.futures import ThreadPoolExecutor

    import psycopg2

    ids = _seed(conn)
    before = _counts(conn, ids["owner"])
    other = psycopg2.connect(os.environ["CHAT_CUTOVER_TEST_DATABASE_URL"])
    try:
        # The seed transaction holds real write locks while the migration waits.
        # Exercise the SQL's actual 10-second lock bound, with no shortened copy.
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(_run, other)
            with pytest.raises(psycopg2.errors.LockNotAvailable):
                pending.result(timeout=15)
        other.rollback()
        assert _counts(conn, ids["owner"]) == before
    finally:
        other.rollback()
        other.close()


def test_missing_required_table_refuses_cutover(conn):
    ids = _seed(conn)
    before = _counts(conn, ids["owner"])
    with conn.cursor() as cursor:
        cursor.execute("SAVEPOINT schema_refusal")
        cursor.execute("ALTER TABLE public.agent_chat_messages RENAME TO cutover_hidden_messages")
    with pytest.raises(Exception, match="required chat tables absent"):
        _run(conn)
    with conn.cursor() as cursor:
        cursor.execute("ROLLBACK TO SAVEPOINT schema_refusal")
    assert _counts(conn, ids["owner"]) == before
