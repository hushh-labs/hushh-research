"""The provisioning-status surface: a cursored reader over the narrative log.

Two endpoints, both PURE READERS -- this is a hard requirement, not a style
preference. The status GET this surface replaces used to call
``collect_pod_key_if_pending``, which on a ``connecting`` row performed an
ID-token fetch, a pod GET, two registry writes, a 24-hour standing ``pkm.read``
HCT mint, and a feed insert -- per poll, per open tab. A status read must not
mint consent authority. Neither endpoint here writes anything, anywhere.

THE STREAM IS A SEGMENT, NOT A PIPE. Every hop between the browser and this
process imposes a deadline shorter than provisioning takes (45s Next proxy, 60s
browser wrapper, 120s frontend Cloud Run). Rather than fight four deadlines,
a connection lives ~40 seconds, ends with an explicit ``segment_end`` frame
carrying ``next_cursor``, and the client reconnects there. End-of-stream
therefore carries NO meaning -- a severed connection and a clean close read
identically to the client ("reconnect at my cursor"), which turns every
middlebox timeout from a silent guillotine into a shorter segment.

EVERY CONNECT OPENS WITH AUTHORITY. The ``snapshot`` frame is read from the
registry row, never the log, so a lost narrative row costs one missing
intermediate frame and can never produce a wrong state. On any disagreement
between snapshot and narrative, the snapshot wins by construction: it is
emitted first and carries the row's own state.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.kai._streaming import CanonicalSSEStream

logger = logging.getLogger(__name__)

# The FULL prefix, like every sibling in this package -- the one-router carries
# no prefix of its own, so a bare "/pod/lifecycle" registers at the app root,
# invisible behind the frontend's /api/one proxy. Found live: the deployed
# revision answered 404 while the router imported cleanly, which is why the
# guard test pins the mounted paths and not merely the import.
router = APIRouter(prefix="/api/one/pod/lifecycle", tags=["pod-lifecycle"])

#: One segment's lifetime. 40s clears the 45s proxy cap, the 60s browser
#: wrapper, and the 120s frontend Cloud Run ceiling, with margin on the first.
SEGMENT_SECONDS = 40.0
#: Doorbell wait per iteration; doubles as the heartbeat cadence when quiet.
HEARTBEAT_SECONDS = 15.0
#: Max narrative rows returned per read. A catch-up after an hour away is a few
#: dozen rows; 200 bounds a pathological log without truncating a real one.
BATCH_LIMIT = 200

_EVENTS_SQL = """
SELECT seq, event, stage, registry_status, progress_pct, substrate_step,
       step_ok, terminal, reason, occurred_at
FROM pod_lifecycle_events
WHERE user_id = :user_id AND seq > :cursor
ORDER BY seq
LIMIT :limit
"""

_HEAD_SQL = """
SELECT COALESCE(MAX(seq), 0) AS head
FROM pod_lifecycle_events
WHERE user_id = :user_id
"""


def _read_events_sync(user_id: str, cursor: int, limit: int = BATCH_LIMIT) -> list[dict]:
    """Blocking read, always called through to_thread. Absent table -> empty.

    The table is a parked dev-only migration, so this surface must degrade to
    snapshot-only (not 500) anywhere the migration has not run.
    """
    try:
        from db.db_client import get_db  # noqa: PLC0415

        result = get_db().execute_raw(
            _EVENTS_SQL, {"user_id": user_id, "cursor": cursor, "limit": limit}
        )
        return list(result.data or [])
    except Exception as exc:  # noqa: BLE001 - narrative read failure degrades, never breaks
        logger.warning("pod_lifecycle.events_read_failed err=%s", type(exc).__name__)
        return []


def _read_head_sync(user_id: str) -> int:
    try:
        from db.db_client import get_db  # noqa: PLC0415

        result = get_db().execute_raw(_HEAD_SQL, {"user_id": user_id})
        rows = result.data or []
        return int(rows[0].get("head") or 0) if rows else 0
    except Exception:  # noqa: BLE001
        return 0


async def _snapshot_payload(user_id: str, cursor: int) -> dict[str, Any]:
    """The authoritative opener: the registry row's own answer, plus the cursor."""
    from api.routes.one.personal_agent import resolve_personal_agent_status  # noqa: PLC0415

    status = await resolve_personal_agent_status(user_id=user_id)
    head = await asyncio.to_thread(_read_head_sync, user_id)
    payload: dict[str, Any] = {
        "cursor": max(cursor, 0),
        "head": head,
        "state": status.get("state"),
        "stage": "snapshot",
    }
    for key in ("hushhId", "health", "lastSeenAt", "hostReady", "featureEnabled"):
        if status.get(key) is not None:
            payload[key] = status[key]
    return payload


def _frame_payload(row: dict[str, Any]) -> dict[str, Any]:
    """One narrative row as one frame payload. Identifiers and verdicts only.

    Carries the row's EVENT KIND and TERMINAL verdict in the payload itself,
    not only in the SSE envelope: the JSON twin returns these payloads bare,
    and without both fields in the payload the two transports would hand the
    client different frames -- the exact parity the dual-transport design
    promises.
    """
    from api.routes.one.personal_agent import _STATE_BY_REGISTRY_STATUS  # noqa: PLC0415

    payload: dict[str, Any] = {
        "cursor": int(row.get("seq") or 0),
        "state": _STATE_BY_REGISTRY_STATUS.get(str(row.get("registry_status") or ""), "reserved"),
        "stage": row.get("stage"),
        "progress_pct": int(row.get("progress_pct") or 0),
        "event": str(row.get("event") or "stage"),
        "terminal": bool(row.get("terminal")),
    }
    if row.get("substrate_step"):
        payload["substrate_step"] = row["substrate_step"]
        payload["step_ok"] = bool(row.get("step_ok"))
    if row.get("reason"):
        payload["reason"] = row["reason"]
    occurred = row.get("occurred_at")
    if occurred is not None:
        payload["occurred_at"] = str(occurred)
    return payload


def _sse(frame: dict[str, str]) -> str:
    return f"event: {frame['event']}\nid: {frame['id']}\ndata: {frame['data']}\n\n"


@router.get("")
@limiter.limit(RateLimits.AGENT_CHAT)
async def pod_lifecycle_snapshot(
    request: Request,
    cursor: int = Query(default=0, ge=0),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """Snapshot plus narrative since ``cursor``, as one JSON read.

    This is the NATIVE transport, not a degraded fallback: Capacitor buffers
    whole responses and cannot stream, so on native this endpoint IS the
    lifecycle surface, polled at the client's cadence. It is also what any
    misbehaving middlebox degrades the SSE path onto, with identical frames.
    """
    snapshot = await _snapshot_payload(user_id, cursor)
    rows = await asyncio.to_thread(_read_events_sync, user_id, cursor)
    events = [_frame_payload(row) for row in rows]
    next_cursor = events[-1]["cursor"] if events else max(cursor, 0)
    return {
        "snapshot": snapshot,
        "events": events,
        "nextCursor": next_cursor,
        "terminal": any(bool(row.get("terminal")) for row in rows),
    }


@router.get("/stream")
@limiter.limit(RateLimits.AGENT_CHAT)
async def pod_lifecycle_stream(
    request: Request,
    cursor: int = Query(default=0, ge=0),
    user_id: str = Depends(require_firebase_auth),
) -> StreamingResponse:
    """One ~40-second segment of the narrative, as canonical SSE.

    Frames: ``snapshot`` (always first, from authority), then any narrative rows
    past the caller's cursor, then doorbell-driven rows as they land, then
    ``segment_end`` with ``next_cursor``. Heartbeat comments every ~15s keep
    intermediaries from timing out an idle connection inside the segment.
    """
    from api import pod_lifecycle_listener  # noqa: PLC0415

    start_cursor = cursor

    async def generate():
        stream = CanonicalSSEStream(stream_kind="pod_lifecycle")
        current = start_cursor
        terminal_seen = False
        deadline = time.monotonic() + SEGMENT_SECONDS

        snapshot = await _snapshot_payload(user_id, current)
        yield _sse(stream.event("snapshot", snapshot))

        queue = await pod_lifecycle_listener.register(user_id)
        try:
            while True:
                rows = await asyncio.to_thread(_read_events_sync, user_id, current)
                for row in rows:
                    payload = _frame_payload(row)
                    is_terminal = bool(row.get("terminal"))
                    terminal_seen = terminal_seen or is_terminal
                    yield _sse(
                        stream.event(
                            str(row.get("event") or "stage"), payload, terminal=is_terminal
                        )
                    )
                    current = max(current, payload["cursor"])
                if terminal_seen:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                # Wait for a doorbell, at most one heartbeat interval. A timeout is
                # not an error: it is the cue to re-read (covers dropped doorbells
                # and a listener that never came up) and to emit a comment that
                # keeps intermediaries from reaping an idle connection.
                try:
                    await asyncio.wait_for(queue.get(), timeout=min(HEARTBEAT_SECONDS, remaining))
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
        finally:
            await pod_lifecycle_listener.unregister(user_id, queue)

        yield _sse(
            stream.event(
                "segment_end",
                {
                    "cursor": current,
                    "next_cursor": current,
                    # 0 while the journey is live -- reconnect immediately. Once
                    # terminal, the client may still follow (a reaped pod can be
                    # re-provisioned) but has no reason to hurry.
                    "reconnect_after_ms": 5000 if terminal_seen else 0,
                    "stage": "segment_end",
                },
                terminal=False,
            )
        )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
