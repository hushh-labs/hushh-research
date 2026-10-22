"""Postgres-backed ADK sessions with no plaintext state or event payloads.

Each session document is sealed with its owner's chat key (``chat_key.ChatCipher``),
never with a platform key. A row sealed before that cutover is treated as absent:
it is not listed, not opened, and not overwritten at runtime.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager, nullcontext
from datetime import datetime, timezone
from typing import Any

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import GetSessionConfig, ListSessionsResponse
from google.adk.sessions.state import State
from pydantic import BaseModel
from pydantic_core import PydanticSerializationError

from db.connection import _is_connection_unavailable_error, get_pool
from db.db_client import get_db
from db.query_telemetry import record_query
from hushh_mcp.one_adk.drive_result_privacy import redact_drive_session_json
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.one_adk.message_reactions import without_message_reactions
from hushh_mcp.one_adk.queued_input import current_run, registry
from hushh_mcp.one_adk.turn_completion import successful_answer_completion
from hushh_mcp.services.chat_key import (
    CHAT_CIPHERTEXT_LIKE,
    ChatCipher,
    ChatKeyMismatchError,
    chat_aad,
)

logger = logging.getLogger(__name__)
_SERIALIZER_BUILD_LOCK = threading.Lock()
_NAMED_PARAMETER = re.compile(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)")
_DEFAULT_GET_DB = get_db

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
    ):
        self.app_name = app_name
        self.session_id = session_id
        self.pool_provider = pool_provider
        self.cipher = cipher or ChatCipher()
        self.on_commit = on_commit
        self.before_write = before_write

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
            AND session_id=$3 AND updated_at>NOW()-INTERVAL '24 hours'
            AND payload_ciphertext LIKE $4 FOR SHARE""",
                self.app_name,
                user_id,
                self.session_id,
                CHAT_CIPHERTEXT_LIKE,
                timeout=5,
            )
        )

    async def purge_expired(self) -> None:
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


class EncryptedAdkSessionService(BaseSessionService):
    """Persist one encrypted Session document with optimistic concurrency."""

    def __init__(
        self, cipher: ChatCipher | None = None, *, referral_usage_app_name: str | None = None
    ) -> None:
        self._cipher = cipher or ChatCipher()
        self._referral_usage_app_name = referral_usage_app_name

    async def _execute_event(
        self, session: Session, event: Event, sql: str, params: dict[str, Any]
    ):
        """Commit a content-free usage outbox with the successful session CAS."""
        qualifies = (
            self._referral_usage_app_name is not None
            and session.app_name == self._referral_usage_app_name
            and bool(event.id and event.invocation_id)
            and successful_answer_completion(event, session.events)
            and any(
                prior.author == "user"
                and prior.invocation_id == event.invocation_id
                and prior.timestamp <= event.timestamp
                for prior in reversed(session.events)
            )
        )
        if qualifies:
            run = current_run()
            if (
                run is not None
                and run.owner_id == session.user_id
                and run.conversation_id == session.id
                and registry.stop_requested(run.owner_id, run.conversation_id, run.run_id)
            ):
                qualifies = False
        if qualifies:
            # Never decrypt in SQL or copy a prompt, answer, key or session state.
            sql = """WITH persisted AS (
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
            ) SELECT revision FROM persisted"""
            params.update(
                {
                    "usage_key": f"adk_reply:{session.app_name}:{session.id}:{event.invocation_id}",
                    "usage_at": datetime.fromtimestamp(event.timestamp, timezone.utc),
                    "usage_metadata": json.dumps(
                        {
                            "source": "adk_chat",
                            "session_id": session.id,
                            "event_id": event.id,
                            "message_id": event.id,
                        }
                    ),
                }
            )
        result = await self._execute(sql, params)
        if qualifies and result.data:
            try:
                from hushh_mcp.services.one_referral_activity_service import (
                    reconcile_product_activity,
                )

                await asyncio.to_thread(reconcile_product_activity, session.user_id, event.id)
            except Exception as exc:
                # The committed outbox is recovered by the bounded scheduler.
                logger.warning(
                    "one_adk_session.referral_reconcile_deferred type=%s", type(exc).__name__
                )
        return result

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
            # A few focused unit tests replace the legacy executor with a
            # deterministic in-memory table. Production always stays on the
            # asyncpg branch; retaining this seam avoids a second fake SQL
            # implementation in those security tests.
            if get_db is not _DEFAULT_GET_DB:
                return await asyncio.to_thread(get_db().execute_raw, sql, params)
            names: list[str] = []

            def positional(match: re.Match[str]) -> str:
                names.append(match.group(1))
                return f"${len(names)}"

            query = _NAMED_PARAMETER.sub(positional, sql)
            values = [params[name] for name in names]
            pool = await get_pool()
            signature = (
                "one_adk_session."
                + hashlib.sha256(" ".join(query.split()).encode()).hexdigest()[:12]
            )
            rows = None
            for attempt in range(2):
                wait_started = time.perf_counter()
                pool_wait_ms = 0.0
                sql_started: float | None = None
                try:
                    async with pool.acquire() as connection:
                        pool_wait_ms = (time.perf_counter() - wait_started) * 1000
                        sql_started = time.perf_counter()
                        rows = await connection.fetch(query, *values)
                    break
                except Exception as exc:
                    if attempt == 1 or not _is_connection_unavailable_error(exc):
                        raise
                    logger.warning(
                        "Transient encrypted-session database connection error; retrying once "
                        "error_type=%s",
                        type(exc).__name__,
                    )
                finally:
                    now = time.perf_counter()
                    if sql_started is None:
                        pool_wait_ms = (now - wait_started) * 1000
                        sql_duration_ms = 0.0
                    else:
                        sql_duration_ms = (now - sql_started) * 1000
                    record_query(
                        signature,
                        sql_duration_ms=sql_duration_ms,
                        pool_wait_ms=pool_wait_ms,
                    )
            if rows is None:  # pragma: no cover - both attempts always return or raise
                raise RuntimeError("Encrypted session query did not complete")
            return type(
                "EncryptedSessionQueryResult",
                (),
                {"data": [dict(row) for row in rows]},
            )()
        except Exception as exc:
            # Database diagnostics can contain the SQL statement and every
            # bound value. AG-UI serializes exception messages into run errors,
            # so only stable metadata may cross this boundary.
            logger.error(
                "one_adk_session.storage_failed code=database.execution.error operation=asyncpg type=%s",
                type(exc).__name__,
            )
            raise EncryptedAdkSessionUnavailableError(
                "Conversation storage is temporarily unavailable."
            ) from None

    @staticmethod
    def _record_phase(phase: str, started_at: float) -> None:
        from hushh_mcp.one_adk.agui_turn_timing import record_session_phase

        record_session_phase(phase, (time.perf_counter() - started_at) * 1000)

    async def _read(self, sql: str, params: dict[str, Any]):
        started_at = time.perf_counter()
        try:
            return await self._execute(sql, params)
        finally:
            self._record_phase("read", started_at)

    def _decode_timed(
        self, row: dict[str, Any], *, app_name: str, user_id: str, session_id: str
    ) -> Session:
        started_at = time.perf_counter()
        try:
            return self._decode(row, app_name=app_name, user_id=user_id, session_id=session_id)
        finally:
            self._record_phase("decrypt", started_at)

    def _encode(self, session: Session) -> dict[str, str]:
        session = _without_invocation_state(
            without_message_reactions(durable_external_read_projection(session))
        )
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
        if (session.app_name, session.user_id, session.id) != (app_name, user_id, session_id):
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
        persistence_started_at = time.perf_counter()
        try:
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
        finally:
            self._record_phase("persistence", persistence_started_at)
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
        result = await self._read(
            """SELECT payload_ciphertext, payload_iv, payload_tag, payload_algorithm, revision
               FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext LIKE :chat_marker LIMIT 1""",
            {
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            },
        )
        if not result.data:
            return None
        row = dict(result.data[0])
        session = self._decode_timed(row, app_name=app_name, user_id=user_id, session_id=session_id)
        from hushh_mcp.one_adk.mcp_pending_call import restore_current_pending_call

        session = await restore_current_pending_call(session)
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
        result = await self._read(
            """SELECT session_id, payload_ciphertext, payload_iv, payload_tag,
                      payload_algorithm, revision
               FROM one_adk_sessions WHERE app_name = :app AND user_id = :user
                 AND payload_ciphertext LIKE :chat_marker
               ORDER BY updated_at DESC LIMIT 100""",
            {"app": app_name, "user": user_id, "chat_marker": CHAT_CIPHERTEXT_LIKE},
        )
        sessions = []
        unreadable = 0
        for result_row in result.data or []:
            row = dict(result_row)
            try:
                session = self._decode_timed(
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
        result = await self._execute(
            """DELETE FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext LIKE :chat_marker
               RETURNING session_id""",
            {
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            },
        )
        return bool(result.data)

    async def is_legacy_session(self, *, app_name: str, user_id: str, session_id: str) -> bool:
        """True when the id is held by a conversation sealed with the platform key."""
        result = await self._execute(
            """SELECT 1 AS legacy FROM one_adk_sessions
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND payload_ciphertext NOT LIKE :chat_marker LIMIT 1""",
            {
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
            },
        )
        return bool(result.data)

    async def set_title(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        title: str,
        generated: bool = False,
    ) -> Session | None:
        session = await self.get_session(app_name=app_name, user_id=user_id, session_id=session_id)
        if session is None:
            return None
        revision = self._revision(session)
        if generated and (
            session.state.get("hussh:thread_title")
            or session.state.get("hussh:thread_summary_title")
        ):
            return session
        key = "hussh:thread_summary_title" if generated else "hussh:thread_title"
        session.state[key] = title.strip()[:160]
        if not generated:
            session.last_update_time = time.time()
        encoded = self._encode(session)
        result = await self._execute(
            """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                      payload_iv = :iv, payload_tag = :tag,
                      payload_algorithm = :algorithm, revision = revision + 1,
                      updated_at = CASE WHEN :generated THEN updated_at ELSE NOW() END
               WHERE app_name = :app AND user_id = :user AND session_id = :session
                 AND revision = :revision AND payload_ciphertext LIKE :chat_marker
               RETURNING revision""",
            {
                "app": app_name,
                "user": user_id,
                "session": session_id,
                "revision": revision,
                "generated": generated,
                "chat_marker": CHAT_CIPHERTEXT_LIKE,
                **encoded,
            },
        )
        if not result.data and generated:
            # Never overwrite a concurrent rename or a new conversation event.
            return await self.get_session(app_name=app_name, user_id=user_id, session_id=session_id)
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
            running = _invocation_state(session.state)
            append_started_at = time.perf_counter()
            try:
                persisted_event = await super().append_event(latest, event)
            finally:
                self._record_phase("append", append_started_at)
            # The stored snapshot has no ``temp:`` values; keep this invocation's.
            for key, value in running.items():
                latest.state.setdefault(key, value)
            session.state = latest.state
            session.events = latest.events
            self._set_revision(session, self._revision(latest))
            object.__setattr__(session, "_hushh_partial_history", False)
        else:
            append_started_at = time.perf_counter()
            try:
                persisted_event = await super().append_event(session, event)
            finally:
                self._record_phase("append", append_started_at)
        session.last_update_time = time.time()
        for _attempt in range(3):
            revision = self._revision(session)
            persistence_started_at = time.perf_counter()
            try:
                encoded = self._encode(session)
                result = await self._execute_event(
                    session,
                    event,
                    """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                          payload_iv = :iv, payload_tag = :tag,
                          payload_algorithm = :algorithm, revision = revision + 1,
                          updated_at = NOW()
                   WHERE app_name = :app AND user_id = :user AND session_id = :session
                     AND revision = :revision AND payload_ciphertext LIKE :chat_marker
               RETURNING revision""",
                    {
                        "app": session.app_name,
                        "user": session.user_id,
                        "session": session.id,
                        "revision": revision,
                        "chat_marker": CHAT_CIPHERTEXT_LIKE,
                        **encoded,
                    },
                )
            finally:
                self._record_phase("persistence", persistence_started_at)
            if result.data:
                self._set_revision(session, int(result.data[0]["revision"]))
                return persisted_event
            latest = await self.get_session(
                app_name=session.app_name, user_id=session.user_id, session_id=session.id
            )
            if latest is None:
                raise RuntimeError("Encrypted ADK session disappeared.")
            # Invocation-local (``temp:``) values never reach storage, so the
            # stored snapshot lacks them. A CAS retry must not drop them: that
            # would reopen tools after an external read, among other guards.
            running = _invocation_state(session.state)
            append_started_at = time.perf_counter()
            try:
                await super().append_event(latest, event)
            finally:
                self._record_phase("append", append_started_at)
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
            result = await self._execute(
                """UPDATE one_adk_sessions SET payload_ciphertext = :ciphertext,
                          payload_iv = :iv, payload_tag = :tag,
                          payload_algorithm = :algorithm, revision = revision + 1,
                          updated_at = NOW()
                   WHERE app_name = :app AND user_id = :user AND session_id = :session
                     AND revision = :revision AND payload_ciphertext LIKE :chat_marker
               RETURNING revision""",
                {
                    "app": app_name,
                    "user": user_id,
                    "session": session_id,
                    "revision": revision,
                    "chat_marker": CHAT_CIPHERTEXT_LIKE,
                    **encoded,
                },
            )
            if result.data:
                return event
        raise RuntimeError("Encrypted ADK session changed concurrently; retry the receipt.")


__all__ = [
    "EncryptedAdkSessionService",
    "EncryptedAdkSessionUnavailableError",
    "EncryptedSessionCheckpointStore",
    "LegacyAdkSessionError",
    "session_payload_aad",
]
