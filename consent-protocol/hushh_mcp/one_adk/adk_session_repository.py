"""Storage port for owner-encrypted ADK session records.

Session semantics, encryption, privacy projection and optimistic retries remain
in EncryptedAdkSessionService. Adapters store only the sealed record and revision.
The Postgres default keeps the current table and SQL; a pod never needs SQL access.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol


class SessionRecordResult(Protocol):
    data: list[dict[str, Any]]


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
    ) -> SessionRecordResult:
        return await self._execute(
            """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                      payload_iv = :iv, payload_tag = :tag,
                      payload_algorithm = :algorithm, revision = revision + 1,
                      updated_at = NOW()
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND revision = :revision AND payload_ciphertext LIKE :chat_marker
               RETURNING revision""",
            {
                "app": app,
                "user": user,
                "session": session,
                "revision": revision,
                "chat_marker": chat_marker,
                "ciphertext": ciphertext,
                "iv": iv,
                "tag": tag,
                "algorithm": algorithm,
            },
        )
