# SPDX-FileCopyrightText: 2026 Hushh
# SPDX-License-Identifier: Apache-2.0
"""Shared Postgres nonce registry for single-use relay tickets."""

from __future__ import annotations

from datetime import datetime, timezone


async def register_relay_ticket_nonce(nonce: str, expires_at: int) -> bool:
    """Register a nonce in the shared Postgres registry; False on replay or outage.

    Shared-tier failure refuses consumption so per-process state cannot admit a
    replay on another worker.
    """
    try:
        from db.connection import get_pool

        pool = await get_pool()
        now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
        async with pool.acquire() as conn:
            result = str(
                await conn.execute(
                    "INSERT INTO relay_ticket_nonces (nonce, expires_at) "
                    "VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING",
                    nonce,
                    expires_at,
                )
            )
            # Opportunistic prune keeps the table tiny (60s ticket TTL).
            await conn.execute(
                "DELETE FROM relay_ticket_nonces WHERE expires_at <= $1",
                now_epoch,
            )
        return result.endswith("1")
    except Exception:  # noqa: BLE001 - unavailable authority never admits a ticket
        return False
