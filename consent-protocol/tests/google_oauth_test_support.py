"""Transaction-shaped adapter for unit doubles, not rollback/locking proof.

The opt-in PostgreSQL suite exercises the real engine and service implementation.
"""

from contextlib import contextmanager
from types import SimpleNamespace


class TransactionEngine:
    def __init__(self, db):
        self.db = db

    @contextmanager
    def begin(self):
        yield self

    def execute(self, statement, params):
        sql = str(statement)
        result = self.db.execute_raw(sql, params)
        rows = result.data
        if "SELECT attempt_id FROM google_oauth_attempts" in sql:
            rows = [{"attempt_id": params["attempt_id"]}]
        mapped = SimpleNamespace(first=lambda: rows[0] if rows else None)
        return SimpleNamespace(
            first=mapped.first,
            mappings=lambda: mapped,
            scalar_one=lambda: (
                (rows[0][0] if isinstance(rows[0], (tuple, list)) else next(iter(rows[0].values())))
                if rows
                else 0
            ),
        )
