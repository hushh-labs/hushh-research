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
