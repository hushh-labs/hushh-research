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
