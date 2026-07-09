from google.genai import types

from hushh_mcp.agents.location.tools import (
    V2_LOCATION_TOOLS,
    request_device_location_permission,
)
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import (
    LocationChatService,
    _function_declarations_v2,
)


def test_request_device_location_permission_registered():
    assert any(
        getattr(t, "_name", "") == "request_device_location_permission" for t in V2_LOCATION_TOOLS
    )
    names = {d.name for d in _function_declarations_v2(types)}
    assert "request_device_location_permission" in names


async def test_request_device_location_permission_returns_descriptor():
    with HushhContext(user_id="u", consent_token="t", vault_keys={}):  # noqa: S106
        out = await request_device_location_permission.__wrapped__()
    assert out == {"proposed": "request_device_location_permission"}


def test_permission_directive_and_action():
    d = LocationChatService._directive_from_tool(
        "request_device_location_permission",
        {"proposed": "request_device_location_permission"},
    )
    assert d == {"type": "request_device_location_permission"}
    svc = LocationChatService.__new__(LocationChatService)
    action = svc._build_client_action([d])
    assert action["type"] == "request_device_location_permission"
    assert action["summary"]


async def test_permission_action_result_completed_and_cancelled():
    svc = LocationChatService.__new__(LocationChatService)

    class _FakeStore:
        async def add_message(self, **kwargs):
            return None

    svc._chat_store = _FakeStore()

    completed = await svc._handle_action_result(
        user_id="u",
        conversation_id="c1",
        action_result={"type": "request_device_location_permission", "status": "completed"},
    )
    assert "on now" in completed["response"]
    assert completed["isComplete"] is True

    cancelled = await svc._handle_action_result(
        user_id="u",
        conversation_id="c1",
        action_result={"type": "request_device_location_permission", "status": "cancelled"},
    )
    assert "still off" in cancelled["response"]
