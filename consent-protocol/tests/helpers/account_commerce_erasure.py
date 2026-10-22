"""Commercial erasure port for existing SQL-inventory test doubles."""

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest


@contextmanager
def recording_connection(conn):
    # These legacy inventory doubles declare no answer or Hashcoin tables.
    # Keep production admission checks; model absent tables explicitly rather
    # than letting MagicMock's truthiness invent financial history. Real
    # financial refusal and rollback use the existing PostgreSQL fixtures.
    previous_effect = conn.execute.side_effect
    previous_result = conn.execute.return_value
    delegate = MagicMock(side_effect=previous_effect, return_value=previous_result)

    def execute(statement, *args, **kwargs):
        if isinstance(previous_effect, BaseException) or (
            isinstance(previous_effect, type) and issubclass(previous_effect, BaseException)
        ):
            raise previous_effect
        if str(statement) in {
            "SELECT to_regclass('pkm_answer_requests')",
            "SELECT to_regclass('hashcoin_wallets')",
        }:
            absent = MagicMock()
            absent.scalar.return_value = None
            return absent
        return delegate(statement, *args, **kwargs)

    conn.execute.side_effect = execute
    try:
        yield conn
    finally:
        conn.execute.side_effect = previous_effect


@pytest.fixture(autouse=True)
def commercial_erasure_port(monkeypatch):
    """Real journal/rollback behavior belongs to the PostgreSQL acceptance lane."""
    port = MagicMock()
    monkeypatch.setattr(
        "hushh_mcp.services.scope_commerce.sync_bridge.erase_account_in_transaction", port
    )
    return port
