"""Postgres-backed ADK sessions with no plaintext state or event payloads."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import GetSessionConfig, ListSessionsResponse

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.services.agent_chat_service import AgentChatService

logger = logging.getLogger(__name__)


class EncryptedAdkSessionUnavailableError(RuntimeError):
    """Stable value-free failure for the public AG-UI boundary."""


class EncryptedAdkSessionService(BaseSessionService):
    """Persist one encrypted Session document with optimistic concurrency."""

    def __init__(self) -> None:
        self._cipher = AgentChatService()
        self._revisions: dict[tuple[str, str, str], int] = {}

    async def _execute(self, sql: str, params: dict[str, Any]):
        try:
            return await asyncio.to_thread(get_db().execute_raw, sql, params)
        except DatabaseExecutionError as exc:
            # DatabaseExecutionError.details can contain the SQL statement and
            # every bound value. AG-UI serializes exception messages into run
            # errors, so only stable metadata may cross this boundary.
            logger.error(
                "one_adk_session.storage_failed code=%s operation=%s",
                getattr(exc, "code", "DATABASE_EXECUTION_ERROR"),
                getattr(exc, "operation", "unknown"),
            )
            raise EncryptedAdkSessionUnavailableError(
                "Conversation storage is temporarily unavailable."
            ) from None

    def _encode(self, session: Session) -> dict[str, str]:
        payload = self._cipher._encrypt_text(session.model_dump_json(by_alias=True))
        return {
            "ciphertext": payload.ciphertext,
            "iv": payload.iv,
            "tag": payload.tag,
            "algorithm": payload.algorithm,
        }

    def _decode(self, row: dict[str, Any]) -> Session:
        plain = self._cipher._decrypt_text(row, "payload")
        return Session.model_validate_json(plain)

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> Session:
        session = Session(
            id=session_id or uuid.uuid4().hex,
            app_name=app_name,
            user_id=user_id,
            state=dict(state or {}),
            events=[],
            last_update_time=time.time(),
        )
        encoded = self._encode(session)
        result = await self._execute(
            """INSERT INTO one_adk_sessions
               (app_name, user_id, session_id, payload_ciphertext, payload_iv,
                payload_tag, payload_algorithm)
               VALUES (:app, :user, :session, :ciphertext, :iv, :tag, :algorithm)
               ON CONFLICT (app_name, user_id, session_id) DO NOTHING
               RETURNING revision""",
            {"app": app_name, "user": user_id, "session": session.id, **encoded},
        )
        if not result.data:
            existing = await self.get_session(
                app_name=app_name, user_id=user_id, session_id=session.id
            )
            if existing is None:
                raise RuntimeError("Encrypted ADK session reservation failed.")
            return existing
        self._revisions[(app_name, user_id, session.id)] = int(result.data[0]["revision"])
        return session

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: GetSessionConfig | None = None,
    ) -> Session | None:
        result = await self._execute(
            """SELECT payload_ciphertext, payload_iv, payload_tag, payload_algorithm, revision
               FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session LIMIT 1""",
            {"app": app_name, "user": user_id, "session": session_id},
        )
        if not result.data:
            return None
        row = dict(result.data[0])
        session = self._decode(row)
        if config and config.num_recent_events is not None:
            session.events = session.events[-config.num_recent_events :]
        self._revisions[(app_name, user_id, session_id)] = int(row["revision"])
        return session

    async def list_sessions(
        self, *, app_name: str, user_id: str | None = None
    ) -> ListSessionsResponse:
        if not user_id:
            return ListSessionsResponse(sessions=[])
        result = await self._execute(
            """SELECT payload_ciphertext, payload_iv, payload_tag, payload_algorithm, revision
               FROM one_adk_sessions WHERE app_name = :app AND user_id = :user
               ORDER BY updated_at DESC LIMIT 100""",
            {"app": app_name, "user": user_id},
        )
        sessions = [self._decode(dict(row)) for row in (result.data or [])]
        return ListSessionsResponse(sessions=sessions)

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        await self._execute(
            "DELETE FROM one_adk_sessions WHERE app_name = :app AND user_id = :user AND session_id = :session",
            {"app": app_name, "user": user_id, "session": session_id},
        )
        self._revisions.pop((app_name, user_id, session_id), None)

    async def set_title(
        self, *, app_name: str, user_id: str, session_id: str, title: str
    ) -> Session | None:
        session = await self.get_session(app_name=app_name, user_id=user_id, session_id=session_id)
        if session is None:
            return None
        key = (app_name, user_id, session_id)
        revision = self._revisions[key]
        session.state["hussh:thread_title"] = title.strip()[:160]
        session.last_update_time = time.time()
        encoded = self._encode(session)
        result = await self._execute(
            """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                      payload_iv = :iv, payload_tag = :tag,
                      payload_algorithm = :algorithm, revision = revision + 1,
                      updated_at = NOW()
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND revision = :revision RETURNING revision""",
            {
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "revision": revision,
                **encoded,
            },
        )
        if not result.data:
            raise RuntimeError("Conversation changed while its title was being updated.")
        self._revisions[key] = int(result.data[0]["revision"])
        return session

    async def append_event(self, session: Session, event: Event) -> Event:
        persisted_event = await super().append_event(session, event)
        if event.partial:
            return persisted_event
        session.last_update_time = time.time()
        key = (session.app_name, session.user_id, session.id)
        for _attempt in range(3):
            revision = self._revisions.get(key)
            if revision is None:
                current = await self.get_session(
                    app_name=session.app_name, user_id=session.user_id, session_id=session.id
                )
                if current is None:
                    raise RuntimeError("Encrypted ADK session disappeared.")
                revision = self._revisions[key]
            encoded = self._encode(session)
            result = await self._execute(
                """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                          payload_iv = :iv, payload_tag = :tag,
                          payload_algorithm = :algorithm, revision = revision + 1,
                          updated_at = NOW()
                   WHERE app_name = :app AND user_id = :user AND session_id = :session
                     AND revision = :revision RETURNING revision""",
                {
                    "app": session.app_name,
                    "user": session.user_id,
                    "session": session.id,
                    "revision": revision,
                    **encoded,
                },
            )
            if result.data:
                self._revisions[key] = int(result.data[0]["revision"])
                return persisted_event
            latest = await self.get_session(
                app_name=session.app_name, user_id=session.user_id, session_id=session.id
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            await super().append_event(latest, event)
            session.state = latest.state
            session.events = latest.events
            session.last_update_time = time.time()
        raise RuntimeError("Encrypted ADK session changed concurrently; retry the run.")


__all__ = ["EncryptedAdkSessionService", "EncryptedAdkSessionUnavailableError"]
