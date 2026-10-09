"""Read optional pod placement without mistaking a failed store for absence.

Release-only installations may omit the parked pod tables. Only PostgreSQL's
undefined-table error AND an independent catalog read can establish that absence.
Provisioning and mutation callers keep the repositories' strict reads.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal, Protocol

from psycopg2.errors import UndefinedTable

from db.db_client import DatabaseExecutionError

PlacementTable = Literal["personal_agent_registry", "byoc_setup_jobs"]
_TABLES = frozenset({"personal_agent_registry", "byoc_setup_jobs"})
_PRESENT = "SELECT to_regclass(:relation) IS NOT NULL AS present"


class PlacementReader(Protocol):
    async def get(self, user_id: str) -> dict | None: ...

    def _db(self) -> Any: ...


async def read_placement_row(client: Any, table: PlacementTable, user_id: str) -> dict | None:
    """Strict owner-scoped repository read, with blocking I/O off the event loop."""
    if table not in _TABLES:
        raise ValueError("unsupported placement store")

    def read():
        return client.table(table).select("*").eq("user_id", user_id).limit(1).execute()

    response = await asyncio.to_thread(read)
    return dict(response.data[0]) if response.data else None


def _undefined_table(error: BaseException) -> bool:
    """Inspect typed driver evidence; never parse SQL, parameters or error text."""
    current: BaseException | None = error
    seen: set[int] = set()
    for _ in range(8):
        if current is None or id(current) in seen:
            return False
        seen.add(id(current))
        if isinstance(current, UndefinedTable):
            return True
        original = getattr(current, "orig", None)
        current = original if isinstance(original, BaseException) else current.__cause__
    return False


async def read_optional_placement(
    repo: PlacementReader, user_id: str, *, table: PlacementTable
) -> dict | None:
    """Return no placement only for a successful empty read or proven absent table.

    An existing table, unreadable catalog, missing column, or generic connectivity
    failure still raises. No cached absence can outlive creation of the pod store.
    """
    if table not in _TABLES:
        raise ValueError("unsupported placement store")
    try:
        return await repo.get(user_id)
    except DatabaseExecutionError as error:
        if error.table_name != table or error.operation != "select" or not _undefined_table(error):
            raise
        result = await asyncio.to_thread(
            repo._db().execute_raw, _PRESENT, {"relation": f"public.{table}"}
        )
        rows = result.data
        if (
            isinstance(rows, list)
            and len(rows) == 1
            and isinstance(rows[0], dict)
            and set(rows[0]) == {"present"}
            and rows[0]["present"] is False
        ):
            return None
        raise
