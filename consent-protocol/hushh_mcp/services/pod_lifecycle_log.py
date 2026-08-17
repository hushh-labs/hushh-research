"""The one funnel that appends provisioning narrative to ``pod_lifecycle_events``.

Two entry points and nothing else:

* :func:`append` -- for async callers. Offloads to a worker thread, because the
  underlying client is synchronous SQLAlchemy and blocking the event loop to
  write narrative would be paying for the story with the plot.
* :func:`append_sync` -- for callers that are ALREADY on a worker thread. The
  substrate applier is a synchronous ``for`` loop invoked via ``asyncio.to_thread``
  (``byoc_substrate.py``), so its ``on_step`` callback fires with no running loop
  and cannot await. Synchronous SQLAlchemy is the natural fit there, not the
  workaround.

BOTH ARE FAIL-SAFE AND SWALLOWED, same contract as
``record_provisioning_feed_event_safe``: the registry row is the authority and
this table is replayable narrative, so a lost append costs one missing frame in
a story whose truth the stream's snapshot re-derives from the row within one
40-second segment. A raised append error, by contrast, would break provisioning
itself -- which runs fire-and-forget in places where nobody sees the exception.

WHY THE SEQ IS COMPUTED INSIDE THE INSERT

``INSERT ... SELECT COALESCE(MAX(seq),0)+1`` with ``PRIMARY KEY (user_id, seq)``
makes a two-writer race (reconcile retry overlapping a live provision -- real)
fail loudly on the key instead of silently skipping a frame the way BIGSERIAL
does. The single retry below is the loud failure being handled: recompute, try
once more, and if the second attempt also collides, drop the frame and log --
two consecutive collisions on one user means a writer storm the narrative log
must not amplify.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_INSERT_SQL = """
INSERT INTO pod_lifecycle_events
  (user_id, seq, hushh_id, attempt, event, stage, registry_status,
   progress_pct, substrate_step, step_ok, terminal, reason)
SELECT
  :user_id,
  COALESCE(MAX(seq), 0) + 1,
  :hushh_id, :attempt, :event, :stage, :registry_status,
  :progress_pct, :substrate_step, :step_ok, :terminal, :reason
FROM pod_lifecycle_events
WHERE user_id = :user_id
"""

#: Stage -> progress mapping, one place. Shared vocabulary with
#: ``scripts/ops/trace_pod_journey.py`` -- the operator's diagnostic and the
#: person's progress bar must emit the same names, so "what the user saw" and
#: "what actually happened" compare without translation.
STAGE_PROGRESS: dict[str, int] = {
    "registry_row": 5,
    "substrate": 12,  # 16 steps advance 12 -> 50 via step_index below
    "host_requested": 55,
    "host_created": 60,
    "invoker_bound": 65,
    "host_serving": 75,
    "pod_booted": 88,
    "key_published": 94,
    "authority_live": 100,
}

#: The registry statuses that end a journey. `terminal` on the row lets a reader
#: stop without knowing the stage vocabulary.
_TERMINAL_STAGES = frozenset(
    {"ready", "authority_live", "failed", "capped", "blocked_authorization"}
)

#: What one registry-status transition means as a stage, for the funnel inside
#: `registry_repo.upsert` -- which sees only the status. The finer stages
#: (host_created, invoker_bound, substrate steps...) arrive through the on_stage /
#: on_step callbacks, which know more than the row does. Statuses absent here
#: (`unprovisioned`) represent no forward motion and append nothing.
STAGE_BY_REGISTRY_STATUS: dict[str, str] = {
    "pending": "registry_row",
    "provisioning": "host_requested",
    "connecting": "pod_booted",
    "provisioned": "authority_live",
    "provisioning_failed": "failed",
    "reaped": "reaped",
}


def substrate_progress(step_index: int, step_total: int = 16) -> int:
    """Map substrate step N of 16 onto the 12..50 band, monotonically."""
    if step_total <= 0:
        return STAGE_PROGRESS["substrate"]
    span = 50 - STAGE_PROGRESS["substrate"]
    return STAGE_PROGRESS["substrate"] + min(span, max(0, (step_index * span) // step_total))


def append_sync(
    user_id: str,
    *,
    stage: str,
    registry_status: str,
    event: str = "stage",
    hushh_id: Optional[str] = None,
    attempt: int = 1,
    progress_pct: Optional[int] = None,
    substrate_step: Optional[str] = None,
    step_ok: Optional[bool] = None,
    reason: Optional[str] = None,
) -> None:
    """Append one narrative row. Never raises; never blocks provisioning."""
    from hushh_mcp.runtime_settings import pod_lifecycle_log_enabled  # noqa: PLC0415

    if not user_id or not pod_lifecycle_log_enabled():
        return
    try:
        from db.db_client import get_db  # noqa: PLC0415

        params: dict[str, Any] = {
            "user_id": user_id,
            "hushh_id": hushh_id,
            "attempt": max(1, int(attempt)),
            "event": event,
            "stage": stage,
            "registry_status": registry_status,
            "progress_pct": (
                progress_pct if progress_pct is not None else STAGE_PROGRESS.get(stage, 0)
            ),
            "substrate_step": substrate_step,
            "step_ok": step_ok,
            "terminal": stage in _TERMINAL_STAGES,
            "reason": reason,
        }
        client = get_db()
        try:
            client.execute_raw(_INSERT_SQL, params)
        except Exception:  # noqa: BLE001 - the PK collision is the designed loud failure
            # One retry, recomputing MAX(seq) fresh. A second collision means two
            # writers are racing hard on one user; the narrative must not amplify
            # that by spinning, so the frame is dropped and said so.
            client.execute_raw(_INSERT_SQL, params)
    except Exception as exc:  # noqa: BLE001 - narrative must never break provisioning
        logger.warning(
            "pod_lifecycle_log.append_dropped user_id_prefix=%s stage=%s err=%s",
            user_id[:8],
            stage,
            type(exc).__name__,
        )


async def append(
    user_id: str,
    *,
    stage: str,
    registry_status: str,
    event: str = "stage",
    hushh_id: Optional[str] = None,
    attempt: int = 1,
    progress_pct: Optional[int] = None,
    substrate_step: Optional[str] = None,
    step_ok: Optional[bool] = None,
    reason: Optional[str] = None,
) -> None:
    """Async wrapper: same semantics as :func:`append_sync`, off the event loop."""
    await asyncio.to_thread(
        append_sync,
        user_id,
        stage=stage,
        registry_status=registry_status,
        event=event,
        hushh_id=hushh_id,
        attempt=attempt,
        progress_pct=progress_pct,
        substrate_step=substrate_step,
        step_ok=step_ok,
        reason=reason,
    )


__all__ = ["STAGE_PROGRESS", "append", "append_sync", "substrate_progress"]
