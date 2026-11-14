# SPDX-FileCopyrightText: 2026 Hushh
# SPDX-License-Identifier: Apache-2.0
"""Shared database readiness probes and runtime pool helpers for control-plane routes."""

from __future__ import annotations

import asyncio
from typing import Any

from db.connection import get_pool

POD_FLEET_FAILED_STATUSES = ("provisioning_failed",)
POD_FLEET_STALE_PROVISIONING_SECONDS = 900

POD_FLEET_FAILED_COUNT_SQL = """
SELECT count(*)
  FROM personal_agent_registry
 WHERE status = ANY($1::text[])
    OR (status = 'provisioning'
        AND updated_at < now() - make_interval(secs => $2::double precision))
"""


async def get_shared_pool() -> Any:
    """Resolve the live shared database pool through db.connection."""
    from db.connection import get_pool as resolve_pool

    return await resolve_pool()


async def probe_database_ready(*, pool_getter: Any = None, timeout: float = 2.0) -> None:
    """Execute a bounded SELECT 1 readiness check against the shared pool."""
    getter = pool_getter or get_pool
    pool = await asyncio.wait_for(getter(), timeout=timeout)
    async with pool.acquire() as conn:
        await asyncio.wait_for(conn.fetchval("SELECT 1"), timeout=timeout)


async def count_failed_pods(*, pool_getter: Any = None, timeout: float = 2.0) -> int:
    """Count failed or stalled provisioning rows in personal_agent_registry."""
    getter = pool_getter or get_pool
    pool = await asyncio.wait_for(getter(), timeout=timeout)
    async with pool.acquire() as conn:
        raw = await asyncio.wait_for(
            conn.fetchval(
                POD_FLEET_FAILED_COUNT_SQL,
                list(POD_FLEET_FAILED_STATUSES),
                float(POD_FLEET_STALE_PROVISIONING_SECONDS),
            ),
            timeout=timeout,
        )
    return int(raw or 0)
