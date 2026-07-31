"""Durable terminal-checkpoint store for resumable Kai analyze ("debate") runs.

Why this exists
---------------
A resumable analyze run is two HTTP requests: ``POST .../analyze/run/start``
creates the run, then ``GET .../analyze/run/{run_id}/stream`` streams it. Run
state lives in :class:`~api.routes.kai.run_manager.KaiAnalyzeRunManager`, an
in-memory module-global singleton *per Cloud Run instance*. In production the
two requests fan across instances, so ``/stream`` can land on an instance that
never created the run -> 404 ``ANALYZE_RUN_NOT_FOUND`` (the multi-instance
prod-parity bug). UAT runs a single instance, so it never reproduces there.

What this does
--------------
Persists a single **metadata-only terminal receipt** per run to Postgres (table
``kai_analyze_runs``, migration 125) at the moment a run reaches a terminal
state (``completed`` / ``failed`` / ``canceled``). A ``/stream`` request that
misses the local in-memory buffer can then read that receipt back and replay a
safe terminal frame instead of stalling.

Deliberate constraints
----------------------
* **One write per run**, in the worker's ``finally`` (never on the per-token hot
  path) -> honors the #4736 connection-pool pin (``DB_SQLALCHEMY_MAX_OVERFLOW=0``)
  by never fanning out DB I/O per frame.
* **Portable SQL** -- ``TEXT`` JSON (not ``jsonb``), epochs computed in Python
  (no ``now()`` / ``INTERVAL``), ``ON CONFLICT (run_id) DO UPDATE SET
  col = EXCLUDED.col`` (no repeated params, no ``::`` casts, no ``RETURNING``).
  The same statements run on real Postgres and on the offline SQLite test
  harness, so the cross-instance recovery test gates in CI.
* **All parameterized** (``$1..$N``) -> bandit B608 safe.
* **No source material** -- cards, transcripts, model output, market inputs,
  and PKM context remain in the live in-memory stream only.
* **Fail-safe**: :meth:`persist_terminal` never raises; :meth:`load_terminal_run`
  returns ``None`` on any error. When the feature flag is off the store is never
  constructed and none of this executes.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Terminal statuses that are safe to checkpoint. Mirrors the CHECK constraint on
# kai_analyze_runs.status (migration 125). A non-terminal ("running") run is
# never persisted -- we only checkpoint the final, replayable state.
_TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled"})

# Default retention for a durable checkpoint. Matches the in-memory manager's
# 6h retention so durable replay and local buffering expire on the same horizon.
_DEFAULT_RETENTION_SECONDS = 6 * 60 * 60


def _safe_terminal_receipt(run: Any) -> dict[str, Any]:
    """Return the only terminal payload allowed in durable storage.

    A run's live terminal payload can include market source material, model
    prose and temporary PKM context.  Those belong in the active stream only;
    a cross-instance checkpoint needs just enough metadata to tell the client
    that the run reached a terminal state.
    """
    payload = getattr(run, "terminal_payload", None)
    source = payload if isinstance(payload, dict) else {}
    decision = str(source.get("decision") or source.get("decision_type") or "").strip()[:32]
    try:
        confidence = max(0.0, min(float(source.get("confidence") or 0.0), 1.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "run_id": str(getattr(run, "run_id", "") or ""),
        "ticker": str(getattr(run, "ticker", "") or "")[:32],
        "status": str(getattr(run, "status", "") or "")[:32],
        "decision": decision or None,
        "confidence": confidence,
        "completed_at": str(getattr(run, "completed_at", "") or "")[:64] or None,
    }


class KaiAnalyzeRunStore:
    """Persist and replay coarse terminal checkpoints for analyze runs.

    Stateless aside from configuration; every method acquires the shared pool
    lazily via ``db.connection.get_pool`` so importing this module never forces a
    DB connection (and construction stays cheap when the flag is on but no run
    has completed yet).
    """

    def __init__(self, *, retention_seconds: int = _DEFAULT_RETENTION_SECONDS) -> None:
        self._retention_seconds = max(60, int(retention_seconds))

    async def persist_terminal(self, run: Any) -> None:
        """Best-effort write of a run's terminal checkpoint. Never raises.

        Called once from the worker ``finally`` when ``run.status`` is already
        terminal. A no-op for non-terminal runs. Any DB error is swallowed
        (logged): a failed checkpoint must never affect the run's own
        completion or the live stream the originating instance is still serving.
        """
        status = getattr(run, "status", None)
        if status not in _TERMINAL_STATUSES:
            return

        try:
            checkpoint_payload = _safe_terminal_receipt(run)
            payload_json = json.dumps(checkpoint_payload)
            now = int(time.time())
            expires_at = now + self._retention_seconds

            from db.connection import get_pool

            pool = await get_pool()
            await pool.execute(
                """
                INSERT INTO kai_analyze_runs (
                    run_id, user_id, debate_session_id, ticker, risk_profile,
                    status, terminal_event, terminal_payload,
                    started_at_iso, completed_at_iso, created_at, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (run_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    terminal_event = EXCLUDED.terminal_event,
                    terminal_payload = EXCLUDED.terminal_payload,
                    completed_at_iso = EXCLUDED.completed_at_iso,
                    expires_at = EXCLUDED.expires_at
                """,
                run.run_id,
                getattr(run, "user_id", "") or "",
                getattr(run, "debate_session_id", "") or "",
                getattr(run, "ticker", "") or "",
                getattr(run, "risk_profile", "") or "",
                status,
                getattr(run, "terminal_event", None),
                payload_json,
                getattr(run, "started_at", None),
                getattr(run, "completed_at", None),
                now,
                expires_at,
            )

            # Opportunistic expiry sweep. Best-effort; a failure here must not
            # surface. Coarse (one DELETE per terminal write, not per frame), so
            # it does not reintroduce the pool fanout the #4736 pin guards against.
            try:
                await pool.execute(
                    "DELETE FROM kai_analyze_runs WHERE expires_at < $1",
                    now,
                )
            except Exception:  # pragma: no cover - defensive
                logger.debug("[KaiRunStore] expiry sweep skipped for %s", run.run_id, exc_info=True)
        except Exception:
            # Fail-safe: a checkpoint write must never break run completion.
            logger.warning(
                "[KaiRunStore] persist_terminal failed for %s",
                getattr(run, "run_id", "?"),
                exc_info=True,
            )

    async def load_terminal_run(self, run_id: str) -> Optional[Any]:
        """Load a durable terminal checkpoint and rebuild a replayable record.

        Returns a :class:`AnalyzeRunRecord` carrying a single synthetic terminal
        frame and ``is_durable_replay=True`` so the stream route replays the
        final frame (and skips the stale-cursor 410 guard). Returns ``None`` if
        no live (non-expired) checkpoint exists or on any parse/DB error.
        """
        try:
            now = int(time.time())

            from db.connection import get_pool

            pool = await get_pool()
            row = await pool.fetchrow(
                """
                SELECT run_id, user_id, debate_session_id, ticker, risk_profile,
                       status, terminal_event, terminal_payload,
                       started_at_iso, completed_at_iso, expires_at
                FROM kai_analyze_runs
                WHERE run_id = $1 AND expires_at >= $2
                """,
                run_id,
                now,
            )
            if row is None:
                return None

            status = row["status"]
            if status not in _TERMINAL_STATUSES:
                return None

            # terminal_payload is stored as TEXT JSON (portable). Parse
            # defensively; a corrupt row degrades to an empty payload rather
            # than breaking the replay.
            try:
                payload = json.loads(row["terminal_payload"] or "{}")
                if not isinstance(payload, dict):
                    payload = {}
            except Exception:
                payload = {}
            # Guarantee run identity for reconnect/idempotency, mirroring the
            # live path's _append_frame invariant.
            if not payload.get("run_id"):
                payload["run_id"] = run_id

            event_name = row["terminal_event"] or ("decision" if status == "completed" else "error")

            frame = {
                "event": event_name,
                "id": "1",
                "data": json.dumps(
                    {
                        "schema_version": "1.0",
                        "stream_id": f"run_{run_id}",
                        "stream_kind": "stock_analyze",
                        "seq": 1,
                        "event": event_name,
                        "terminal": True,
                        "payload": payload,
                    }
                ),
            }

            # Lazy import to avoid a circular dependency (run_manager imports this
            # module to construct the store).
            from api.routes.kai.run_manager import AnalyzeRunRecord

            completed_iso = row["completed_at_iso"]
            started_iso = row["started_at_iso"]
            return AnalyzeRunRecord(
                run_id=run_id,
                user_id=row["user_id"] or "",
                debate_session_id=row["debate_session_id"] or "",
                ticker=row["ticker"] or "",
                risk_profile=row["risk_profile"] or "",
                context=None,
                consent_token="",
                status=status,
                started_at=started_iso or completed_iso or _fallback_iso(),
                completed_at=completed_iso,
                updated_at=completed_iso or _fallback_iso(),
                terminal_event=event_name,
                terminal_payload=payload,
                events=[frame],
                is_durable_replay=True,
            )
        except Exception:
            logger.warning("[KaiRunStore] load_terminal_run failed for %s", run_id, exc_info=True)
            return None


def _fallback_iso() -> str:
    """UTC ISO8601 (Z) fallback for a checkpoint missing its timestamps."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
