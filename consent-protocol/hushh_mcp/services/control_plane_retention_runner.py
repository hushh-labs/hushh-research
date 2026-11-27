# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Governed control-plane active TTL & bounded retention orchestrator.

Executes bounded, `FOR UPDATE SKIP LOCKED`, timeout-guarded retention sweeps
across the table families promoted to `"mode": "enforced"` in
`docs/architecture/runtime-db-data-plane-contract.json`:

1. `kai_gmail_receipts_provider_cache` (30d terminal sync runs, 7d preview artifacts)
2. `google_integrations_provider_state` (24h grace after 10m OAuth/Calendar/Attendance expiry + connector attempts)
3. `one_capability_runtime` (expired `one_capability_runs`, preserving finalized Location v2 setup receipts)
4. `direct_call_control` (expired call signaling + 24h terminal call/nonce compaction)
5. `one_product_activity_observations` (7d expired product activity observations & value receipts)

Operator entrypoint:
    python -m hushh_mcp.services.control_plane_retention_runner --limit 100 [--apply]

Invariants:
- Default mode is read-only (`apply=False`, `SET TRANSACTION READ ONLY`), reporting
  bounded candidate counts without mutating any row.
- Every SQL statement runs under short `statement_timeout` (`3000ms`) and
  `lock_timeout` (`1000ms`) with `FOR UPDATE SKIP LOCKED` so live owner traffic
  never blocks behind maintenance.
- Output contains aggregate counts and structural status markers only — never
  user IDs, emails, provider identifiers, ciphertext, or SQL exception bodies.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services import direct_call_retention
from hushh_mcp.services.capability_run_service import (
    MAX_CAPABILITY_RUN_RETENTION_PURGE,
    CapabilityRunStore,
)
from hushh_mcp.services.connector_attempt_retention import ConnectorAttemptRetention
from hushh_mcp.services.direct_call_policy import LEASE_SECONDS
from hushh_mcp.services.gmail_cache_retention import (
    GMAIL_PREVIEW_RETENTION_DAYS,
    GMAIL_TERMINAL_RUN_RETENTION_DAYS,
    maintain_gmail_cache,
)

MAX_CONTROL_PLANE_RETENTION_BATCH = 500
MAX_GMAIL_OWNER_SWEEP = 100
HANDLER_REPO_PATH = "consent-protocol/hushh_mcp/services/control_plane_retention_runner.py"


@dataclass(frozen=True)
class EnforcedRetentionSpec:
    family_id: str
    job_id: str
    retention_days: int


ENFORCED_RETENTION_FAMILIES: dict[str, EnforcedRetentionSpec] = {
    "kai_gmail_receipts_provider_cache": EnforcedRetentionSpec(
        family_id="kai_gmail_receipts_provider_cache",
        job_id="gmail_retention_report",
        retention_days=GMAIL_TERMINAL_RUN_RETENTION_DAYS,
    ),
    "google_integrations_provider_state": EnforcedRetentionSpec(
        family_id="google_integrations_provider_state",
        job_id="google_integrations_retention_report",
        retention_days=1,
    ),
    "one_capability_runtime": EnforcedRetentionSpec(
        family_id="one_capability_runtime",
        job_id="capability_runtime_retention_report",
        retention_days=1,
    ),
    "direct_call_control": EnforcedRetentionSpec(
        family_id="direct_call_control",
        job_id="direct_call_retention_sweep",
        retention_days=1,
    ),
    "one_product_activity_observations": EnforcedRetentionSpec(
        family_id="one_product_activity_observations",
        job_id="product_activity_retention_sweep",
        retention_days=7,
    ),
}


class ControlPlaneRetentionUnavailable(RuntimeError):
    """Sanitized failure carrying a closed status token only."""


def verify_enforced_contract_alignment(contract: dict[str, Any] | Path) -> bool:
    """Verify exact lockstep with `mode == 'enforced'` entries in the DB contract."""
    loaded = (
        json.loads(contract.read_text(encoding="utf-8")) if isinstance(contract, Path) else contract
    )
    enforced_entries = {
        str(entry["family_id"]): entry
        for entry in loaded.get("retention_registry", [])
        if entry.get("mode") == "enforced"
    }
    if set(enforced_entries) != set(ENFORCED_RETENTION_FAMILIES):
        return False
    for family_id, spec in ENFORCED_RETENTION_FAMILIES.items():
        entry = enforced_entries[family_id]
        if (
            entry.get("job_id") != spec.job_id
            or entry.get("retention_days") != spec.retention_days
            or entry.get("handler") != HANDLER_REPO_PATH
        ):
            return False
    return True


def _validate_positive_bound(value: Any, *, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{label} must be an integer between 1 and {maximum}")
    return value


def _configure_tx(conn: Any, *, read_only: bool) -> None:
    conn.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
    if read_only:
        conn.execute(text("SET TRANSACTION READ ONLY"))
    conn.execute(text("SET LOCAL statement_timeout = '3000ms'"))
    conn.execute(text("SET LOCAL lock_timeout = '1000ms'"))
    conn.execute(text("SET LOCAL idle_in_transaction_session_timeout = '15000ms'"))


def _table_exists(conn: Any, qualified_table: str) -> bool:
    return bool(
        conn.execute(
            text("SELECT to_regclass(:tbl) IS NOT NULL"), {"tbl": qualified_table}
        ).scalar_one()
    )


_GOOGLE_INTEGRATIONS_SWEEPS: tuple[tuple[str, str, str, str], ...] = (
    (
        "oauth_attempts",
        "public.google_oauth_attempts",
        """SELECT count(*) FROM (
             SELECT attempt_id FROM public.google_oauth_attempts
             WHERE expires_at < clock_timestamp() - interval '24 hours'
             ORDER BY expires_at, attempt_id LIMIT :limit
           ) AS observed""",
        """WITH candidates AS (
             SELECT attempt_id FROM public.google_oauth_attempts
             WHERE expires_at < clock_timestamp() - interval '24 hours'
             ORDER BY expires_at, attempt_id LIMIT :limit FOR UPDATE SKIP LOCKED
           ), deleted AS (
             DELETE FROM public.google_oauth_attempts AS target
             USING candidates WHERE target.attempt_id = candidates.attempt_id
             RETURNING 1
           ) SELECT count(*) FROM deleted""",
    ),
    (
        "calendar_proposals",
        "public.google_calendar_action_proposals",
        """SELECT count(*) FROM (
             SELECT proposal_id FROM public.google_calendar_action_proposals
             WHERE expires_at < clock_timestamp() - interval '24 hours'
                OR (status IN ('executed', 'failed', 'expired') AND expires_at <= clock_timestamp())
             ORDER BY expires_at, proposal_id LIMIT :limit
           ) AS observed""",
        """WITH candidates AS (
             SELECT proposal_id FROM public.google_calendar_action_proposals
             WHERE expires_at < clock_timestamp() - interval '24 hours'
                OR (status IN ('executed', 'failed', 'expired') AND expires_at <= clock_timestamp())
             ORDER BY expires_at, proposal_id LIMIT :limit FOR UPDATE SKIP LOCKED
           ), deleted AS (
             DELETE FROM public.google_calendar_action_proposals AS target
             USING candidates WHERE target.proposal_id = candidates.proposal_id
             RETURNING 1
           ) SELECT count(*) FROM deleted""",
    ),
    (
        "attendance_reviews",
        "public.calendar_attendance_reviews",
        """SELECT count(*) FROM (
             SELECT review_id FROM public.calendar_attendance_reviews
             WHERE expires_at < clock_timestamp() - interval '24 hours'
             ORDER BY expires_at, review_id LIMIT :limit
           ) AS observed""",
        """WITH candidates AS (
             SELECT review_id FROM public.calendar_attendance_reviews
             WHERE expires_at < clock_timestamp() - interval '24 hours'
             ORDER BY expires_at, review_id LIMIT :limit FOR UPDATE SKIP LOCKED
           ), deleted AS (
             DELETE FROM public.calendar_attendance_reviews AS target
             USING candidates WHERE target.review_id = candidates.review_id
             RETURNING 1
           ) SELECT count(*) FROM deleted""",
    ),
)

_GMAIL_EXPIRED_OWNERS_SQL = """
SELECT DISTINCT user_id FROM (
  (
    SELECT user_id FROM public.kai_gmail_sync_runs
    WHERE status IN ('completed', 'failed', 'canceled')
      AND COALESCE(completed_at, updated_at) <= CURRENT_TIMESTAMP - make_interval(days => :sync_days)
    LIMIT :owner_limit
  )
  UNION
  (
    SELECT user_id FROM public.kai_receipt_memory_artifacts
    WHERE created_at <= CURRENT_TIMESTAMP - make_interval(days => :preview_days)
    LIMIT :owner_limit
  )
) AS expired_owners
WHERE user_id IS NOT NULL AND btrim(user_id) <> ''
ORDER BY user_id
LIMIT :owner_limit
"""

_CAPABILITY_OBSERVE_SQL = """
SELECT count(*) FROM (
  SELECT run_id
  FROM public.one_capability_runs
  WHERE expires_at <= NOW()
    AND NOT (capability_id='workflow.setup.location' AND capability_version=2
      AND status='verified_succeeded' AND step_cursor='location.onboarding.complete'
      AND NULLIF(settlement_reference_hmac,'') IS NOT NULL)
  ORDER BY expires_at ASC, run_id ASC
  LIMIT :limit
) AS observed
"""

_DIRECT_CALLS_OBSERVE_SQL = """
SELECT count(*) FROM (
  SELECT id FROM public.direct_calls
  WHERE ((public.direct_call_expired(state,expires_at,caller_seen_at,callee_seen_at,clock_timestamp(),:lease)
          OR state IN ('declined','cancelled','ended','expired'))
         AND (state IN ('preparing','ringing','connecting','active') OR offers<>'[]'::jsonb OR caller_proof<>'{}'::jsonb))
     OR (created_at<clock_timestamp()-interval '24 hours' AND state IN ('declined','cancelled','ended','expired'))
  ORDER BY expires_at, id
  LIMIT :limit
) AS observed
"""

_DIRECT_CALL_COMMANDS_OBSERVE_SQL = """
SELECT count(*) FROM (
  SELECT nonce FROM public.direct_call_commands
  WHERE expires_at < clock_timestamp()
  ORDER BY expires_at LIMIT :limit
) AS observed
"""

_PRODUCT_ACTIVITY_SWEEPS: tuple[tuple[str, str, str, str], ...] = (
    (
        "value_receipts",
        "public.one_product_value_receipts",
        """SELECT count(*) FROM (
             SELECT effect_id FROM public.one_product_value_receipts
             WHERE expires_at < NOW() ORDER BY expires_at LIMIT :limit
           ) AS observed""",
        """DELETE FROM public.one_product_value_receipts
           WHERE (user_id, generation, agent_id, effect_id) IN (
             SELECT user_id, generation, agent_id, effect_id
             FROM public.one_product_value_receipts
             WHERE expires_at < NOW()
             ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED
           ) RETURNING effect_id""",
    ),
    (
        "observations",
        "public.one_product_activity_observations",
        """SELECT count(*) FROM (
             SELECT event_id FROM public.one_product_activity_observations
             WHERE expires_at < NOW() ORDER BY expires_at LIMIT :limit
           ) AS observed""",
        """DELETE FROM public.one_product_activity_observations
           WHERE event_id IN (
             SELECT event_id FROM public.one_product_activity_observations
             WHERE expires_at < NOW()
             ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED
           ) RETURNING event_id""",
    ),
)


def _sweep_gmail_cache(
    engine: Any, *, apply: bool, batch_limit: int, owner_limit: int
) -> dict[str, Any]:
    with engine.begin() as conn:
        _configure_tx(conn, read_only=True)
        has_sync = _table_exists(conn, "public.kai_gmail_sync_runs")
        has_preview = _table_exists(conn, "public.kai_receipt_memory_artifacts")
        if not (has_sync and has_preview):
            return {"status": "unavailable", "reason": "table_missing"}
        owner_rows = conn.execute(
            text(_GMAIL_EXPIRED_OWNERS_SQL),
            {
                "sync_days": GMAIL_TERMINAL_RUN_RETENTION_DAYS,
                "preview_days": GMAIL_PREVIEW_RETENTION_DAYS,
                "owner_limit": owner_limit,
            },
        ).fetchall()
    owner_ids = [str(row[0]) for row in owner_rows if row and str(row[0]).strip()]
    totals = {
        "status": "enforced" if apply else "observed",
        "owners_swept": len(owner_ids),
        "sync_runs_deleted": 0,
        "preview_artifacts_deleted": 0,
        "sync_runs_expired_observed": 0,
        "preview_artifacts_expired_observed": 0,
    }
    for uid in owner_ids:
        receipt = maintain_gmail_cache(
            engine,
            user_id=uid,
            apply=apply,
            batch_limit=batch_limit,
        )
        fams = receipt.get("families") or {}
        sync_res = fams.get("sync_runs") or {}
        prev_res = fams.get("preview_artifacts") or {}
        totals["sync_runs_deleted"] += int(sync_res.get("deleted") or 0)
        totals["preview_artifacts_deleted"] += int(prev_res.get("deleted") or 0)
        totals["sync_runs_expired_observed"] += int(sync_res.get("expired_rows_observed") or 0)
        totals["preview_artifacts_expired_observed"] += int(
            prev_res.get("expired_rows_observed") or 0
        )
    return totals


def _sweep_google_integrations_sql(engine: Any, *, apply: bool, batch_limit: int) -> dict[str, Any]:
    counts: dict[str, Any] = {"status": "enforced" if apply else "observed"}
    for key, table, observe_sql, delete_sql in _GOOGLE_INTEGRATIONS_SWEEPS:
        with engine.begin() as conn:
            _configure_tx(conn, read_only=not apply)
            if not _table_exists(conn, table):
                counts[key] = {"status": "unavailable"}
                continue
            sql = delete_sql if apply else observe_sql
            n = int(conn.execute(text(sql), {"limit": batch_limit}).scalar_one())
            counts[key] = {"deleted" if apply else "expired_observed": n}
    return counts


def _observe_capability_runs(engine: Any, *, limit: int) -> dict[str, Any]:
    with engine.begin() as conn:
        _configure_tx(conn, read_only=True)
        if not _table_exists(conn, "public.one_capability_runs"):
            return {"status": "unavailable", "reason": "table_missing"}
        n = int(conn.execute(text(_CAPABILITY_OBSERVE_SQL), {"limit": limit}).scalar_one())
        return {"status": "observed", "expired_observed": n}


def _observe_direct_calls(engine: Any, *, limit: int) -> dict[str, Any]:
    with engine.begin() as conn:
        _configure_tx(conn, read_only=True)
        if not (
            _table_exists(conn, "public.direct_calls")
            and _table_exists(conn, "public.direct_call_commands")
        ):
            return {"status": "unavailable", "reason": "table_missing"}
        calls_n = int(
            conn.execute(
                text(_DIRECT_CALLS_OBSERVE_SQL), {"limit": limit, "lease": LEASE_SECONDS}
            ).scalar_one()
        )
        cmds_n = int(
            conn.execute(text(_DIRECT_CALL_COMMANDS_OBSERVE_SQL), {"limit": limit}).scalar_one()
        )
        return {
            "status": "observed",
            "calls_expired_observed": calls_n,
            "commands_expired_observed": cmds_n,
        }


def _sweep_product_activity(engine: Any, *, apply: bool, batch_limit: int) -> dict[str, Any]:
    with engine.begin() as conn:
        _configure_tx(conn, read_only=not apply)
        if not _table_exists(conn, "public.one_product_activity_observations"):
            return {"status": "unavailable", "reason": "table_missing"}
        counts: dict[str, Any] = {"status": "enforced" if apply else "observed"}
        remaining_budget = batch_limit
        for key, table, observe_sql, delete_sql in _PRODUCT_ACTIVITY_SWEEPS:
            if not _table_exists(conn, table):
                counts[key] = 0
                continue
            step_limit = (
                max(1, batch_limit // 2) if key == "value_receipts" else max(1, remaining_budget)
            )
            if apply:
                rows = conn.execute(text(delete_sql), {"limit": step_limit}).fetchall()
                removed = len(rows)
                remaining_budget = max(1, remaining_budget - removed)
                counts[f"{key}_deleted"] = removed
            else:
                observed = int(conn.execute(text(observe_sql), {"limit": step_limit}).scalar_one())
                counts[f"{key}_expired_observed"] = observed
        return counts


async def run_enforced_control_plane_retention(
    *,
    db: Any | None = None,
    apply: bool = False,
    batch_limit: int = 100,
    owner_limit: int = 20,
) -> dict[str, Any]:
    """Execute one bounded retention pass across all enforced control-plane families."""
    bounded_batch = _validate_positive_bound(
        batch_limit, maximum=MAX_CONTROL_PLANE_RETENTION_BATCH, label="batch_limit"
    )
    bounded_owners = _validate_positive_bound(
        owner_limit, maximum=MAX_GMAIL_OWNER_SWEEP, label="owner_limit"
    )
    if not isinstance(apply, bool):
        raise ValueError("apply must be a boolean")

    target_db = db or get_db()
    engine = getattr(target_db, "engine", None)
    if engine is None or getattr(getattr(engine, "dialect", None), "name", None) != "postgresql":
        raise ControlPlaneRetentionUnavailable("control_plane_retention_requires_postgresql")

    try:
        gmail_summary = await asyncio.to_thread(
            _sweep_gmail_cache,
            engine,
            apply=apply,
            batch_limit=bounded_batch,
            owner_limit=bounded_owners,
        )

        google_summary = await asyncio.to_thread(
            _sweep_google_integrations_sql,
            engine,
            apply=apply,
            batch_limit=bounded_batch,
        )
        if apply:
            google_summary["connector_attempts"] = await ConnectorAttemptRetention(
                db=target_db
            ).purge_batch()

        cap_limit = min(bounded_batch, MAX_CAPABILITY_RUN_RETENTION_PURGE)
        if apply:

            def _purge_cap_runs() -> dict[str, Any]:
                with engine.begin() as conn:
                    _configure_tx(conn, read_only=False)
                    if not _table_exists(conn, "public.one_capability_runs"):
                        return {"status": "unavailable", "reason": "table_missing"}
                    # CapabilityRunStore.purge_expired accepts a synchronous SQLAlchemy connection
                    return {"status": "ready"}

            cap_ready = await asyncio.to_thread(_purge_cap_runs)
            if cap_ready["status"] == "ready":
                deleted_runs = await CapabilityRunStore(db=target_db).purge_expired(limit=cap_limit)
                capability_summary: dict[str, Any] = {
                    "status": "enforced",
                    "deleted": deleted_runs,
                }
            else:
                capability_summary = cap_ready
        else:
            capability_summary = await asyncio.to_thread(
                _observe_capability_runs, engine, limit=cap_limit
            )

        if apply:

            def _purge_calls() -> dict[str, Any]:
                with engine.begin() as conn:
                    _configure_tx(conn, read_only=True)
                    if not (
                        _table_exists(conn, "public.direct_calls")
                        and _table_exists(conn, "public.direct_call_commands")
                    ):
                        return {"status": "unavailable", "reason": "table_missing"}
                counts = direct_call_retention.purge_batch(db=target_db, limit=bounded_batch)
                return {"status": "enforced", **counts}

            calls_summary = await asyncio.to_thread(_purge_calls)
        else:
            calls_summary = await asyncio.to_thread(
                _observe_direct_calls, engine, limit=bounded_batch
            )

        activity_summary = await asyncio.to_thread(
            _sweep_product_activity,
            engine,
            apply=apply,
            batch_limit=bounded_batch,
        )
    except ControlPlaneRetentionUnavailable:
        raise
    except Exception:  # noqa: BLE001 - strip SQL/driver messages from operational output
        raise ControlPlaneRetentionUnavailable("control_plane_retention_execution_failed") from None

    return {
        "mode": "enforced" if apply else "report_only",
        "batch_limit": bounded_batch,
        "owner_limit": bounded_owners,
        "families": {
            "kai_gmail_receipts_provider_cache": gmail_summary,
            "google_integrations_provider_state": google_summary,
            "one_capability_runtime": capability_summary,
            "direct_call_control": calls_summary,
            "one_product_activity_observations": activity_summary,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run bounded control-plane TTL sweeps; emits aggregate counts only."
    )
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--owner-limit", type=int, default=20)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Execute physical deletes/compactions (default is read-only observation).",
    )
    args = parser.parse_args(argv)
    try:
        receipt = asyncio.run(
            run_enforced_control_plane_retention(
                apply=bool(args.apply),
                batch_limit=args.limit,
                owner_limit=args.owner_limit,
            )
        )
    except Exception:  # noqa: BLE001
        raise SystemExit(
            "Control-plane retention failed; inspect governed database health checks."
        ) from None
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
