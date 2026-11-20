"""Transaction and row ports for Location Circle unit tests."""

from types import SimpleNamespace


class _Rows:
    def __init__(self, *rows: dict | None) -> None:
        self._rows = list(rows)

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    def fetchall(self):
        rows = list(self._rows)
        self._rows.clear()
        return rows

    def scalar(self):
        row = self.fetchone()
        return next(iter(row.values())) if isinstance(row, dict) else row


class _CapacityConnection:
    def __init__(self, *rows: dict | None) -> None:
        self.rows = list(rows)
        self.sql: list[str] = []
        self.params: list[dict] = []

    def execute(self, statement, params):
        sql = str(statement)
        if "pg_advisory_xact_lock_shared" in sql:
            return _Rows()
        self.sql.append(sql)
        self.params.append(dict(params))
        if "current_setting('hushh.circle_member_add_batch_id'" in sql:
            return _Rows({"setting": ""})
        if "set_config('hushh.circle_member_add_batch_id'" in sql:
            return _Rows({"setting": params["batch_id"]})
        if (
            "SELECT m.joined_at,c.name" in sql
            or "SELECT id FROM one_location_circles WHERE owner_user_id=:owner AND system_kind='sms'"
            in sql
        ):
            return _Rows()
        row = self.rows.pop(0) if self.rows else None
        return _Rows(*row) if isinstance(row, list) else _Rows(row)


class _Transaction:
    def __init__(self, conn: _CapacityConnection) -> None:
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, exc_type, exc, traceback):
        return False


class _TransactionDb:
    def __init__(self, conn: _CapacityConnection) -> None:
        self.engine = SimpleNamespace(begin=lambda: _Transaction(conn))
