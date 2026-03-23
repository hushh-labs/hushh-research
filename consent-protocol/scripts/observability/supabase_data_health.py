#!/usr/bin/env python3
"""Scheduled Supabase data-health checks for observability dashboards/alerts.

This script is designed for Cloud Scheduler + Cloud Run Jobs. It emits one
JSON log line containing aggregate metrics only (no raw identifiers/PII).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Allow direct execution without requiring external PYTHONPATH setup.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from db.connection import close_pool, get_pool  # noqa: E402

KEY_TABLES = (
    "consent_audit",
    "vault_keys",
    "pkm_data",
    "pkm_index",
    "kai_market_cache_entries",
    "tickers",
)


def _env() -> str:
    return str(os.getenv("ENVIRONMENT", "development")).strip().lower()


async def _fetch_table_columns(conn, table_name: str) -> set[str]:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        """,
        table_name,
    )
    return {str(row["column_name"]) for row in rows}


async def _safe_count(conn, table_name: str) -> int:
    value = await conn.fetchval(f'SELECT COUNT(*)::bigint FROM "{table_name}"')
    return int(value or 0)


async def _safe_fetchval(conn, query: str, *args: Any) -> int:
    value = await conn.fetchval(query, *args)
    return int(value or 0)


async def _table_counts(conn) -> dict[str, int]:
    results: dict[str, int] = {}
    for table in KEY_TABLES:
        try:
            results[table] = await _safe_count(conn, table)
        except Exception:
            results[table] = -1
    return results


async def _vault_method_coverage(conn) -> dict[str, int]:
    columns = await _fetch_table_columns(conn, "vault_keys")
    if "primary_method" not in columns:
        return {}

    rows = await conn.fetch(
        """
        SELECT primary_method, COUNT(*)::bigint AS row_count
        FROM vault_keys
        GROUP BY primary_method
        """
    )

    result: dict[str, int] = {}
    for row in rows:
        method = str(row.get("primary_method") or "unknown")
        result[method] = int(row.get("row_count") or 0)
    return result


async def _pkm_coherence(conn) -> dict[str, int]:
    data_users = await _safe_fetchval(
        conn,
        "SELECT COUNT(DISTINCT user_id)::bigint FROM pkm_data",
    )
    index_users = await _safe_fetchval(
        conn,
        "SELECT COUNT(DISTINCT user_id)::bigint FROM pkm_index",
    )
    data_without_index = await _safe_fetchval(
        conn,
        """
        SELECT COUNT(*)::bigint
        FROM (
          SELECT DISTINCT d.user_id
          FROM pkm_data d
          LEFT JOIN pkm_index i ON i.user_id = d.user_id
          WHERE i.user_id IS NULL
        ) AS missing
        """,
    )
    index_without_data = await _safe_fetchval(
        conn,
        """
        SELECT COUNT(*)::bigint
        FROM (
          SELECT DISTINCT i.user_id
          FROM pkm_index i
          LEFT JOIN pkm_data d ON d.user_id = i.user_id
          WHERE d.user_id IS NULL
        ) AS missing
        """,
    )

    return {
        "data_users": data_users,
        "index_users": index_users,
        "data_without_index": data_without_index,
        "index_without_data": index_without_data,
    }


async def _market_cache_freshness(conn) -> dict[str, int | float]:
    columns = await _fetch_table_columns(conn, "kai_market_cache_entries")
    timestamp_column = "updated_at" if "updated_at" in columns else None
    if not timestamp_column and "created_at" in columns:
        timestamp_column = "created_at"

    total_rows = await _safe_count(conn, "kai_market_cache_entries")
    if total_rows <= 0 or not timestamp_column:
        return {
            "total_rows": total_rows,
            "stale_rows_24h": 0,
            "stale_ratio": 0.0,
        }

    stale_rows = await _safe_fetchval(
        conn,
        f"SELECT COUNT(*)::bigint FROM kai_market_cache_entries WHERE {timestamp_column} < NOW() - INTERVAL '24 hours'",
    )

    ratio = 0.0 if total_rows == 0 else round(stale_rows / total_rows, 4)
    return {
        "total_rows": total_rows,
        "stale_rows_24h": stale_rows,
        "stale_ratio": ratio,
    }


async def _consent_audit_activity(conn) -> dict[str, int]:
    total_24h = await _safe_fetchval(
        conn,
        "SELECT COUNT(*)::bigint FROM consent_audit WHERE issued_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000",
    )
    requested_24h = await _safe_fetchval(
        conn,
        "SELECT COUNT(*)::bigint FROM consent_audit WHERE action = 'REQUESTED' AND issued_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000",
    )
    granted_24h = await _safe_fetchval(
        conn,
        "SELECT COUNT(*)::bigint FROM consent_audit WHERE action = 'CONSENT_GRANTED' AND issued_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000",
    )
    revoked_24h = await _safe_fetchval(
        conn,
        "SELECT COUNT(*)::bigint FROM consent_audit WHERE action = 'REVOKED' AND issued_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000",
    )

    return {
        "total_24h": total_24h,
        "requested_24h": requested_24h,
        "granted_24h": granted_24h,
        "revoked_24h": revoked_24h,
    }


async def run_checks() -> int:
    started = time.perf_counter()
    pool = await get_pool()
    anomalies: list[str] = []

    try:
        async with pool.acquire() as conn:
            table_counts = await _table_counts(conn)
            vault_coverage = await _vault_method_coverage(conn)
            pkm = await _pkm_coherence(conn)
            market_cache = await _market_cache_freshness(conn)
            consent_activity = await _consent_audit_activity(conn)

        if pkm["data_without_index"] > 0 or pkm["index_without_data"] > 0:
            anomalies.append("pkm_coherence_mismatch")

        stale_ratio = float(market_cache.get("stale_ratio", 0.0) or 0.0)
        if stale_ratio >= float(os.getenv("OBS_DATA_STALE_RATIO_THRESHOLD", "0.25")):
            anomalies.append("market_cache_stale_ratio_high")

        if table_counts.get("vault_keys", 0) < 0:
            anomalies.append("vault_table_unavailable")

        if consent_activity.get("total_24h", 0) < 0:
            anomalies.append("consent_audit_query_failed")

        duration_ms = round((time.perf_counter() - started) * 1000, 2)

        payload: dict[str, Any] = {
            "message": "data_health.summary",
            "env": _env(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
            "table_counts": table_counts,
            "vault_method_coverage": vault_coverage,
            "pkm": pkm,
            "market_cache": market_cache,
            "consent_activity": consent_activity,
            "anomalies": anomalies,
            "status": "error" if anomalies else "ok",
        }

        print(json.dumps(payload, separators=(",", ":")))
        return 1 if anomalies else 0
    finally:
        await close_pool()


def main() -> int:
    return asyncio.run(run_checks())


if __name__ == "__main__":
    raise SystemExit(main())
