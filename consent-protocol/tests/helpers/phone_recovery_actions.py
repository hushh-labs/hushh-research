"""Owner-scoped transactional state port for device-action boundary tests."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from asyncpg import UniqueViolationError

from hushh_mcp.services import device_action_service as actions

PHONE = "+16505550101"
DEVICE = "tdv_" + "a" * 24
CURRENT = {
    "phone": PHONE,
    "phone_digest": "hmac-sha256:" + "1" * 64,
    "binding_revision": 3,
    "generation": 0,
}


class ActionDatabase:
    def __init__(self):
        self.rows = {}
        self.events = set()

    def operation(self, owner="previous", **changes):
        row = {
            "operation_id": uuid4(),
            "user_id": owner,
            "device_id": DEVICE,
            "state": "prepared",
            "continuation_id": None,
            "live": True,
            "created_at": datetime.now(timezone.utc),
            "pod_binding_version": None,
            **{key: CURRENT[key] for key in ("phone_digest", "binding_revision", "generation")},
            **changes,
        }
        self.rows[str(row["operation_id"])] = row
        return str(row["operation_id"])

    async def fetchrow(self, query, operation, owner, *args):
        row = self.rows.get(operation)
        return dict(row) if row and row["user_id"] == owner else None

    async def fetchval(self, query, *args):
        return True

    async def fetch(self, query, owner):
        return [dict(row) for row in self.rows.values() if row["user_id"] == owner]

    async def execute(self, query, operation, value=None):
        row = self.rows[operation]
        if "proof_event_digest=$2" in query:
            if value in self.events:
                raise UniqueViolationError("consumed event")
            self.events.add(value)
            row.update(state="pending", proof_event_digest=value)
        elif "state='completed'" in query:
            if "AND state IN" not in query or row["state"] in {"pending", "action_required"}:
                row.update(state="completed", pod_binding_version=value)
        elif "state='action_required'" in query:
            if "AND state='pending'" not in query or row["state"] == "pending":
                row["state"] = "action_required"
        elif "state='cancelled'" in query:
            row["state"] = "cancelled"


@pytest.fixture
def action_database(monkeypatch):
    database = ActionDatabase()
    lock = asyncio.Lock()

    @asynccontextmanager
    async def transaction():
        async with lock:
            yield database

    monkeypatch.setattr(actions, "transaction", transaction)
    monkeypatch.setattr(actions, "binding", AsyncMock(return_value=dict(CURRENT)))
    monkeypatch.setattr(actions, "require_producer_enabled", lambda: None)
    return database
