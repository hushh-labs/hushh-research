#!/usr/bin/env python3
"""Emit a read-only, redacted consent-audit report for UAT investigation."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.connection import DatabaseUnavailableError, close_pool, get_pool  # noqa: E402


def _redact_identifier(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return "unknown"
    return f"{text[:4]}…{text[-4:]}" if len(text) > 8 else "redacted"


async def _report(hours: int, app_name: str | None, user_prefix: str | None) -> dict[str, Any]:
    pool = await get_pool()
    where = ["issued_at >= EXTRACT(EPOCH FROM NOW() - make_interval(hours => $1)) * 1000"]
    params: list[Any] = [hours]
    if app_name:
        params.append(app_name)
        where.append(
            "LOWER(COALESCE(metadata->>'developer_app_display_name', '')) = LOWER($%d)"
            % len(params)
        )
    if user_prefix:
        params.append(f"{user_prefix}%")
        where.append("user_id LIKE $%d" % len(params))
    predicate = " AND ".join(where)
    query = f"""
      SELECT
        COALESCE(NULLIF(metadata->>'transport', ''), NULLIF(metadata->>'request_source', ''), 'unknown') AS transport,
        scope,
        action AS outcome,
        COALESCE(NULLIF(metadata->>'error_code', ''), NULLIF(metadata->>'reason', ''), 'none') AS failure_class,
        user_id,
        COUNT(*)::bigint AS event_count
      FROM consent_audit
      WHERE {predicate}
      GROUP BY transport, scope, outcome, failure_class, user_id
      ORDER BY event_count DESC, transport, scope, outcome
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)
    grouped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row["transport"]),
            str(row["scope"]),
            str(row["outcome"]),
            str(row["failure_class"]),
        )
        item = grouped.setdefault(
            key,
            {
                "transport": key[0],
                "scope": key[1],
                "outcome": key[2],
                "failure_class": key[3],
                "events": 0,
                "users": set(),
            },
        )
        item["events"] += int(row["event_count"] or 0)
        item["users"].add(_redact_identifier(row["user_id"]))
    entries = []
    for item in grouped.values():
        entries.append({**item, "users": sorted(item["users"]), "user_count": len(item["users"])})
    entries.sort(key=lambda item: (-item["events"], item["transport"], item["scope"]))
    return {
        "window_hours": hours,
        "filters": {
            "app_name": app_name or None,
            "user_prefix": _redact_identifier(user_prefix) if user_prefix else None,
        },
        "redaction": "User identifiers are truncated; tokens, emails, requests, metadata payloads, and PKM data are excluded.",
        "groups": entries,
    }


async def _main_async(args: argparse.Namespace) -> int:
    try:
        report = await _report(args.hours, args.app_name, args.user_prefix)
        print(json.dumps(report, indent=2))
    except DatabaseUnavailableError as exc:
        print(
            json.dumps(
                {
                    "status": "database_unavailable",
                    "message": "Could not query the read-only UAT consent report.",
                    "hint": exc.hint or "Start the approved UAT database tunnel and retry.",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    finally:
        await close_pool()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=48, choices=range(1, 24 * 31 + 1))
    parser.add_argument("--app-name", default=None)
    parser.add_argument("--user-prefix", default=None)
    args = parser.parse_args()
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
