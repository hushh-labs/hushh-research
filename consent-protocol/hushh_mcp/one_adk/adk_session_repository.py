"""Storage port for owner-encrypted ADK session records.

Session semantics, encryption, privacy projection and optimistic retries remain
in EncryptedAdkSessionService. Adapters store only the sealed record and revision.
The Postgres default keeps the current table and SQL; a pod never needs SQL access.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol


class SessionRecordResult(Protocol):
    data: list[dict[str, Any]]


@dataclass(frozen=True)
class CompletedReplyUsage:
    event_id: str
    invocation_id: str
    occurred_at: datetime


async def _replace_with_reply_usage(
    execute: Callable[[str, dict[str, Any]], Awaitable[SessionRecordResult]],
    params: dict[str, Any],
    usage: CompletedReplyUsage,
) -> SessionRecordResult:
    """Shared SQL only: the content-free outbox commits with the sealed CAS."""
    values = {
        **params,
        "usage_key": f"adk_reply:{params['app']}:{params['session']}:{usage.invocation_id}",
        "usage_at": usage.occurred_at,
        "usage_metadata": json.dumps(
            {
                "source": "adk_chat",
                "session_id": params["session"],
                "event_id": usage.event_id,
                "message_id": usage.event_id,
            }
        ),
    }
    result = await execute(
        """WITH persisted AS (
            UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                   payload_iv = :iv, payload_tag = :tag,
                   payload_algorithm = :algorithm, revision = revision + 1,
                   updated_at = NOW()
             WHERE app_name = :app AND user_id = :user AND session_id = :session
               AND revision = :revision AND payload_ciphertext LIKE :chat_marker
            RETURNING revision
        ), usage AS (
            INSERT INTO one_referral_events(user_id,event_type,idempotency_key,server_timestamp,metadata)
            SELECT :user,'product_usage',:usage_key,:usage_at,CAST(:usage_metadata AS JSONB)
              FROM persisted
            ON CONFLICT(idempotency_key) DO NOTHING
        ) SELECT revision FROM persisted""",
        values,
    )
    if result.data:
        try:
            from hushh_mcp.services.one_referral_activity_service import reconcile_product_activity

            await asyncio.to_thread(reconcile_product_activity, params["user"], usage.event_id)
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "one_adk_session.referral_reconcile_deferred type=%s", type(exc).__name__
            )
    return result


class AdkSessionRepository(Protocol):
    async def create(
        self,
        *,
        app: str,
        user: str,
        session: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
    ) -> SessionRecordResult: ...

    async def get(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult: ...

    async def list(self, *, app: str, user: str, chat_marker: str) -> SessionRecordResult: ...

    async def delete(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult: ...

    async def legacy(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult: ...

    async def replace(
        self,
        *,
        app: str,
        user: str,
        session: str,
        revision: int,
        chat_marker: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
        generated: bool = False,
    ) -> SessionRecordResult: ...


class PostgresAdkSessionRepository:
    def __init__(
        self, execute: Callable[[str, dict[str, Any]], Awaitable[SessionRecordResult]]
    ) -> None:
        self._execute = execute

    async def create(
        self,
        *,
        app: str,
        user: str,
        session: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
    ) -> SessionRecordResult:
        return await self._execute(
            """INSERT INTO one_adk_sessions
               (app_name, user_id, session_id, payload_ciphertext, payload_iv,
                payload_tag, payload_algorithm)
               VALUES (:app, :user, :session, :ciphertext, :iv, :tag, :algorithm)
               ON CONFLICT (app_name, user_id, session_id) DO NOTHING
               RETURNING revision""",
            {
                "app": app,
                "user": user,
                "session": session,
                "ciphertext": ciphertext,
                "iv": iv,
                "tag": tag,
                "algorithm": algorithm,
            },
        )

    async def get(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult:
        return await self._execute(
            """SELECT payload_ciphertext, payload_iv, payload_tag, payload_algorithm, revision
               FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext LIKE :chat_marker LIMIT 1""",
            {"app": app, "user": user, "session": session, "chat_marker": chat_marker},
        )

    async def list(self, *, app: str, user: str, chat_marker: str) -> SessionRecordResult:
        return await self._execute(
            """SELECT session_id, payload_ciphertext, payload_iv, payload_tag,
                      payload_algorithm, revision
               FROM one_adk_sessions WHERE app_name = :app AND user_id = :user
                 AND payload_ciphertext LIKE :chat_marker
               ORDER BY updated_at DESC LIMIT 100""",
            {"app": app, "user": user, "chat_marker": chat_marker},
        )

    async def delete(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult:
        return await self._execute(
            """DELETE FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext LIKE :chat_marker
               RETURNING session_id""",
            {"app": app, "user": user, "session": session, "chat_marker": chat_marker},
        )

    async def legacy(
        self, *, app: str, user: str, session: str, chat_marker: str
    ) -> SessionRecordResult:
        return await self._execute(
            """SELECT 1 AS legacy FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext NOT LIKE :chat_marker LIMIT 1""",
            {"app": app, "user": user, "session": session, "chat_marker": chat_marker},
        )

    async def replace(
        self,
        *,
        app: str,
        user: str,
        session: str,
        revision: int,
        chat_marker: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
        generated: bool = False,
        reply_usage: CompletedReplyUsage | None = None,
    ) -> SessionRecordResult:
        params = {
            "app": app,
            "user": user,
            "session": session,
            "revision": revision,
            "generated": generated,
            "chat_marker": chat_marker,
            "ciphertext": ciphertext,
            "iv": iv,
            "tag": tag,
            "algorithm": algorithm,
        }
        if reply_usage is not None:
            if generated:
                raise ValueError("Generated titles cannot record completed reply usage.")
            return await _replace_with_reply_usage(self._execute, params, reply_usage)
        return await self._execute(
            """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                      payload_iv = :iv, payload_tag = :tag,
                      payload_algorithm = :algorithm, revision = revision + 1,
                      updated_at = CASE WHEN :generated THEN updated_at ELSE NOW() END
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND revision = :revision AND payload_ciphertext LIKE :chat_marker
               RETURNING revision""",
            params,
        )
