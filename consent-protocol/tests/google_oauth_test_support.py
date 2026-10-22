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
        mapped = SimpleNamespace(first=lambda: rows[0] if rows else None, all=lambda: rows)
        return SimpleNamespace(
            first=mapped.first,
            mappings=lambda: mapped,
            scalar_one=lambda: (
                (rows[0][0] if isinstance(rows[0], (tuple, list)) else next(iter(rows[0].values())))
                if rows
                else 0
            ),
        )


def configure_gmail_oauth(monkeypatch, *, origin: str = "https://uat.one.hushh.ai"):
    redirect_uri = f"{origin}/one/profile/gmail/oauth/return"
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", origin)
    monkeypatch.setenv("GMAIL_OAUTH_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GMAIL_OAUTH_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("GMAIL_OAUTH_REDIRECT_URI", redirect_uri)
    return redirect_uri
