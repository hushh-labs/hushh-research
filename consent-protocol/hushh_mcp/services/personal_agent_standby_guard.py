"""Account deletion's view of a person's standby agent (STANDBY-SYNC.md E10).

A synced standby is an external resource exactly like the primary, so the account
deletion guard refuses while one exists, at the same point and under the same owner
locks. Nothing here deletes: a standby row holds ``ON DELETE RESTRICT`` references to
the registry row, so if one ever survived the guard the registry delete would fail and
roll the whole account erasure back.

The table exists only where dev-only migration 950 is applied; without it this reads
nothing, so the shared deletion path never requires the parked schema.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import text

STANDBY_TABLE = "personal_agent_standby_placements"

_STANDBY_LOCKED = text(
    "SELECT TRUE FROM personal_agent_standby_placements WHERE user_id = :user_id LIMIT 1 FOR UPDATE"
)


def standby_present(
    conn: Any, params: dict[str, Any], table_exists: Callable[[Any, str], bool]
) -> bool:
    """True when the person still has a standby row, read with ``FOR UPDATE``."""
    if not table_exists(conn, STANDBY_TABLE):
        return False
    return conn.execute(_STANDBY_LOCKED, params).first() is not None
