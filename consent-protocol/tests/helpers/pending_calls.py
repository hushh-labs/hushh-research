"""Test-only stand-in for the shared pending-call table.

Production keeps pending connector reviews in Postgres so every backend instance
can finish a review another one issued. These tests have no database, so the
fixture answers the module's two statements from a dict that outlives every
"instance" (the request-secret map) and seals with a static chat key.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.one_adk import mcp_pending_call
from tests.helpers.chat_keys import static_chat_cipher


class FakePendingCallTable:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def execute_raw(self, sql: str, params: dict):
        if "INSERT INTO one_mcp_pending_calls" in sql:
            now = self._now()
            for key, row in list(self.rows.items()):
                if row["user_id"] == params["user"] and row["expires_at"] <= now:
                    del self.rows[key]
            self.rows[(params["user"], params["handle"])] = {
                "user_id": params["user"],
                "session_id": params["session"],
                "payload_ciphertext": params["ciphertext"],
                "payload_iv": params["iv"],
                "payload_tag": params["tag"],
                "expires_at": datetime.fromisoformat(params["expires"]),
            }
            return SimpleNamespace(data=[])
        if "FROM one_mcp_pending_calls" in sql:
            row = self.rows.get((params["user"], params["handle"]))
            if (
                row is None
                or row["session_id"] != params["session"]
                or row["expires_at"] <= self._now()
            ):
                return SimpleNamespace(data=[])
            return SimpleNamespace(
                data=[{key: value for key, value in row.items() if key.startswith("payload_")}]
            )
        raise AssertionError(f"unexpected statement: {sql}")


def install_fake_pending_store(monkeypatch: pytest.MonkeyPatch) -> FakePendingCallTable:
    """Backs the ``shared_pending_store`` fixture in ``tests/conftest.py``."""
    table = FakePendingCallTable()
    monkeypatch.setattr(
        mcp_pending_call, "get_db", lambda: SimpleNamespace(execute_raw=table.execute_raw)
    )
    monkeypatch.setattr(mcp_pending_call, "ChatCipher", static_chat_cipher)
    return table
