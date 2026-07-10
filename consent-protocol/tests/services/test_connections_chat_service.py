import asyncio
from unittest.mock import MagicMock

from hushh_mcp.services.connections_chat_service import ConnectionsChatService


def test_add_intent_sends_request():
    fake = MagicMock()
    fake.create_request.return_value = {"status": "pending"}
    svc = ConnectionsChatService(service=fake)
    out = asyncio.run(
        svc.handle_turn(user_id="user-a", message="add Priya to my trusted connections")
    )
    fake.create_request.assert_called_once()
    _, kwargs = fake.create_request.call_args
    assert kwargs.get("query") == "Priya"
    assert "request" in out["response"].lower()
    assert out["stateChanged"] is True


def _svc_with_mock():
    fake = MagicMock()
    return ConnectionsChatService(service=fake), fake


def test_complete_action_send_request_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}],
        "display": "Priya Rao",
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.create_request.assert_called_once_with("u1", addressee_user_id="u2")
    assert out["stateChanged"] is True
    assert "Priya Rao" in out["response"]


def test_complete_action_accept_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "accept", "requestId": "r1", "label": "Sam Lee"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.accept_request.assert_called_once_with("u1", "r1")
    assert out["stateChanged"] is True
    assert "Sam Lee" in out["response"]


def test_complete_action_reject_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "reject", "requestId": "r2", "label": "Sam Lee"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.reject_request.assert_called_once_with("u1", "r2")
    assert out["stateChanged"] is True


def test_complete_action_remove_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "remove", "connectionId": "cx", "label": "Alex T"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.remove_connection.assert_called_once_with("u1", "cx")
    assert out["stateChanged"] is True
    assert "Alex T" in out["response"]


def test_complete_action_cancelled_is_noop():
    svc, fake = _svc_with_mock()
    out = svc._complete_action("u1", {"status": "cancelled", "selected": []}, "c1")
    fake.create_request.assert_not_called()
    fake.accept_request.assert_not_called()
    assert out["stateChanged"] is False


def test_complete_action_service_error_is_surfaced():
    from hushh_mcp.services.connections_service import ConnectionsError

    svc, fake = _svc_with_mock()
    fake.accept_request.side_effect = ConnectionsError("X", "Request is no longer pending.")
    sel = {"status": "answered", "selected": [{"op": "accept", "requestId": "r9", "label": "Sam"}]}
    out = svc._complete_action("u1", sel, "c1")
    assert out["response"] == "Request is no longer pending."
    assert out["stateChanged"] is False
