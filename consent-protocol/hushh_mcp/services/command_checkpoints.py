"""Owner-bound command checkpoints in the existing ADK session store.

Only metadata and an opaque owner-vault capsule are persisted. The outer
platform cipher protects metadata; it is never a substitute for the owner key.
Postgres CAS is the shared plane; a future Redis adapter must preserve this API.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy import text

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.services.agent_chat_service import AgentChatService

COMMAND_NAMESPACE = "one.location.commands.v1"


class CommandCheckpointConflict(RuntimeError):
    pass


class CommandCheckpointStore:
    def __init__(self, *, db: Any = None, cipher: Any = None):
        self._db = db
        self._cipher = cipher

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def cipher(self):
        if self._cipher is None:
            self._cipher = AgentChatService()
        return self._cipher

    async def _execute(self, sql: str, params: dict[str, Any]):
        try:
            return await asyncio.to_thread(self.db.execute_raw, sql, params)
        except DatabaseExecutionError:
            # Database errors may contain bound values. Never propagate them.
            raise RuntimeError("Command storage is temporarily unavailable.") from None

    def _encode(self, state: dict[str, Any]) -> dict[str, str]:
        payload = self.cipher._encrypt_text(json.dumps(state, separators=(",", ":")))
        return {key: getattr(payload, key) for key in ("ciphertext", "iv", "tag", "algorithm")}

    def _decode(self, row: dict[str, Any]) -> dict[str, Any]:
        state = json.loads(self.cipher._decrypt_text(row, "payload"))
        return {**state, "revision": int(row["revision"]), "command_id": row["session_id"]}

    async def purge_expired(self) -> None:
        await self._execute(
            """DELETE FROM one_adk_sessions WHERE app_name = :app
               AND created_at <= NOW() - INTERVAL '24 hours'""",
            {"app": COMMAND_NAMESPACE},
        )

    async def create(self, user_id: str, command_id: str, state: dict[str, Any]) -> dict[str, Any]:
        await self.purge_expired()
        result = await self._execute(
            """INSERT INTO one_adk_sessions
               (app_name,user_id,session_id,payload_ciphertext,payload_iv,payload_tag,payload_algorithm,command_status,command_plan_hmac)
               VALUES (:app,:user,:id,:ciphertext,:iv,:tag,:algorithm,:status,:plan_hmac)
               ON CONFLICT (app_name,user_id,session_id) DO NOTHING RETURNING revision""",
            {
                "app": COMMAND_NAMESPACE,
                "user": user_id,
                "id": command_id,
                "status": state["status"],
                "plan_hmac": state["plan_digest"],
                **self._encode(state),
            },
        )
        if not result.data:
            raise CommandCheckpointConflict("This command already exists; recover its checkpoint.")
        return {**state, "command_id": command_id, "revision": int(result.data[0]["revision"])}

    async def get(self, user_id: str, command_id: str) -> dict[str, Any] | None:
        await self.purge_expired()
        result = await self._execute(
            """SELECT session_id,payload_ciphertext,payload_iv,payload_tag,payload_algorithm,revision
               FROM one_adk_sessions WHERE app_name=:app AND user_id=:user AND session_id=:id
               AND created_at > NOW() - INTERVAL '24 hours'""",
            {"app": COMMAND_NAMESPACE, "user": user_id, "id": command_id},
        )
        return self._decode(dict(result.data[0])) if result.data else None

    async def list(self, user_id: str) -> list[dict[str, Any]]:
        await self.purge_expired()
        result = await self._execute(
            """SELECT session_id,payload_ciphertext,payload_iv,payload_tag,payload_algorithm,revision
               FROM one_adk_sessions WHERE app_name=:app AND user_id=:user
               ORDER BY updated_at DESC LIMIT 50""",
            {"app": COMMAND_NAMESPACE, "user": user_id},
        )
        return [self._decode(dict(row)) for row in (result.data or [])]

    async def update(
        self,
        user_id: str,
        command_id: str,
        expected: int,
        state: dict[str, Any],
        *,
        replan_from: int | None = None,
        preserve_admission: bool = False,
    ) -> dict[str, Any]:
        clean = {
            key: value for key, value in state.items() if key not in {"revision", "command_id"}
        }
        if replan_from is not None:
            return await self._replan(user_id, command_id, expected, clean, replan_from)
        result = await self._execute(
            """UPDATE one_adk_sessions SET payload_ciphertext=:ciphertext,payload_iv=:iv,
               payload_tag=:tag,payload_algorithm=:algorithm,revision=revision+1,updated_at=NOW(),
               command_status=CASE WHEN :preserve_admission AND command_status='admitted' THEN 'admitted' ELSE :status END,command_plan_hmac=:plan_hmac
               WHERE app_name=:app AND user_id=:user AND session_id=:id AND revision=:expected
               AND created_at > NOW() - INTERVAL '24 hours'
               AND (CAST(:replan_from AS INTEGER) IS NULL OR command_status='ready')
               RETURNING revision""",
            {
                "app": COMMAND_NAMESPACE,
                "user": user_id,
                "id": command_id,
                "expected": expected,
                "status": clean["status"],
                "plan_hmac": clean["plan_digest"],
                "replan_from": replan_from,
                "preserve_admission": preserve_admission,
                **self._encode(clean),
            },
        )
        if not result.data:
            raise CommandCheckpointConflict(
                "The command changed or expired. Refresh its checkpoint."
            )
        return {**clean, "command_id": command_id, "revision": int(result.data[0]["revision"])}

    async def _replan(
        self, user: str, command: str, expected: int, state: dict[str, Any], index: int
    ) -> dict[str, Any]:
        encoded = self._encode(state)

        def transaction() -> int:
            with self.db.engine.begin() as connection:
                params = {
                    "app": COMMAND_NAMESPACE,
                    "user": user,
                    "command": command,
                    "expected": expected,
                    "index": index,
                }
                locked = connection.execute(
                    text("""SELECT revision FROM one_adk_sessions
                    WHERE app_name=:app AND user_id=:user AND session_id=:command
                    AND revision=:expected AND command_status IN ('ready','admitted')
                    AND created_at > NOW()-INTERVAL '24 hours' FOR UPDATE"""),
                    params,
                ).first()
                if not locked:
                    raise CommandCheckpointConflict(
                        "The command changed or expired. Refresh its checkpoint."
                    )
                # Same session -> ledger lock order as claim. This separate SQL
                # statement gets a fresh READ COMMITTED snapshot after a waiter
                # acquired the session lock; no consumed effect can disappear.
                outcomes = (
                    connection.execute(
                        text("""SELECT state,consumed_at,execution_receipt_hash FROM one_action_directive_ledger
                    WHERE user_id=:user AND session_id=:command AND channel='command'
                    AND command_step >= :index FOR UPDATE"""),
                        params,
                    )
                    .mappings()
                    .all()
                )
                if any(
                    value["state"] not in {"issued", "confirmed", "cancelled", "expired"}
                    or value["consumed_at"] is not None
                    or value["execution_receipt_hash"] is not None
                    for value in outcomes
                ):
                    raise CommandCheckpointConflict(
                        "An operation may already have happened. Review it before changing the plan."
                    )
                connection.execute(
                    text("""DELETE FROM one_action_directive_ledger
                    WHERE user_id=:user AND session_id=:command AND channel='command'
                    AND command_step >= :index AND state IN ('issued','confirmed','cancelled','expired') AND consumed_at IS NULL AND execution_receipt_hash IS NULL"""),
                    params,
                )
                revision = connection.execute(
                    text("""UPDATE one_adk_sessions
                    SET payload_ciphertext=:ciphertext,payload_iv=:iv,payload_tag=:tag,
                    payload_algorithm=:algorithm,revision=revision+1,updated_at=NOW(),
                    command_status=:status,command_plan_hmac=:plan_hmac
                    WHERE app_name=:app AND user_id=:user AND session_id=:command
                    RETURNING revision"""),
                    {
                        **params,
                        **encoded,
                        "status": state["status"],
                        "plan_hmac": state["plan_digest"],
                    },
                ).scalar_one()
                return int(revision)

        try:
            revision = await asyncio.to_thread(transaction)
        except CommandCheckpointConflict:
            raise
        except Exception:
            raise RuntimeError("Command storage is temporarily unavailable.") from None
        return {**state, "command_id": command, "revision": revision}
