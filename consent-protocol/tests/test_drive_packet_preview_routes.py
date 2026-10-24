"""Packet preview admission protects the existing vault-owner boundary."""

# ruff: noqa: F401,F811 -- reuse the existing route fixture
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api.routes import drive_packet_previews as routes
from tests.test_drive_sharing_routes import REQUEST_ID, setup, unlock

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def test_packet_preview_uses_only_current_owner_and_read_polling(setup, monkeypatch):
    client, app, _, current = setup
    app.include_router(routes.router)
    service = SimpleNamespace(
        preview=AsyncMock(return_value={"status": "queued"}),
        prepare_preview=AsyncMock(return_value={"status": "queued"}),
    )
    monkeypatch.setattr(routes, "_period_packet_service", lambda: service)
    path = f"/api/connectors/google_drive/sharing/packets/{REQUEST_ID}/preview"
    assert client.post(path, json={}).status_code == 401
    assert not service.prepare_preview.called
    unlock(app)
    assert client.post(path, json={}).status_code == 200
    service.prepare_preview.assert_awaited_once_with(
        user_id="recipient", packet_id=REQUEST_ID, refresh=False
    )
    response = client.get(path)
    assert response.status_code == 200 and "no-store" in response.headers["Cache-Control"]
    service.preview.assert_awaited_once_with(user_id="recipient", packet_id=REQUEST_ID, cursor=None)
    assert client.post(path, json={"ownerUserId": "other", "refresh": True}).status_code == 422
    assert client.post(path, json={"refresh": "true"}).status_code == 422
    current.side_effect = HTTPException(401, "Expired")
    assert client.get(path).status_code == 401
    assert service.preview.await_count == service.prepare_preview.await_count == 1
