"""Run manager for resumable Kai portfolio-import streams.

Keeps one active import run per user, buffers canonical SSE frames, and lets
clients reconnect by run id + cursor without restarting parsing work.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Callable, Optional

logger = logging.getLogger(__name__)

RunStatus = str
RunFrame = dict[str, str]
ImportGeneratorFactory = Callable[["PortfolioImportRunRecord", Any], AsyncGenerator[RunFrame, None]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class _BackgroundImportRequest:
    """Minimal request shim used by background workers."""

    def __init__(self, cancel_event: asyncio.Event):
        self._cancel_event = cancel_event

    async def is_disconnected(self) -> bool:
        return self._cancel_event.is_set()


@dataclass
class PortfolioImportRunRecord:
    run_id: str
    user_id: str
    filename: str
    content: bytes
    is_csv_upload: bool
    status: RunStatus = "running"
    started_at: str = field(default_factory=_now_iso)
    completed_at: Optional[str] = None
    updated_at: str = field(default_factory=_now_iso)
    terminal_event: Optional[str] = None
    terminal_payload: Optional[dict[str, Any]] = None
    events: list[RunFrame] = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    worker_task: Optional[asyncio.Task] = None

    @property
    def latest_cursor(self) -> int:
        return len(self.events)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "user_id": self.user_id,
            "filename": self.filename,
            "status": self.status,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "updated_at": self.updated_at,
            "latest_cursor": self.latest_cursor,
            "events_count": len(self.events),
            "terminal_event": self.terminal_event,
            "terminal_payload": self.terminal_payload,
        }


class KaiPortfolioImportRunManager:
    """In-memory run manager for resumable portfolio-import streams."""

    def __init__(self, *, retention_seconds: int = 2 * 60 * 60) -> None:
        self._retention_seconds = max(60, retention_seconds)
        self._runs_by_id: dict[str, PortfolioImportRunRecord] = {}
        self._active_by_user: dict[str, str] = {}
        self._lock = asyncio.Lock()

    async def _append_frame(
        self, run: PortfolioImportRunRecord, frame: RunFrame
    ) -> dict[str, Any] | None:
        try:
            envelope = json.loads(frame.get("data", ""))
            if not isinstance(envelope, dict):
                envelope = None
        except Exception:
            envelope = None

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
                run.terminal_event = event_name or run.terminal_event
                payload = envelope.get("payload")
                run.terminal_payload = (
                    payload if isinstance(payload, dict) else run.terminal_payload
                )
                if event_name == "complete":
                    run.status = "completed"
                elif event_name == "aborted":
                    run.status = "canceled"
                elif event_name == "error":
                    run.status = "failed"
            run.condition.notify_all()
        return envelope if isinstance(envelope, dict) else None

    async def _append_synthetic_terminal(
        self,
        run: PortfolioImportRunRecord,
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
                    "stream_id": f"import_run_{run.run_id}",
                    "stream_kind": "portfolio_import",
                    "seq": run.latest_cursor + 1,
                    "event": event_name,
                    "terminal": True,
                    "payload": payload,
                }
            ),
        }
        await self._append_frame(run, frame)

    async def _run_worker(
        self, run: PortfolioImportRunRecord, generator_factory: ImportGeneratorFactory
    ) -> None:
        background_request = _BackgroundImportRequest(run.cancel_event)
        saw_terminal = False
        try:
            generator = generator_factory(run, background_request)
            async for frame in generator:
                envelope = await self._append_frame(run, frame)
                if envelope and bool(envelope.get("terminal")):
                    saw_terminal = True
                if run.cancel_event.is_set() and run.status in {
                    "canceled",
                    "failed",
                    "completed",
                }:
                    break
        except Exception as exc:
            logger.exception("[KaiImportRun] Worker crashed for %s: %s", run.run_id, exc)
            run.status = "failed"
            await self._append_synthetic_terminal(
                run,
                event_name="error",
                payload={
                    "code": "IMPORT_RUN_WORKER_FAILED",
                    "message": str(exc),
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
                        "code": "IMPORT_RUN_CANCELED",
                        "message": "Import was interrupted before completion.",
                        "run_id": run.run_id,
                    },
                )
            elif run.status == "running" and not saw_terminal:
                run.status = "failed"
                await self._append_synthetic_terminal(
                    run,
                    event_name="error",
                    payload={
                        "code": "IMPORT_RUN_TERMINAL_MISSING",
                        "message": "Import run ended without terminal event.",
                        "run_id": run.run_id,
                    },
                )

            run.completed_at = _now_iso()
            run.updated_at = run.completed_at
            # Release the uploaded bytes once parsing is done.
            run.content = b""

            async with run.condition:
                run.condition.notify_all()

            async with self._lock:
                active_run_id = self._active_by_user.get(run.user_id)
                if active_run_id == run.run_id:
                    del self._active_by_user[run.user_id]

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
        filename: str,
        content: bytes,
        is_csv_upload: bool,
        generator_factory: ImportGeneratorFactory,
    ) -> tuple[str, PortfolioImportRunRecord]:
        async with self._lock:
            await self._prune_locked()
            active_run_id = self._active_by_user.get(user_id)
            if active_run_id:
                active_run = self._runs_by_id.get(active_run_id)
                if active_run and active_run.status == "running":
                    return "active", active_run
                self._active_by_user.pop(user_id, None)

            run_id = f"import_run_{uuid.uuid4().hex}"
            run = PortfolioImportRunRecord(
                run_id=run_id,
                user_id=user_id,
                filename=filename,
                content=content,
                is_csv_upload=is_csv_upload,
            )
            run.worker_task = asyncio.create_task(self._run_worker(run, generator_factory))
            self._runs_by_id[run_id] = run
            self._active_by_user[user_id] = run_id
            return "started", run

    async def get_active(self, *, user_id: str) -> Optional[PortfolioImportRunRecord]:
        async with self._lock:
            await self._prune_locked()
            run_id = self._active_by_user.get(user_id)
            if not run_id:
                return None
            run = self._runs_by_id.get(run_id)
            if not run:
                self._active_by_user.pop(user_id, None)
                return None
            return run

    async def get_run(self, run_id: str) -> Optional[PortfolioImportRunRecord]:
        async with self._lock:
            await self._prune_locked()
            return self._runs_by_id.get(run_id)

    async def cancel_run(self, *, run_id: str, user_id: str) -> Optional[PortfolioImportRunRecord]:
        run = await self.get_run(run_id)
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
        run: PortfolioImportRunRecord,
        start_cursor: int,
        request: Any,
    ) -> AsyncGenerator[RunFrame, None]:
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
                return
