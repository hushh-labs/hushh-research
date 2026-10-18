"""Owner-only possible-matches routes: vault-gated, private, queue-only (D3)."""

# ruff: noqa: F401, F811 -- the shared route fixture is imported from its owner

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock

from api.routes import drive_possible_matches as routes
from hushh_mcp.services import drive_possible_matches as store_module
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from tests.test_drive_sharing_routes import BASE, REQUEST_ID, setup, unlock

JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def _install(client_setup, monkeypatch):
    client, app, _, current = client_setup
    app.include_router(routes.router)
    store = SimpleNamespace(
        possible_matches=AsyncMock(
            return_value={"requestId": REQUEST_ID, "canSend": True, "count": 0, "matches": []}
        ),
        send=AsyncMock(
            return_value={
                "requestId": REQUEST_ID,
                "queued": 1,
                "matches": [{"matchRef": f"{JOB}:3", "status": "queued"}],
            }
        ),
    )
    monkeypatch.setattr(routes, "_service", lambda: SimpleNamespace(store=SimpleNamespace(db=None)))
    monkeypatch.setattr(routes, "DrivePossibleMatchesStore", lambda db: store)
    return client, app, store, current


def test_possible_matches_routes_are_owner_bound_private_and_vault_gated(setup, monkeypatch):
    client, app, store, current = _install(setup, monkeypatch)
    base = f"{BASE}/{REQUEST_ID}/possible-matches"
    ref = f"{JOB}:3"

    # A locked vault reaches nothing.
    assert client.get(base).status_code == 401
    assert client.post(base + "/send", json={"matchRefs": [ref]}).status_code == 401
    assert not store.possible_matches.called and not store.send.called

    unlock(app)
    response = client.get(base)
    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    store.possible_matches.assert_awaited_once_with(user_id="recipient", request_id=REQUEST_ID)

    # Send only queues durable work: 202, bound to the authenticated owner.
    response = client.post(base + "/send", json={"matchRefs": [ref]})
    assert response.status_code == 202
    assert "no-store" in response.headers["Cache-Control"]
    store.send.assert_awaited_once_with(
        user_id="recipient", request_id=REQUEST_ID, match_refs=[ref]
    )

    # A caller can never name the owner, the requester or a free-form ref.
    for body in (
        {"matchRefs": ["../other"]},
        {"matchRefs": [ref], "userId": "owner"},
        {"matchRefs": [ref], "recipientUserId": "recipient"},
        {"matchRefs": []},
        {"matchRefs": [f"{ref}0" * 10]},
        {"matchRefs": [ref] * 101},
        {},
    ):
        assert client.post(base + "/send", json=body).status_code == 422
    assert store.send.await_count == 1

    # The requester, or anyone else, gets the same answer as a missing request.
    store.possible_matches.side_effect = DriveSharingError("request_unavailable")
    response = client.get(base)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "request_unavailable"
    store.send.side_effect = DriveSharingError("request_unavailable")
    assert client.post(base + "/send", json={"matchRefs": [ref]}).status_code == 404

    # A finished request and internal failures map to closed, safe codes.
    store.send.side_effect = DriveSharingError("request_changed")
    response = client.post(base + "/send", json={"matchRefs": [ref]})
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "request_changed")
    store.send.side_effect = RuntimeError("provider body with a file name.pdf")
    response = client.post(base + "/send", json={"matchRefs": [ref]})
    assert response.status_code == 503
    assert "file name" not in response.text

    # An expired vault after the store call returns 401 and nothing is cached.
    from fastapi import HTTPException

    store.possible_matches.side_effect = None
    current.side_effect = HTTPException(401, "Expired")
    assert client.get(base).status_code == 401


def test_send_never_wakes_or_calls_drive_from_the_api_process():
    # The kill switch stays authoritative: Send writes a marker and makes the
    # request due for the scheduled drain. No wake, transport or adapter here.
    source = inspect.getsource(store_module) + inspect.getsource(routes)
    for forbidden in (
        "wake_drive_work",
        "GoogleDriveRestTransport",
        "google_drive_permission_adapter",
        "drive_permission_executor",
        "read_tool",
        "logger",
        "logging",
    ):
        assert forbidden not in source, forbidden
