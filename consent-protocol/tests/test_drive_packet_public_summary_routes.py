"""Public summary reads require Firebase; publication still requires vault authority."""

# ruff: noqa: F401,F811 -- canonical route admission fixture
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api.middleware import require_firebase_auth
from api.routes import drive_packet_public_summary as routes
from tests.test_drive_sharing_routes import REQUEST_ID, setup, unlock

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def test_public_summary_separates_authenticated_read_and_owner_write(setup, monkeypatch):
    client, app, _, current = setup
    app.include_router(routes.router)
    app.include_router(routes.people_router)
    service = SimpleNamespace(
        list_public_summaries=AsyncMock(return_value={"packets": [], "nextCursor": None}),
        set_public_summary=AsyncMock(
            return_value={
                "enabled": True,
                "revision": 1,
                "version": 0,
                "disclosure": "drive-packet-public-summary-v1",
            }
        ),
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    read = f"/api/one/people/{REQUEST_ID}/financial-packets"
    write = f"/api/connectors/google_drive/sharing/packets/{REQUEST_ID}/public-summary"
    assert client.get(read).status_code == 401
    app.dependency_overrides[require_firebase_auth] = lambda: "viewer"
    response = client.get(read)
    assert response.status_code == 200 and "no-store" in response.headers["Cache-Control"]
    service.list_public_summaries.assert_awaited_once_with(
        viewer_user_id="viewer", person_ref=REQUEST_ID, cursor=None
    )
    body = {
        "enabled": True,
        "version": 0,
        "expectedRevision": 0,
        "disclosure": "drive-packet-public-summary-v1",
    }
    assert client.put(write, json=body).status_code == 401
    unlock(app)
    assert client.put(write, json=body).status_code == 200
    service.set_public_summary.assert_awaited_once_with(
        user_id="recipient",
        packet_id=REQUEST_ID,
        enabled=True,
        version=0,
        expected_revision=0,
        disclosure=body["disclosure"],
    )
    for patch in (
        {"ownerUserId": "other"},
        {"version": True},
        {"enabled": "true"},
        {"disclosure": "drive-packet-listing-connections-v1"},
    ):
        assert client.put(write, json=body | patch).status_code == 422
    current.side_effect = HTTPException(401, "Expired")
    assert client.put(write, json=body).status_code == 401
    assert service.set_public_summary.await_count == 1


def test_summary_routes_are_metadata_not_private_content():
    from api.hub_route_classes import ROUTE_CLASSES, RouteClass

    assert (
        ROUTE_CLASSES[("GET", "/api/one/people/{person_ref}/financial-packets")]
        is RouteClass.NETWORK
    )
    assert (
        ROUTE_CLASSES[
            ("PUT", "/api/connectors/google_drive/sharing/packets/{packet_id}/public-summary")
        ]
        is RouteClass.AUTHORITY
    )


def test_owner_publication_receipts_require_vault_owner_and_are_control_metadata(
    setup, monkeypatch
):
    from api.hub_route_classes import ROUTE_CLASSES, RouteClass

    client, app, _, _ = setup
    app.include_router(routes.router)
    service = SimpleNamespace(
        list_publications=AsyncMock(return_value={"packets": [], "nextCursor": None})
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    path = "/api/connectors/google_drive/sharing/packet-publications"
    assert ROUTE_CLASSES[("GET", path)] is RouteClass.AUTHORITY
    assert client.get(path).status_code == 401
    unlock(app)
    response = client.get(path, params={"cursor": REQUEST_ID})
    assert response.status_code == 200 and "no-store" in response.headers["Cache-Control"]
    service.list_publications.assert_awaited_once_with(user_id="recipient", cursor=REQUEST_ID)
    assert client.get(path, params={"cursor": "bad"}).status_code == 422


def test_owner_summary_preference_requires_current_vault_owner_and_strict_cas(setup, monkeypatch):
    from api.hub_route_classes import ROUTE_CLASSES, RouteClass
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    client, app, _, current = setup
    app.include_router(routes.router)
    preference = {
        "enabled": True,
        "revision": 0,
        "disclosure": "drive-financial-summary-default-v1",
    }
    service = SimpleNamespace(
        get_preference=AsyncMock(return_value=preference),
        set_preference=AsyncMock(return_value=preference | {"enabled": False, "revision": 1}),
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    path = "/api/connectors/google_drive/sharing/financial-summary-preference"
    assert ROUTE_CLASSES[("GET", path)] is RouteClass.AUTHORITY
    assert ROUTE_CLASSES[("PUT", path)] is RouteClass.AUTHORITY
    body = {"enabled": False, "expectedRevision": 0, "disclosure": preference["disclosure"]}
    assert client.get(path).status_code == 401
    assert client.put(path, json=body).status_code == 401
    unlock(app)
    read = client.get(path)
    assert read.status_code == 200 and read.json() == preference
    assert "no-store" in read.headers["Cache-Control"]
    assert client.put(path, json=body).status_code == 200
    service.set_preference.assert_awaited_once_with(
        user_id="recipient", enabled=False, expected_revision=0, disclosure=preference["disclosure"]
    )
    for patch in (
        {"enabled": "false"},
        {"expectedRevision": True},
        {"packetId": REQUEST_ID},
        {"ownerUserId": "other"},
    ):
        assert client.put(path, json=body | patch).status_code == 422
    service.set_preference.side_effect = DriveReadError("listing_changed")
    assert client.put(path, json=body).status_code == 409
    current.side_effect = HTTPException(401, "Expired")
    assert client.put(path, json=body).status_code == 401
    assert service.set_preference.await_count == 2
