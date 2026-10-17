"""Join SQLAlchemy erasure transactions to the canonical accounting service.

Call synchronously in the owning transaction thread, including an async caller.
Only the supplied connection
is used: no pool, provider I/O or independent commit. Money logic stays in the
same ScopeCommerceService.erase_account implementation used by async callers.
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import text


class _TransactionConnection:
    def __init__(self, connection):
        self.connection = connection

    @staticmethod
    def _statement(sql, args):
        statement = re.sub(r"\$(\d+)", lambda m: f"(:commerce_arg_{m[1]})", sql)
        values = {
            f"commerce_arg_{i + 1}": str(v) if isinstance(v, UUID) else v
            for i, v in enumerate(args)
        }
        return text(statement), values

    async def execute(self, sql, *args):
        statement, values = self._statement(sql, args)
        return self.connection.execute(statement, values)

    async def executemany(self, sql, args):
        rows = list(args)
        if rows:
            statement, _ = self._statement(sql, rows[0])
            return self.connection.execute(
                statement, [self._statement(sql, row)[1] for row in rows]
            )

    async def fetchrow(self, sql, *args):
        result = await self.execute(sql, *args)
        row = result.mappings().first()
        return dict(row) if row is not None else None

    async def fetch(self, sql, *args):
        result = await self.execute(sql, *args)
        return [dict(row) for row in result.mappings().all()]

    async def fetchval(self, sql, *args):
        result = await self.execute(sql, *args)
        return result.scalar()


def erase_account_in_transaction(connection, user_id, *, permanent=True):
    if not connection.in_transaction():
        raise ValueError("account erasure requires an existing transaction")
    from .service import ScopeCommerceService

    # This adapter's async methods execute synchronously on the supplied SQL
    # transaction. Drive that bounded coroutine in the caller's thread, also
    # when account_service already has a running event loop. Never start an
    # independent pool, thread, loop, or commit. A newly introduced real await
    # fails closed so the caller can roll back its outer transaction.
    operation = ScopeCommerceService().erase_account(
        user_id, permanent=permanent, conn=_TransactionConnection(connection)
    )
    try:
        operation.send(None)
    except StopIteration as completed:
        return completed.value
    else:
        operation.close()
        raise RuntimeError("financial erasure sync adapter yielded external I/O")
