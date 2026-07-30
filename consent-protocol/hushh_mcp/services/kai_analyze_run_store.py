"""Durable coarse-checkpoint store for Kai/RIA analyze ("debate") runs.

Why this exists
---------------
``KaiAnalyzeRunManager`` (``api/routes/kai/run_manager.py``) keeps run state in
an in-memory, per-process dict. On Cloud Run the backend fans across multiple
instances, so a client that reconnects to ``GET /analyze/run/{run_id}/stream``
can land on an instance that never created the run and receive HTTP 404
``ANALYZE_RUN_NOT_FOUND``. This module is a *coarse* mirror of run state in
Postgres (table ``kai_analyze_runs``, migration 125) that the stream routes read
**only on the 404 miss path** so a cross-instance reconnect can still receive
the run's final terminal frame (e.g. the DecisionCard).

Design guardrails (do not soften without re-reading the parity + fanout notes)
------------------------------------------------------------------------------
* **Coarse only.** We persist at most two checkpoints per run — ``start`` and
  ``terminal``. We never persist per-token frames: that would re-introduce the
  connection fanout that #4736 pinned away (``DB_SQLALCHEMY_MAX_OVERFLOW=0``).
* **Best-effort.** Every function swallows its own errors and returns a falsy
  value. A store outage must never break the live SSE hot path — the run still
  streams from memory on the instance that owns it.
* **Flag-gated by the caller.** This module does not read the feature flag; the
  stream layer only calls it when ``KAI_ANALYZE_DURABLE_RUN_STORE`` is enabled,
  so with the flag OFF (the default) there are zero reads and zero writes and
  production behavior is byte-for-byte unchanged.
* **No secrets.** The consent token is never written here.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_TABLE = "kai_analyze_runs"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _coerce_json(value: Any) -> Optional[Dict[str, Any]]:
    """Return a dict from a JSON column value.

    Postgres JSONB round-trips as a ``dict``; the offline SQLite engine stores
    JSON as TEXT and returns a ``str``. Anything else (or malformed JSON) yields
    ``None`` so callers can fall back cleanly.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def save_start_checkpoint(
    *,
    run_id: str,
    user_id: str,
    debate_session_id: Optional[str] = None,
    ticker: Optional[str] = None,
    risk_profile: Optional[str] = None,
    started_at: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> bool:
    """Persist the coarse ``start`` checkpoint (status='running').

    Best-effort: returns ``True`` on write, ``False`` on any failure. Uses
    ``upsert(on_conflict=run_id)`` so a retry or a late terminal write both
    converge on one row.
    """
    try:
        from db.db_client import get_db

        now = updated_at or started_at or _now_iso()
        row: Dict[str, Any] = {
            "run_id": run_id,
            "user_id": user_id,
            "debate_session_id": debate_session_id,
            "ticker": ticker,
            "risk_profile": risk_profile,
            "status": "running",
            "started_at": started_at or now,
            "updated_at": now,
            "created_at": now,
        }
        get_db().table(_TABLE).upsert(row, on_conflict="run_id").execute()
        return True
    except Exception:  # pragma: no cover - best-effort mirror
        logger.debug("[KaiRunStore] start checkpoint failed for %s", run_id, exc_info=True)
        return False


def save_terminal_checkpoint(
    *,
    run_id: str,
    user_id: str,
    status: str,
    terminal_event: Optional[str],
    terminal_payload: Optional[Dict[str, Any]],
    debate_session_id: Optional[str] = None,
    ticker: Optional[str] = None,
    risk_profile: Optional[str] = None,
    completed_at: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> bool:
    """Persist the coarse terminal checkpoint.

    Best-effort: returns ``True`` on write, ``False`` on any failure. Uses
    ``upsert(on_conflict=run_id)`` so it self-heals into a complete row even when
    the ``start`` checkpoint was never written (e.g. the flag was flipped on
    mid-run). Identity columns are only included when provided so a conflict
    update never clobbers a good start value with ``None``.
    """
    try:
        from db.db_client import get_db

        now = updated_at or completed_at or _now_iso()
        row: Dict[str, Any] = {
            "run_id": run_id,
            "user_id": user_id,
            "status": status or "completed",
            "terminal_event": terminal_event,
            "terminal_payload": terminal_payload,
            "completed_at": completed_at,
            "updated_at": now,
            "created_at": now,
        }
        if debate_session_id is not None:
            row["debate_session_id"] = debate_session_id
        if ticker is not None:
            row["ticker"] = ticker
        if risk_profile is not None:
            row["risk_profile"] = risk_profile
        get_db().table(_TABLE).upsert(row, on_conflict="run_id").execute()
        return True
    except Exception:  # pragma: no cover - best-effort mirror
        logger.debug("[KaiRunStore] terminal checkpoint failed for %s", run_id, exc_info=True)
        return False


def load_terminal_checkpoint(
    *,
    run_id: str,
    user_id: str,
) -> Optional[Dict[str, Any]]:
    """Return the terminal checkpoint for a completed run owned by ``user_id``.

    Returns ``None`` when the store is unreachable, the run is unknown, the
    caller does not own it, or the run has no terminal event yet (still running,
    or the terminal checkpoint was never written). Ownership is enforced in the
    query (``user_id`` filter) so a mismatch simply yields no row.
    """
    try:
        from db.db_client import get_db

        result = (
            get_db()
            .table(_TABLE)
            .select("*")
            .eq("run_id", run_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None

        row = rows[0]
        terminal_event = row.get("terminal_event")
        if not terminal_event:
            return None

        payload = _coerce_json(row.get("terminal_payload")) or {}
        payload.setdefault("run_id", run_id)
        return {
            "run_id": run_id,
            "user_id": row.get("user_id"),
            "status": row.get("status"),
            "terminal_event": terminal_event,
            "terminal_payload": payload,
            "ticker": row.get("ticker"),
            "debate_session_id": row.get("debate_session_id"),
        }
    except Exception:  # pragma: no cover - best-effort read-through
        logger.debug("[KaiRunStore] terminal load failed for %s", run_id, exc_info=True)
        return None
