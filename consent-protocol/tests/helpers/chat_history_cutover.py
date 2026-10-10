"""Synthetic cohorts and complete-row comparison for isolated chat cutover tests."""

from __future__ import annotations

import hashlib
import uuid

from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_PREFIX as MARKER


def seed_cutover_rows(conn, *, stale_legacy: bool = True) -> dict:  # noqa: ANN001
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


def count_cutover_rows(conn, owner: str) -> dict:  # noqa: ANN001
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


def fingerprint_cutover_rows(conn, owner: str) -> dict[str, tuple[str, ...]]:
    tables = (
        "one_adk_sessions",
        "agent_chat_conversations",
        "agent_chat_messages",
        "one_agent_message_feedback",
        "one_action_directive_ledger",
        "one_capability_runs",
    )
    result = {}
    with conn.cursor() as cursor:
        for table in tables:
            cursor.execute(
                f"SELECT row_to_json(t)::text FROM public.{table} t "
                'WHERE user_id=%s ORDER BY row_to_json(t)::text COLLATE "C"',
                (owner,),
            )
            result[table] = tuple(
                hashlib.sha256(row[0].encode()).hexdigest() for row in cursor.fetchall()
            )
    return result
