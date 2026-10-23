"""Canonical opaque owner-key checkpoint port, shared by trusted feature adapters."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager, nullcontext
from typing import Any

from db.connection import get_pool
from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE, ChatCipher, chat_aad


def session_payload_aad(app_name: str, session_id: str) -> str:
    binding: str = chat_aad("one_adk_sessions", "payload", f"{app_name}/{session_id}")
    return binding


@asynccontextmanager
async def _checkpoint_connection(pool, existing):
    if existing is not None:
        yield existing
    else:
        async with pool.acquire(timeout=8) as connection:
            yield connection


class EncryptedSessionCheckpointStore:
    """Opaque owner checkpoints behind the canonical person-key storage boundary.

    Trusted feature adapters bind a dedicated app/session namespace; they never
    issue session SQL themselves. Documents retain their existing sealed shape,
    and revision plus ciphertext CAS also fences deletion/recreation at revision 1.
    This port can gain a different adapter without moving checkpoint authority.
    """

    def __init__(
        self,
        *,
        app_name: str,
        session_id: str,
        pool_provider=get_pool,
        cipher=None,
        on_commit=None,
        before_write=None,
        durable=False,
    ):
        self.app_name = app_name
        self.session_id = session_id
        self.pool_provider = pool_provider
        self.cipher = cipher or ChatCipher()
        self.on_commit = on_commit
        self.before_write = before_write
        self.durable = durable

    def encode(self, user_id: str, state: dict[str, Any]):
        return self.cipher.seal(
            json.dumps(state, separators=(",", ":")),
            owner_id=user_id,
            aad=session_payload_aad(self.app_name, self.session_id),
        )

    async def get(self, user_id: str, *, conn=None) -> dict[str, Any] | None:
        pool = await self.pool_provider()
        async with _checkpoint_connection(pool, conn) as conn:
            row = await conn.fetchrow(
                """SELECT payload_ciphertext,payload_iv,payload_tag,payload_algorithm,revision
                   FROM one_adk_sessions WHERE app_name=$1 AND user_id=$2 AND session_id=$3
                   AND payload_ciphertext LIKE $4""",
                self.app_name,
                user_id,
                self.session_id,
                CHAT_CIPHERTEXT_LIKE,
                timeout=8,
            )
        if not row:
            return None
        state = json.loads(
            self.cipher.open(
                dict(row),
                "payload",
                owner_id=user_id,
                aad=session_payload_aad(self.app_name, self.session_id),
            )
        )
        return {**state, "revision": int(row["revision"]), "fence": row["payload_ciphertext"]}

    async def write(
        self, user_id: str, state: dict[str, Any], expected: dict | None, *, conn=None
    ) -> dict | None:
        payload = self.encode(user_id, state)
        pool = await self.pool_provider()
        async with (
            _checkpoint_connection(pool, conn) as conn,
            conn.transaction() if self.on_commit or self.before_write else nullcontext(),
        ):
            if self.before_write is not None:
                await self.before_write(conn, user_id)
            if expected is None:
                row = await conn.fetchrow(
                    """INSERT INTO one_adk_sessions
                       (app_name,user_id,session_id,payload_ciphertext,payload_iv,payload_tag,payload_algorithm)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (app_name,user_id,session_id) DO NOTHING RETURNING revision""",
                    self.app_name,
                    user_id,
                    self.session_id,
                    payload.ciphertext,
                    payload.iv,
                    payload.tag,
                    payload.algorithm,
                    timeout=8,
                )
            else:
                row = await conn.fetchrow(
                    """UPDATE one_adk_sessions SET payload_ciphertext=$4,payload_iv=$5,
                       payload_tag=$6,payload_algorithm=$7,revision=revision+1,updated_at=NOW()
                       WHERE app_name=$1 AND user_id=$2 AND session_id=$3 AND revision=$8
                       AND payload_ciphertext=$9 AND payload_ciphertext LIKE $10
                       RETURNING revision""",
                    self.app_name,
                    user_id,
                    self.session_id,
                    payload.ciphertext,
                    payload.iv,
                    payload.tag,
                    payload.algorithm,
                    expected["revision"],
                    expected["fence"],
                    CHAT_CIPHERTEXT_LIKE,
                    timeout=8,
                )
            if row and self.on_commit is not None:
                # Trusted domain adapter only, inside the same transaction as
                # the winning CAS. Failure rolls back both draft and outbox.
                await self.on_commit(conn, user_id, state)
        return {"revision": int(row["revision"]), "fence": payload.ciphertext} if row else None

    async def has_fresh_checkpoint(self, conn, user_id: str) -> bool:
        # Metadata-only readiness check; no retained key is needed. Row lock
        # keeps retention from removing a draft during completion dispatch.
        return bool(
            await conn.fetchval(
                """SELECT 1 FROM one_adk_sessions WHERE app_name=$1 AND user_id=$2
            AND session_id=$3
            AND payload_ciphertext LIKE $4
            AND ($5 OR updated_at>NOW()-INTERVAL '24 hours') FOR SHARE""",
                self.app_name,
                user_id,
                self.session_id,
                CHAT_CIPHERTEXT_LIKE,
                self.durable,
                timeout=5,
            )
        )

    async def purge_expired(self) -> None:
        if self.durable:
            return
        pool = await self.pool_provider()
        async with pool.acquire(timeout=8) as conn:
            await conn.execute(
                """DELETE FROM one_adk_sessions WHERE (app_name,user_id,session_id) IN (
                   SELECT app_name,user_id,session_id FROM one_adk_sessions
                   WHERE app_name=$1 AND session_id=$2 AND payload_ciphertext LIKE $3
                   AND updated_at < NOW() - INTERVAL '24 hours' LIMIT 500 FOR UPDATE SKIP LOCKED)
                   AND payload_ciphertext LIKE $3
                   AND updated_at < NOW() - INTERVAL '24 hours'""",
                self.app_name,
                self.session_id,
                CHAT_CIPHERTEXT_LIKE,
                timeout=8,
            )
