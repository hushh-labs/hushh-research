"""Read-only qualification phases for the managed Files runtime gate."""

from __future__ import annotations

from typing import Any


async def read_hosted_family_ready(
    repo: Any, *, qualification_sql: str, join_on_cancel: bool
) -> bool:
    try:
        from .managed_worker import database_thread

        await database_thread(
            repo._db().execute_raw, qualification_sql, {}, join_on_cancel=join_on_cancel
        )
    except Exception:
        return False
    return True
