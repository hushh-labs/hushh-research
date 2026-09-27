"""Run manager for resumable Kai analyze streams.

Provides a per-session active-run lock and event buffering so clients can
disconnect/reconnect without losing an ongoing debate. A live run exists only in
the process that started it; ``kai_run_state`` (see ``analyze_run_store``) lets
every other process answer active-run, follow the run to its end and cancel it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, Optional

from starlette.concurrency import run_in_threadpool

import api.routes.kai.analyze_run_store as run_store
from hushh_mcp.services.feed_service import FeedService

logger = logging.getLogger(__name__)

RunStatus = str
RunFrame = dict[str, str]
RunGeneratorFactory = Callable[
    [str, str, str, str, Optional[Dict[str, Any]], Any],
    AsyncGenerator[RunFrame, None],
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# How often a live worker may ask the durable store whether its owner canceled
# the run from another process. Coarse on purpose: the generator polls
# ``is_disconnected`` only at stage boundaries, and this keeps the read to at
# most one query per interval per live run (never per frame).
_DURABLE_CANCEL_POLL_SECONDS = 5.0


class _BackgroundRunRequest:
    """Minimal request shim used by background workers.

    ``cancel_probe`` reads a cancel recorded by a different worker process (see
    ``KaiAnalyzeRunStore.request_cancel``). It is throttled and only consulted
    while the local cancel event is still clear.
    """

    def __init__(
        self,
        cancel_event: asyncio.Event,
        cancel_probe: Optional[Callable[[], Awaitable[bool]]] = None,
        *,
        poll_seconds: Optional[float] = None,
    ):
        self._cancel_event = cancel_event
        self._cancel_probe = cancel_probe
        interval = _DURABLE_CANCEL_POLL_SECONDS if poll_seconds is None else poll_seconds
        self._poll_seconds = max(0.0, interval)
        self._last_probe_at: Optional[float] = None

    async def is_disconnected(self) -> bool:
        if self._cancel_event.is_set():
            return True
        if self._cancel_probe is None:
            return False
        now = time.monotonic()
        if self._last_probe_at is not None and now - self._last_probe_at < self._poll_seconds:
            return False
        self._last_probe_at = now
        if await self._cancel_probe():
            self._cancel_event.set()
            return True
        return False


@dataclass
class AnalyzeRunRecord:
    run_id: str
    user_id: str
    debate_session_id: str
    ticker: str
    risk_profile: str
    context: Optional[Dict[str, Any]]
    consent_token: str
    status: RunStatus = "running"
    started_at: str = field(default_factory=_now_iso)
    completed_at: Optional[str] = None
    updated_at: str = field(default_factory=_now_iso)
    terminal_event: Optional[str] = None
    terminal_payload: Optional[Dict[str, Any]] = None
    events: list[RunFrame] = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    worker_task: Optional[asyncio.Task] = None
    # True only for records rebuilt from ``kai_run_state`` because the live run
    # belongs to another process. Such records hold no frames; streaming one
    # follows the owner (run_store.follow_remote_run) and the stream route skips
    # the stale-cursor 410 guard. Always False for live, locally-owned runs.
    is_durable_replay: bool = False
    durable_state: Optional[run_store.DurableRunState] = None
    # Set once the "Analysis ready" Feed item has been written for this run.
    completion_feed_recorded: bool = False
    # The frame that ended the run, kept for the sealed hand-off to another
    # process, and whether an attached local stream already delivered it.
    terminal_frame: Optional[RunFrame] = None
    terminal_delivered: bool = False
    heartbeat_task: Optional[asyncio.Task] = None
    relay_task: Optional[asyncio.Task] = None

    @property
    def latest_cursor(self) -> int:
        if self.durable_state is not None and not self.events:
            return self.durable_state.events_count
        return len(self.events)

    def to_public_dict(self) -> dict[str, Any]:
        context = self.context if isinstance(self.context, dict) else {}
        return {
            "run_id": self.run_id,
            "user_id": self.user_id,
            "debate_session_id": self.debate_session_id,
            "ticker": self.ticker,
            "risk_profile": self.risk_profile,
            "status": self.status,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "updated_at": self.updated_at,
            "latest_cursor": self.latest_cursor,
            "events_count": self.latest_cursor,
            "cancel_requested": self.cancel_event.is_set()
            or bool(self.durable_state and self.durable_state.cancel_requested),
            "terminal_event": self.terminal_event,
            "terminal_payload": self.terminal_payload,
            # Provenance is written by the server-side source resolver at run
            # start. Never expose the in-memory authorized package snapshot.
            "pick_source": context.get("pick_source"),
            "pick_source_label": context.get("pick_source_label"),
            "pick_source_kind": context.get("pick_source_kind"),
            "pick_source_snapshot": context.get("pick_source_snapshot"),
        }


_FALLBACK_BY_REASON: dict[str, tuple[str, str, str, bool]] = {
    "owner_lost": (
        "error",
        "ANALYZE_RUN_OWNER_LOST",
        "This analysis stopped before it finished because the server running it "
        "restarted. Run it again.",
        True,
    ),
    "not_retained": (
        "error",
        "ANALYZE_RESULT_NOT_RETAINED",
        "This analysis finished while you were away, and its result is not kept "
        "on our servers. Run it again to see it.",
        True,
    ),
    "canceled": ("aborted", "ANALYZE_RUN_CANCELED", "Run canceled by user.", False),
    "failed": ("error", "ANALYZE_RUN_FAILED", "Analysis could not be completed.", True),
}


def _fallback_frame(state: run_store.DurableRunState, reason: str, seq: int) -> RunFrame:
    event, code, message, retryable = _FALLBACK_BY_REASON[reason]
    if reason in {"canceled", "failed"}:
        code = run_store.safe_code(state.receipt.get("code")) or code
    return run_store.fallback_terminal_frame(
        state,
        seq=seq,
        event=event,
        code=code,
        message=message,
        retryable=retryable,
        stream_prefix="run_",
        stream_kind="stock_analyze",
        extra={"ticker": state.ticker},
    )


def _record_from_state(state: run_store.DurableRunState) -> AnalyzeRunRecord:
    """A read-only view of a run another process holds (or held)."""
    return AnalyzeRunRecord(
        run_id=state.run_id,
        user_id=state.user_id,
        debate_session_id=state.session_id,
        ticker=state.ticker,
        risk_profile="",
        context=None,
        consent_token="",
        status=state.status,
        started_at=state.started_at_iso or _now_iso(),
        completed_at=state.completed_at_iso,
        updated_at=state.completed_at_iso or _now_iso(),
        terminal_event=state.terminal_event,
        terminal_payload=dict(state.receipt) if state.is_terminal else None,
        is_durable_replay=True,
        durable_state=state,
    )


class KaiAnalyzeRunManager:
    """In-memory run manager for resumable analyze streams."""

    def __init__(
        self,
        *,
        retention_seconds: int = 6 * 60 * 60,
        store: Any = None,
    ) -> None:
        self._retention_seconds = max(60, retention_seconds)
        self._runs_by_id: dict[str, AnalyzeRunRecord] = {}
        self._active_by_session: dict[tuple[str, str], str] = {}
        self._lock = asyncio.Lock()
        # Cross-process run state. Injected in tests (``False`` disables it);
        # otherwise on unless the kill switch turns it off.
        if store is None:
            self._store = run_store.default_store_from_flag()
        else:
            self._store = store or None

    async def _append_frame(self, run: AnalyzeRunRecord, frame: RunFrame) -> dict[str, Any] | None:
        try:
            envelope = json.loads(frame.get("data", ""))
            if not isinstance(envelope, dict):
                envelope = None
        except Exception:
            envelope = None

        # Guarantee run identity in every envelope payload for reconnect/idempotency.
        if envelope is not None:
            payload = envelope.get("payload")
            if not isinstance(payload, dict):
                payload = {}
                envelope["payload"] = payload
            if not payload.get("run_id"):
                payload["run_id"] = run.run_id
            frame["data"] = json.dumps(envelope)

        async with run.condition:
            run.events.append(frame)
            run.updated_at = _now_iso()
            if envelope and bool(envelope.get("terminal")):
                event_name = str(envelope.get("event") or "")
                terminal_status = {
                    "decision": "completed",
                    "aborted": "canceled",
                    "error": "failed",
                }.get(event_name)
                # A run has one terminal transition. Duplicate/reordered frames
                # may still be replayed to a reconnecting client, but cannot
                # overwrite its durable outcome or emit another Feed row.
                if terminal_status is not None and run.status == "running":
                    run.terminal_event = event_name
                    payload = envelope.get("payload")
                    run.terminal_payload = payload if isinstance(payload, dict) else None
                    run.status = terminal_status
                    run.terminal_frame = frame
            run.condition.notify_all()
        return envelope if isinstance(envelope, dict) else None

    async def _record_completion_feed(self, run: AnalyzeRunRecord) -> None:
        """Write "Analysis ready" once the decision has reached the person's device.

        The result is saved to the person's encrypted history by the client that
        receives the decision; this server never holds it. A run that completes
        with nobody attached (the stream never attached, the app was closed)
        produces no saved result, so announcing it as ready sent people to an
        analysis that did not exist. Only a completed, locally-owned run whose
        terminal frame was handed to an attached stream is announced. Cancelled
        and failed runs never are. The stable run id keeps retries harmless; the
        optional durable store exposes no shared outbox, so this manager must not
        invent a second DB authority.
        """
        if run.completion_feed_recorded or run.is_durable_replay or run.status != "completed":
            return
        run.completion_feed_recorded = True
        await run_in_threadpool(
            FeedService().record_event,
            user_id=run.user_id,
            source_domain="kai",
            event_type="kai_analysis_completed",
            actor_label="Kai",
            metadata={"ticker": run.ticker, "run_id": run.run_id},
            source_row_id=run.run_id,
        )

    async def _append_synthetic_terminal(
        self,
        run: AnalyzeRunRecord,
        *,
        event_name: str,
        payload: dict[str, Any],
    ) -> None:
        frame: RunFrame = {
            "event": event_name,
            "id": str(run.latest_cursor + 1),
            "data": json.dumps(
                {
                    "schema_version": "1.0",
                    "stream_id": f"run_{run.run_id}",
                    "stream_kind": "stock_analyze",
                    "seq": run.latest_cursor + 1,
                    "event": event_name,
                    "terminal": True,
                    "payload": payload,
                }
            ),
        }
        await self._append_frame(run, frame)

    async def _run_worker(
        self,
        run: AnalyzeRunRecord,
        generator_factory: RunGeneratorFactory,
    ) -> None:
        background_request = _BackgroundRunRequest(
            run.cancel_event,
            self._durable_cancel_probe(run) if self._store is not None else None,
        )
        # Ends on its own once the run is terminal; never cancelled mid-write.
        run.heartbeat_task = (
            asyncio.create_task(
                run_store.owner_heartbeat(
                    self._store,
                    run=run,
                    run_kind="debate",
                    session_id=run.debate_session_id,
                    ticker=run.ticker,
                )
            )
            if self._store is not None
            else None
        )
        saw_terminal = False
        try:
            generator = generator_factory(
                run.ticker,
                run.user_id,
                run.consent_token,
                run.risk_profile,
                run.context,
                background_request,
            )
            async for frame in generator:
                envelope = await self._append_frame(run, frame)
                if envelope and bool(envelope.get("terminal")) and run.status != "running":
                    saw_terminal = True
                if run.cancel_event.is_set() and run.status in {"canceled", "failed", "completed"}:
                    break
        except Exception as exc:
            logger.exception("[KaiRun] Worker crashed for %s: %s", run.run_id, exc)
            run.status = "failed"
            await self._append_synthetic_terminal(
                run,
                event_name="error",
                payload={
                    "code": "ANALYZE_RUN_WORKER_FAILED",
                    "message": str(exc),
                    "ticker": run.ticker,
                    "run_id": run.run_id,
                },
            )
            saw_terminal = True
        finally:
            if run.cancel_event.is_set() and not saw_terminal:
                run.status = "canceled"
                await self._append_synthetic_terminal(
                    run,
                    event_name="aborted",
                    payload={
                        "code": "ANALYZE_RUN_CANCELED",
                        "message": "Run canceled by user.",
                        "ticker": run.ticker,
                        "run_id": run.run_id,
                    },
                )
            elif run.status == "running" and not saw_terminal:
                run.status = "failed"
                await self._append_synthetic_terminal(
                    run,
                    event_name="error",
                    payload={
                        "code": "ANALYZE_RUN_TERMINAL_MISSING",
                        "message": "Run ended without terminal event.",
                        "ticker": run.ticker,
                        "run_id": run.run_id,
                    },
                )

            run.completed_at = _now_iso()
            run.updated_at = run.completed_at
            async with run.condition:
                run.condition.notify_all()

            async with self._lock:
                session_key = (run.user_id, run.debate_session_id)
                active_run_id = self._active_by_session.get(session_key)
                if active_run_id == run.run_id:
                    del self._active_by_session[session_key]

            # One durable receipt per run, at terminal state, off the per-token
            # hot path; then answer hand-off requests from other processes.
            # persist_terminal never raises.
            if self._store is not None:
                await self._store.persist_terminal(
                    run_id=run.run_id,
                    user_id=run.user_id,
                    run_kind="debate",
                    session_id=run.debate_session_id,
                    ticker=run.ticker,
                    status=run.status,
                    terminal_event=run.terminal_event,
                    terminal_payload=run.terminal_payload,
                    started_at_iso=run.started_at,
                    completed_at_iso=run.completed_at,
                    progress=run_store.progress_from_events(run.events),
                )
                run.relay_task = asyncio.create_task(
                    run_store.serve_relay(
                        self._store,
                        run_id=run.run_id,
                        user_id=run.user_id,
                        terminal_frame=run.terminal_frame,
                        delivered=lambda: run.terminal_delivered,
                    )
                )

    async def _prune_locked(self) -> None:
        now = datetime.now(timezone.utc).timestamp()
        stale_ids: list[str] = []
        for run_id, run in self._runs_by_id.items():
            if run.status == "running":
                continue
            completed_at = run.completed_at or run.updated_at
            try:
                epoch = datetime.fromisoformat(completed_at.replace("Z", "+00:00")).timestamp()
            except Exception:
                epoch = now
            if now - epoch > self._retention_seconds:
                stale_ids.append(run_id)

        for run_id in stale_ids:
            self._runs_by_id.pop(run_id, None)

    async def start_or_get_active(
        self,
        *,
        user_id: str,
        debate_session_id: str,
        ticker: str,
        risk_profile: str,
        context: Optional[Dict[str, Any]],
        consent_token: str,
        generator_factory: RunGeneratorFactory,
    ) -> tuple[str, AnalyzeRunRecord]:
        async with self._lock:
            await self._prune_locked()
            session_key = (user_id, debate_session_id)
            active_run_id = self._active_by_session.get(session_key)
            if active_run_id:
                active_run = self._runs_by_id.get(active_run_id)
                if active_run and active_run.status == "running":
                    return "active", active_run
                self._active_by_session.pop(session_key, None)

            run_id = f"run_{uuid.uuid4().hex}"
            run = AnalyzeRunRecord(
                run_id=run_id,
                user_id=user_id,
                debate_session_id=debate_session_id,
                ticker=ticker,
                risk_profile=risk_profile,
                context=context,
                consent_token=consent_token,
            )
            run.worker_task = asyncio.create_task(self._run_worker(run, generator_factory))
            self._runs_by_id[run_id] = run
            self._active_by_session[session_key] = run_id

        # Visible to every process before the run id reaches the client.
        if self._store is not None:
            await self._store.heartbeat(
                run_id=run.run_id,
                user_id=user_id,
                run_kind="debate",
                session_id=debate_session_id,
                ticker=ticker,
                started_at_iso=run.started_at,
                progress=run_store.progress_from_events(run.events),
                sweep_expired=True,
            )
        return "started", run

    async def get_active(
        self,
        *,
        user_id: str,
        debate_session_id: str,
    ) -> Optional[AnalyzeRunRecord]:
        async with self._lock:
            await self._prune_locked()
            run_id = self._active_by_session.get((user_id, debate_session_id))
            run = self._runs_by_id.get(run_id) if run_id else None
            if run_id and run is None:
                self._active_by_session.pop((user_id, debate_session_id), None)
            if run is not None:
                return run

        # The run may be live in another process.
        if self._store is None:
            return None
        state = await self._store.load_active(
            user_id=user_id, run_kind="debate", session_id=debate_session_id
        )
        return _record_from_state(state) if state is not None else None

    async def get_run(self, run_id: str) -> Optional[AnalyzeRunRecord]:
        async with self._lock:
            await self._prune_locked()
            run = self._runs_by_id.get(run_id)
            if run is not None:
                return run

        # Not in this process's memory: the run may be live, or finished, in
        # another process. The lock only guards the in-memory dicts, so it is
        # released before the DB round trip.
        if self._store is None:
            return None
        state = await self._store.load(run_id=run_id, run_kind="debate")
        return _record_from_state(state) if state is not None else None

    def _durable_cancel_probe(self, run: AnalyzeRunRecord) -> Callable[[], Awaitable[bool]]:
        store = self._store

        async def _probe() -> bool:
            if store is None:
                return False
            return bool(await store.is_cancel_requested(run_id=run.run_id, user_id=run.user_id))

        return _probe

    async def cancel_run(self, *, run_id: str, user_id: str) -> Optional[AnalyzeRunRecord]:
        async with self._lock:
            local_run = self._runs_by_id.get(run_id)
        if local_run is None and self._store is not None:
            # The run lives in another process (or has finished). Record the
            # owner's cancel; the owning process stops at its next heartbeat.
            state = await self._store.load(run_id=run_id, run_kind="debate")
            if state is None or state.user_id != user_id:
                return None
            if state.status == "running":
                await self._store.request_cancel(run_id=run_id, user_id=user_id)
                state = await self._store.load(run_id=run_id, run_kind="debate") or state
            return _record_from_state(state)
        run = local_run
        if run is None or run.user_id != user_id:
            return None
        run.cancel_event.set()
        run.updated_at = _now_iso()
        async with run.condition:
            run.condition.notify_all()
        return run

    async def stream_run_events(
        self,
        *,
        run: AnalyzeRunRecord,
        start_cursor: int,
        request: Any,
    ) -> AsyncGenerator[RunFrame, None]:
        if run.durable_state is not None and self._store is not None:
            async for frame in run_store.follow_remote_run(
                self._store,
                state=run.durable_state,
                start_cursor=start_cursor,
                request=request,
                fallback_frame=_fallback_frame,
            ):
                yield frame
            return

        cursor = max(0, start_cursor)
        while True:
            if await request.is_disconnected():
                return

            pending: list[RunFrame] = []
            terminal_reached = False
            async with run.condition:
                while cursor >= len(run.events) and run.status == "running":
                    try:
                        await asyncio.wait_for(run.condition.wait(), timeout=15)
                    except asyncio.TimeoutError:
                        break
                    if await request.is_disconnected():
                        return
                if cursor < len(run.events):
                    pending = run.events[cursor:]
                    cursor = len(run.events)
                terminal_reached = run.status != "running" and cursor >= len(run.events)

            for frame in pending:
                yield frame

            if terminal_reached:
                # Reached only after the consumer pulled the terminal frame.
                run.terminal_delivered = True
                await self._record_completion_feed(run)
                return
