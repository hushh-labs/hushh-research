"""Taking back a location request you sent.

Reported from QA: "maine 2 logo se request location kiya, so status is showing
asked. should i allow do delete as well -- my concern is if i request location
to someone, amendment should be allowed??"

It was not. A sent request had exactly two ways out and the person who sent it
held neither: the owner approves, or the owner denies. Asking is a consent act,
so undoing it belongs to the person who made it.

The safety property under all of this: withdraw is keyed on the REQUESTER.
Approve and deny are keyed on the owner. Getting that backwards would let
anyone end a request somebody else sent.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location as one_location
from tests.services.test_one_location_agent_service import FourUserMemoryService

ROOT = Path(__file__).resolve().parents[1]


def _client(service, current_user: dict[str, str], monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(one_location.router)
    app.dependency_overrides[one_location.require_vault_owner_token] = lambda: {
        "user_id": current_user["user_id"]
    }
    monkeypatch.setattr(one_location, "_service", lambda: service)
    return TestClient(app, raise_server_exceptions=False)


def _asked(service: FourUserMemoryService, requester: str, owner: str) -> str:
    request = service.request_access(requester_user_id=requester, owner_user_id=owner)
    assert request["status"] == "pending"
    return request["id"]


# ---------------------------------------------------------------------------
# The act itself
# ---------------------------------------------------------------------------


def test_the_asker_can_take_their_own_request_back() -> None:
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")

    result = service.withdraw_request(requester_user_id="user_a", request_id=request_id)

    assert result["status"] == "cancelled"
    assert service.requests[request_id]["status"] == "cancelled"
    assert service.requests[request_id]["resolved_at"] is not None


def test_taking_one_back_leaves_the_other_alone() -> None:
    """The reported screen had two requests on it, not one."""
    service = FourUserMemoryService()
    to_b = _asked(service, "user_a", "user_b")
    to_c = _asked(service, "user_a", "user_c")

    service.withdraw_request(requester_user_id="user_a", request_id=to_b)

    assert service.requests[to_b]["status"] == "cancelled"
    assert service.requests[to_c]["status"] == "pending"


def test_it_cannot_reach_a_request_somebody_else_sent() -> None:
    """The whole safety property, stated as a test.

    user_c is not the asker. If this were keyed on the request id alone, or on
    the owner the way approve and deny are, any signed-in person could end
    anyone else's pending request.
    """
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")

    try:
        service.withdraw_request(requester_user_id="user_c", request_id=request_id)
        raise AssertionError("a stranger withdrew somebody else's request")
    except Exception as exc:  # OneLocationAgentError
        assert getattr(exc, "code", None) == "LOCATION_REQUEST_NOT_FOUND"

    assert service.requests[request_id]["status"] == "pending"


def test_the_statement_itself_is_keyed_on_the_asker() -> None:
    """The in-memory service re-implements the WHERE clause; it does not run it.

    So the tests above pass whatever the real SQL says, and a statement keyed
    on `owner_user_id` -- which would let the person being asked cancel the ask
    on the asker's behalf -- would slip straight through them. Verified against
    the statement that actually reaches Postgres, mutation-checked.
    """
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    seen: list[str] = []
    original = service._execute_one

    def capture(sql: str, params: dict | None = None):
        seen.append(sql)
        return original(sql, params)

    service._execute_one = capture  # type: ignore[method-assign]
    service.withdraw_request(requester_user_id="user_a", request_id=request_id)

    update = next(
        sql for sql in seen if "UPDATE one_location_access_requests" in sql and "'cancelled'" in sql
    )
    assert "AND requester_user_id = :requester_user_id" in update
    assert "owner_user_id" not in update, (
        "keyed on the owner, so the person being asked could cancel the ask"
    )
    # Only an unanswered request moves; an approved one already has a grant.
    assert "AND status = 'pending'" in update


def test_the_owner_cannot_withdraw_an_ask_made_of_them() -> None:
    """Refusing an ask you received is `deny_request`, a different verb.

    They settle on different statuses and notify different people, so routing
    one through the other would tell the asker the wrong story.
    """
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")

    try:
        service.withdraw_request(requester_user_id="user_b", request_id=request_id)
        raise AssertionError("the owner withdrew a request made of them")
    except Exception as exc:
        assert getattr(exc, "code", None) == "LOCATION_REQUEST_NOT_FOUND"

    assert service.requests[request_id]["status"] == "pending"


def test_an_already_answered_request_cannot_be_taken_back() -> None:
    """Approval already produced a grant.

    "Take back the ask" would not take the access back -- that is revoking the
    grant, a different act on a different object. Letting this succeed would
    show a cancelled request beside a live share.
    """
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    service.requests[request_id]["status"] = "approved"

    try:
        service.withdraw_request(requester_user_id="user_a", request_id=request_id)
        raise AssertionError("an approved request was withdrawn")
    except Exception as exc:
        assert getattr(exc, "code", None) == "LOCATION_REQUEST_NOT_FOUND"

    assert service.requests[request_id]["status"] == "approved"


def test_withdrawing_twice_is_not_a_silent_success() -> None:
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    service.withdraw_request(requester_user_id="user_a", request_id=request_id)

    try:
        service.withdraw_request(requester_user_id="user_a", request_id=request_id)
        raise AssertionError("a withdrawn request was withdrawn again")
    except Exception as exc:
        assert getattr(exc, "code", None) == "LOCATION_REQUEST_NOT_FOUND"


def test_asking_again_after_taking_it_back_works() -> None:
    """A withdrawal is not a block. Changing your mind twice is allowed."""
    service = FourUserMemoryService()
    first = _asked(service, "user_a", "user_b")
    service.withdraw_request(requester_user_id="user_a", request_id=first)

    second = service.request_access(requester_user_id="user_a", owner_user_id="user_b")

    assert second["status"] == "pending"
    assert second["id"] != first


# ---------------------------------------------------------------------------
# What it leaves behind
# ---------------------------------------------------------------------------


def test_the_withdrawal_is_recorded() -> None:
    """A consent act with no audit row is a consent act nobody can account for."""
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")

    service.withdraw_request(requester_user_id="user_a", request_id=request_id)

    written = [
        event
        for event in service.events.values()
        if event["event_type"] == "location_access_request_withdrawn"
    ]
    assert len(written) == 1
    assert written[0]["request_id"] == request_id
    assert written[0]["actor_user_id"] == "user_a"
    assert written[0]["owner_user_id"] == "user_b"


def test_the_owner_notification_replaces_the_original_ask() -> None:
    """Same tag as the request that created it.

    Leaving "X is asking to view your location" in the tray is how somebody
    taps through to approve a request that no longer exists.
    """
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    service.notifications.clear()

    service.withdraw_request(requester_user_id="user_a", request_id=request_id)

    sent = [
        note
        for note in service.notifications
        if note.get("notification_tag") == f"one-location-request:{request_id}"
    ]
    assert sent, "the owner was never told the ask was taken back"
    assert sent[0]["user_id"] == "user_b"
    assert sent[0]["body"] == "User A took back location request."


# ---------------------------------------------------------------------------
# Over the wire
# ---------------------------------------------------------------------------


def test_the_route_settles_the_request_as_cancelled(monkeypatch) -> None:
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    response = client.post(f"/api/one/location/requests/{request_id}/withdraw")

    assert response.status_code == 200
    assert response.json()["request"]["status"] == "cancelled"


def test_the_route_refuses_a_request_the_caller_did_not_send(monkeypatch) -> None:
    service = FourUserMemoryService()
    request_id = _asked(service, "user_a", "user_b")
    current_user = {"user_id": "user_c"}
    client = _client(service, current_user, monkeypatch)

    response = client.post(f"/api/one/location/requests/{request_id}/withdraw")

    assert response.status_code == 404
    assert service.requests[request_id]["status"] == "pending"


# ---------------------------------------------------------------------------
# The schema this depends on
# ---------------------------------------------------------------------------


def test_the_audit_event_is_allowed_where_it_has_to_be() -> None:
    """Both constraint declarations, not a new migration downstream of them.

    This was the first attempt at it, and it would have killed every UAT deploy
    after the first person used the feature. `_insert_event` swallows its own
    failures, so the row is written -- or silently is not -- without anybody
    noticing. Migration 064 then re-adds this constraint VALIDATING, and UAT
    replays the whole migration set on every deploy, so 064 fails on the row
    forever. It is the same outage `location_share_shortened` caused, recorded
    in `test_one_location_event_type_constraint.py`, which is the general guard
    this specific case answers to.
    """
    for filename in (
        "064_one_location_public_invites.sql",
        "068_one_location_circle_invites.sql",
    ):
        sql = (ROOT / "db" / "migrations" / filename).read_text(encoding="utf-8")
        assert "'location_access_request_withdrawn'" in sql, filename


def test_no_new_migration_was_needed() -> None:
    """'cancelled' has been a legal request status since migration 061.

    Stated as a test because the reverse -- a status the schema rejects -- is a
    500 at the moment somebody presses the button, and nothing earlier would
    have caught it.
    """
    sql = (ROOT / "db" / "migrations" / "061_one_location_agent.sql").read_text(encoding="utf-8")
    assert "CHECK (status IN ('pending', 'approved', 'denied', 'cancelled'))" in sql
