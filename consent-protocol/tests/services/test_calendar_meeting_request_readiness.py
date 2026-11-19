"""Readiness before Send: a connection refusal is decided before, and again at, create.

The resolver's states are proven in ``test_calendar_meeting_organizer_resolution``.
This proves the request-path wiring: readiness is read-only and advisory, an
unconnected requester can never create a request, and the route helper maps
refusals the same way for both calls.
"""

from types import SimpleNamespace

import pytest

from api.routes.one import calendar_meeting_request_actions as actions
from hushh_mcp.services import calendar_meeting_request_service as service
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

SELECTION = {
    "account_id": "account-b",
    "calendar_id": "primary",
    "event_id": "event-1",
    "expected_grant": "g" * 64,
    "occurrence_id": "o" * 64,
    "date": "2026-10-31",
    "time_zone": "Asia/Kolkata",
}


class Response:
    def __init__(self):
        self.headers = {}


class Owner:
    def __init__(self, user_id, token):
        self.user_id, self.token, self.checks = user_id, token, 0

    async def require_current(self):
        self.checks += 1


@pytest.fixture
def bound(monkeypatch):
    calls = []

    async def fake_bound(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(grant_id="g"), SimpleNamespace(), {}, "organizer@example.test"

    monkeypatch.setattr(service, "bound_selection", fake_bound)
    return calls


async def test_readiness_uses_the_verified_organizer_and_the_selected_account(bound, monkeypatch):
    seen = []

    async def fake_readiness(user_id, email):
        seen.append((user_id, email))
        return "pending"

    monkeypatch.setattr(service, "_organizer_readiness", fake_readiness)
    assert await service.request_readiness(user_id="u1", **SELECTION) == {"state": "pending"}
    assert seen == [("u1", "organizer@example.test")]
    assert bound[0]["account_id"] == "account-b" and bound[0]["occurrence_id"] == "o" * 64


async def test_an_unconnected_requester_cannot_create_even_if_readiness_was_never_asked(
    bound, monkeypatch
):
    async def refuse(user_id, email):
        raise DriveSharingError(
            "calendar_organizer_unavailable", diagnostic_reason="organizer_unresolved"
        )

    created = []

    class Store:
        async def create_calendar_request(self, **kwargs):
            created.append(kwargs)

    async def allow():
        return None

    monkeypatch.setattr(service, "_connected_organizer", refuse)
    sharing = SimpleNamespace(store=Store(), _require_owner=allow)
    with pytest.raises(DriveSharingError) as caught:
        await service.CalendarMeetingRequestService(sharing=sharing).create(
            user_id="u1", requested_types=("recording",), **SELECTION
        )
    assert str(caught.value) == "calendar_organizer_unavailable"
    assert created == []


async def test_readiness_route_helper_is_private_and_owner_checked_around_the_read(
    bound, monkeypatch
):
    async def ready(user_id, email):
        return "ready"

    monkeypatch.setattr(service, "_organizer_readiness", ready)
    monkeypatch.setattr("api.routes.drive_sharing_owner.ContentOwner", Owner)
    response = Response()
    payload = SimpleNamespace(model_dump=lambda exclude=(): dict(SELECTION))
    result = await actions.request_readiness(
        payload, response, {"user_id": "u1", "token": "t"}, http_error=lambda exc: exc
    )
    assert result == {"state": "ready"}
    assert response.headers["Cache-Control"] == "private, no-store"


async def test_readiness_refusals_map_like_create_and_never_leak_the_cause(bound, monkeypatch):
    async def unreachable(user_id, email):
        raise DriveSharingError("recipient_verification_unavailable", retryable=True)

    monkeypatch.setattr(service, "_organizer_readiness", unreachable)
    monkeypatch.setattr("api.routes.drive_sharing_owner.ContentOwner", Owner)
    payload = SimpleNamespace(model_dump=lambda exclude=(): dict(SELECTION))
    with pytest.raises(Exception) as caught:
        await actions.request_readiness(
            payload, Response(), {"user_id": "u1", "token": "t"}, http_error=lambda exc: exc
        )
    http = caught.value
    assert http.status_code in {409, 503}
    assert http.detail["code"] == "recipient_verification_unavailable"
    assert "example.test" not in str(http.detail)
