"""Owner-bound Location API test client; service behavior stays in its port."""

from typing import Any
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location as one_location
from hushh_mcp.services.command_checkpoints import CommandCheckpointStore


class _MemoryNearbyPresenceService:
    def purge_terminal(self, *, older_than_hours: float) -> dict[str, int]:
        assert older_than_hours > 0
        return {"expired": 0, "deleted": 0}


def _client(service: Any, current_user: dict[str, str], monkeypatch) -> TestClient:
    app = FastAPI()
    app.state.command_purge = AsyncMock()
    monkeypatch.setattr(CommandCheckpointStore, "purge_expired", app.state.command_purge)
    app.include_router(one_location.router)
    app.dependency_overrides[one_location.require_vault_owner_token] = lambda: {
        "user_id": current_user["user_id"]
    }
    monkeypatch.setattr(one_location, "_service", lambda: service)
    monkeypatch.setattr(
        one_location,
        "_nearby_presence_service",
        _MemoryNearbyPresenceService,
    )
    return TestClient(app, raise_server_exceptions=False)
