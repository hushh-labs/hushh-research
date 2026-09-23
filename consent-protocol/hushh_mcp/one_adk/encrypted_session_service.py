"""Postgres-backed ADK sessions with no plaintext state or event payloads."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from typing import Any

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import GetSessionConfig, ListSessionsResponse
from pydantic import BaseModel
from pydantic_core import PydanticSerializationError

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.one_adk.drive_result_privacy import redact_drive_session_json
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
)
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.services.agent_chat_service import AgentChatService

logger = logging.getLogger(__name__)
_SERIALIZER_BUILD_LOCK = threading.Lock()


def _prepare_deferred_model_serializers(value: Any) -> None:
    """Build schemas for SDK models carried through ADK's Any-typed fields.

    GenAI uses deferred Pydantic schemas. Models created with model_construct
    can still have a placeholder serializer; Pydantic's Any serializer does
    not initialize it when dumping an enclosing Session. Prepare the schemas
    without converting the objects or changing their serialization rules.
    """
    pending = [value]
    seen: set[int] = set()
    while pending:
        item = pending.pop()
        if not isinstance(item, (BaseModel, dict, list, tuple, set, frozenset)):
            continue
        if id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, BaseModel):
            model_type = type(item)
            if not model_type.__pydantic_complete__:
                # Pydantic rebuild mutates class schema state. Serialize our
                # repairs and recheck rather than forcing a shared-class rebuild.
                with _SERIALIZER_BUILD_LOCK:
                    if not model_type.__pydantic_complete__:
                        model_type.model_rebuild()
            pending.extend(item.__dict__.values())
            if item.__pydantic_extra__:
                pending.extend(item.__pydantic_extra__.values())
        elif isinstance(item, dict):
            pending.extend(item.values())
        else:
            pending.extend(item)


class EncryptedAdkSessionUnavailableError(RuntimeError):
    """Stable value-free failure for the public AG-UI boundary."""


class EncryptedAdkSessionService(BaseSessionService):
    """Persist one encrypted Session document with optimistic concurrency."""

    def __init__(self) -> None:
        self._cipher = AgentChatService()

    @staticmethod
    def _set_revision(session: Session, revision: int) -> None:
        # The revision belongs to this snapshot, not the session identity. A
        # service-wide cache lets a stale snapshot reuse another writer's new
        # revision and silently replace its events. Pydantic excludes private
        # attributes from the encrypted session document.
        object.__setattr__(session, "_hushh_revision", revision)

    @staticmethod
    def _revision(session: Session) -> int:
        revision = getattr(session, "_hushh_revision", None)
        if not isinstance(revision, int):
            raise RuntimeError("Encrypted ADK session was not loaded from storage.")
        return revision

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
        session = durable_external_read_projection(session)
        try:
            plain = session.model_dump_json(by_alias=True)
        except PydanticSerializationError as exc:
            if "MockValSer" not in str(exc):
                raise
            # One bounded repair for deferred SDK serializers. Healthy sessions
            # pay no traversal/rebuild cost; unrelated serialization errors remain
            # failures rather than silently dropping or stringifying information.
            _prepare_deferred_model_serializers(session)
            plain = session.model_dump_json(by_alias=True)
        payload = self._cipher._encrypt_text(redact_drive_session_json(plain))
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
        self._set_revision(session, int(result.data[0]["revision"]))
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
        full_event_count = len(session.events)
        if config:
            if config.num_recent_events is not None:
                session.events = (
                    session.events[-config.num_recent_events :]
                    if config.num_recent_events > 0
                    else []
                )
            if config.after_timestamp:
                session.events = [
                    event for event in session.events if event.timestamp >= config.after_timestamp
                ]
        # A filtered snapshot can be read by ADK, but must recover its full
        # history before an append replaces the encrypted session document.
        object.__setattr__(
            session, "_hushh_partial_history", len(session.events) < full_event_count
        )
        self._set_revision(session, int(row["revision"]))
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
        sessions = []
        for result_row in result.data or []:
            row = dict(result_row)
            session = self._decode(row)
            self._set_revision(session, int(row["revision"]))
            sessions.append(session)
        return ListSessionsResponse(sessions=sessions)

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        await self._execute(
            "DELETE FROM one_adk_sessions WHERE app_name = :app AND user_id = :user AND session_id = :session",
            {"app": app_name, "user": user_id, "session": session_id},
        )

    async def set_title(
        self, *, app_name: str, user_id: str, session_id: str, title: str
    ) -> Session | None:
        session = await self.get_session(app_name=app_name, user_id=user_id, session_id=session_id)
        if session is None:
            return None
        revision = self._revision(session)
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
        self._set_revision(session, int(result.data[0]["revision"]))
        return session

    async def append_event(self, session: Session, event: Event) -> Event:
        if not event.partial:
            self._revision(session)
        if event.partial:
            return event
        if getattr(session, "_hushh_partial_history", False):
            latest = await self.get_session(
                app_name=session.app_name, user_id=session.user_id, session_id=session.id
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            persisted_event = await super().append_event(latest, event)
            session.state = latest.state
            session.events = latest.events
            self._set_revision(session, self._revision(latest))
            object.__setattr__(session, "_hushh_partial_history", False)
        else:
            persisted_event = await super().append_event(session, event)
        session.last_update_time = time.time()
        for _attempt in range(3):
            revision = self._revision(session)
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
                self._set_revision(session, int(result.data[0]["revision"]))
                return persisted_event
            latest = await self.get_session(
                app_name=session.app_name, user_id=session.user_id, session_id=session.id
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            # These trusted invocation-local guards intentionally never reach
            # storage. A CAS retry must not replace them with the redacted
            # durable snapshot and reopen tools after an external read.
            ephemeral = {
                name: session.state[name]
                for name in (STATE_EXECUTION_SURFACE, STATE_EXTERNAL_READ)
                if name in session.state
            }
            await super().append_event(latest, event)
            latest.state.update(ephemeral)
            session.state = latest.state
            session.events = latest.events
            session.last_update_time = time.time()
            self._set_revision(session, self._revision(latest))
        raise RuntimeError("Encrypted ADK session changed concurrently; retry the run.")


__all__ = ["EncryptedAdkSessionService", "EncryptedAdkSessionUnavailableError"]
