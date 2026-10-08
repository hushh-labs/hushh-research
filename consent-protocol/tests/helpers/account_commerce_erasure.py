"""Commercial erasure port for existing SQL-inventory test doubles."""

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest


@contextmanager
def recording_connection(conn):
    yield conn


@pytest.fixture(autouse=True)
def commercial_erasure_port(monkeypatch):
    """Real journal/rollback behavior belongs to the PostgreSQL acceptance lane."""
    port = MagicMock()
    monkeypatch.setattr(
        "hushh_mcp.services.scope_commerce.sync_bridge.erase_account_in_transaction", port
    )
    return port
