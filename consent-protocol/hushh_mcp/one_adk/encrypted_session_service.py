"""Postgres-backed ADK sessions with no plaintext state or event payloads.

Each session document is sealed with its owner's chat key (``chat_key.ChatCipher``),
never with a platform key. A row sealed before that cutover is treated as absent:
it is not listed, not opened, and not overwritten at runtime.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import (
    GetSessionConfig,
    ListSessionsResponse,
)
from google.adk.sessions.state import State
from pydantic import BaseModel
from pydantic_core import PydanticSerializationError

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.one_adk.adk_session_repository import (
    AdkSessionRepository,
    PostgresAdkSessionRepository,
)
from hushh_mcp.one_adk.drive_result_privacy import redact_drive_session_json
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.services.chat_key import (
    CHAT_CIPHERTEXT_LIKE,
    ChatCipher,
    ChatKeyMismatchError,
    chat_aad,
)

logger = logging.getLogger(__name__)
_SERIALIZER_BUILD_LOCK = threading.Lock()

# Sessions already reported for stale sealed ``temp:`` values, by (app, user,
# session). Reads never reseal a row, so a legacy row is decoded again by every
# conversation-list poll until its next turn; measured 2026-09-28: 277 lines,
# about 14 per turn, all from those polls. Process memory only, bounded.
_REPORTED_STALE_TEMP_STATE: OrderedDict[tuple[str, str, str], None] = OrderedDict()
_REPORTED_STALE_TEMP_STATE_LIMIT = 4096
_REPORTED_STALE_TEMP_STATE_LOCK = threading.Lock()


def _first_stale_temp_report(key: tuple[str, str, str]) -> bool:
    """True the first time this process drops stale ``temp:`` values from ``key``'s row."""
    with _REPORTED_STALE_TEMP_STATE_LOCK:
        if key in _REPORTED_STALE_TEMP_STATE:
            _REPORTED_STALE_TEMP_STATE.move_to_end(key)
            return False
        _REPORTED_STALE_TEMP_STATE[key] = None
        if len(_REPORTED_STALE_TEMP_STATE) > _REPORTED_STALE_TEMP_STATE_LIMIT:
            _REPORTED_STALE_TEMP_STATE.popitem(last=False)
        return True


def _invocation_state(state: dict[str, Any]) -> dict[str, Any]:
    """The ``temp:`` values of the running invocation.

    ADK's contract is that ``temp:`` state lives for one invocation and is never
    persisted; every stock session service strips it. This store seals the whole
    Session document, so it has to drop these keys itself. Measured 2026-09-28
    (run 598321cd): a sealed ``temp:hussh:consent_continuation`` made every later
    turn in the chat re-render another person's shared block and skip the
    revoke check, so One answered from it after the owner stopped sharing.
    """
    return {
        key: value
        for key, value in state.items()
        if isinstance(key, str) and key.startswith(State.TEMP_PREFIX)
    }


def _without_invocation_state(session: Session) -> Session:
    """A copy of ``session`` for sealing, without any ``temp:`` value."""
    if not _invocation_state(session.state):
        return session
    durable = {
        key: value
        for key, value in session.state.items()
        if not (isinstance(key, str) and key.startswith(State.TEMP_PREFIX))
    }
    return session.model_copy(update={"state": durable})


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


class LegacyAdkSessionError(EncryptedAdkSessionUnavailableError):
    """The id belongs to a conversation sealed before person-key chat history."""


def session_payload_aad(app_name: str, session_id: str) -> str:
    binding: str = chat_aad("one_adk_sessions", "payload", f"{app_name}/{session_id}")
    return binding


class EncryptedAdkSessionService(BaseSessionService):
    """Persist one encrypted Session document with optimistic concurrency."""

    def __init__(
        self,
        cipher: ChatCipher | None = None,
        *,
        repository: AdkSessionRepository | None = None,
    ) -> None:
        self._cipher = cipher or ChatCipher()
        # An explicit runtime may supply its repository. Shared defaults retain the
        # existing SQL adapter and value-free database error boundary.
        self._repository = (
            repository
            if repository is not None
            else PostgresAdkSessionRepository(lambda sql, params: self._execute(sql, params))
        )

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
        session = _without_invocation_state(durable_external_read_projection(session))
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
        payload = self._cipher.seal(
            redact_drive_session_json(plain),
            owner_id=session.user_id,
            aad=session_payload_aad(session.app_name, session.id),
        )
        return {
            "ciphertext": payload.ciphertext,
            "iv": payload.iv,
            "tag": payload.tag,
            "algorithm": payload.algorithm,
        }

    def _decode(
        self, row: dict[str, Any], *, app_name: str, user_id: str, session_id: str
    ) -> Session:
        plain = self._cipher.open(
            row,
            "payload",
            owner_id=user_id,
            aad=session_payload_aad(app_name, session_id),
        )
        session = Session.model_validate_json(plain)
        if (session.app_name, session.user_id, session.id) != (
            app_name,
            user_id,
            session_id,
        ):
            raise ChatKeyMismatchError("Chat history did not open with this vault.")
        # A row sealed before the fix may still hold an earlier turn's ``temp:``
        # values; a new invocation must never start with them.
        stale = _invocation_state(session.state)
        for key in stale:
            session.state.pop(key, None)
        if stale:
            first = _first_stale_temp_report((app_name, user_id, session_id))
            logger.log(
                logging.INFO if first else logging.DEBUG,
                "one_adk_session.sealed_temp_state_dropped count=%s",
                len(stale),
            )
        return session

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
        result = await self._repository.create(
            **{"app": app_name, "user": user_id, "session": session.id, **encoded}
        )
        if not result.data:
            existing = await self.get_session(
                app_name=app_name, user_id=user_id, session_id=session.id
            )
            if existing is None:
                # The id is taken by a conversation sealed before person-key
                # history. It is never overwritten here; the cutover removes it.
                raise LegacyAdkSessionError(
                    "This conversation is no longer available. Start a new chat."
                )
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
        result = await self._repository.get(
            **{
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            }
        )
        if not result.data:
            return None
        row = dict(result.data[0])
        session = self._decode(row, app_name=app_name, user_id=user_id, session_id=session_id)
        from hushh_mcp.one_adk.mcp_pending_call import restore_current_pending_call

        session = restore_current_pending_call(session)
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
        result = await self._repository.list(
            **{"app": app_name, "user": user_id, "chat_marker": CHAT_CIPHERTEXT_LIKE}
        )
        sessions = []
        unreadable = 0
        for result_row in result.data or []:
            row = dict(result_row)
            try:
                session = self._decode(
                    row,
                    app_name=app_name,
                    user_id=user_id,
                    session_id=str(row.get("session_id") or ""),
                )
            except ChatKeyMismatchError:
                # One record that will not open must not lock a person out of
                # the rest of their history, and is never shown as a placeholder.
                unreadable += 1
                continue
            self._set_revision(session, int(row["revision"]))
            sessions.append(session)
        if unreadable and not sessions:
            raise ChatKeyMismatchError("Chat history did not open with this vault.")
        if unreadable:
            logger.warning("one_adk_session.unreadable_records count=%s", unreadable)
        return ListSessionsResponse(sessions=sessions)

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        await self.delete_owned_session(app_name=app_name, user_id=user_id, session_id=session_id)

    async def delete_owned_session(self, *, app_name: str, user_id: str, session_id: str) -> bool:
        """Delete one current conversation without opening it; no chat key needed."""
        result = await self._repository.delete(
            **{
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            }
        )
        return bool(result.data)

    async def is_legacy_session(self, *, app_name: str, user_id: str, session_id: str) -> bool:
        """True when the id is held by a conversation sealed with the platform key."""
        result = await self._repository.legacy(
            **{
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            }
        )
        return bool(result.data)

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
        result = await self._repository.replace(
            **{
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "revision": revision,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
                **encoded,
            }
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
                app_name=session.app_name,
                user_id=session.user_id,
                session_id=session.id,
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            running = _invocation_state(session.state)
            persisted_event = await super().append_event(latest, event)
            # The stored snapshot has no ``temp:`` values; keep this invocation's.
            for key, value in running.items():
                latest.state.setdefault(key, value)
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
            result = await self._repository.replace(
                **{
                    "app": session.app_name,
                    "user": session.user_id,
                    "session": session.id,
                    "revision": revision,
                    "chat_marker": CHAT_CIPHERTEXT_LIKE,
                    **encoded,
                }
            )
            if result.data:
                self._set_revision(session, int(result.data[0]["revision"]))
                return persisted_event
            latest = await self.get_session(
                app_name=session.app_name,
                user_id=session.user_id,
                session_id=session.id,
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            # Invocation-local (``temp:``) values never reach storage, so the
            # stored snapshot lacks them. A CAS retry must not drop them: that
            # would reopen tools after an external read, among other guards.
            running = _invocation_state(session.state)
            await super().append_event(latest, event)
            latest.state.update(running)
            session.state = latest.state
            session.events = latest.events
            session.last_update_time = time.time()
            self._set_revision(session, self._revision(latest))
        raise RuntimeError("Encrypted ADK session changed concurrently; retry the run.")

    async def append_event_once(
        self, *, app_name: str, user_id: str, session_id: str, event: Event
    ) -> Event:
        """CAS-append a deterministic presentation event once across concurrent requests."""
        if not event.id or event.content is not None:
            raise ValueError("Presentation receipt requires an id and no model content.")
        for _attempt in range(4):
            session = await self.get_session(
                app_name=app_name, user_id=user_id, session_id=session_id
            )
            if session is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            existing = next((item for item in session.events if item.id == event.id), None)
            if existing is not None:
                return existing
            await super().append_event(session, event.model_copy(deep=True))
            session.last_update_time = time.time()
            revision = self._revision(session)
            encoded = self._encode(session)
            result = await self._repository.replace(
                **{
                    "app": app_name,
                    "user": user_id,
                    "session": session_id,
                    "revision": revision,
                    "chat_marker": CHAT_CIPHERTEXT_LIKE,
                    **encoded,
                }
            )
            if result.data:
                return event
        raise RuntimeError("Encrypted ADK session changed concurrently; retry the receipt.")


__all__ = [
    "EncryptedAdkSessionService",
    "EncryptedAdkSessionUnavailableError",
    "LegacyAdkSessionError",
    "session_payload_aad",
]
