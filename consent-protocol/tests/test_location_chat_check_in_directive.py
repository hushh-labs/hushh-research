from google.genai import types

from hushh_mcp.agents.location.tools import V2_LOCATION_TOOLS, propose_check_in
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import LocationChatService, _function_declarations_v2


def test_propose_check_in_registered():
    assert any(getattr(t, "_name", "") == "propose_check_in" for t in V2_LOCATION_TOOLS)
    names = {d.name for d in _function_declarations_v2(types)}
    assert "propose_check_in" in names


async def test_propose_check_in_returns_descriptor():
    with HushhContext(user_id="u", consent_token="t", vault_keys={}):  # noqa: S106
        out = await propose_check_in.__wrapped__(2.0, "on my way")
    assert out == {"proposed": "check_in", "durationHours": 2.0, "note": "on my way"}


def test_check_in_directive_and_action():
    d = LocationChatService._directive_from_tool(
        "propose_check_in", {"proposed": "check_in", "durationHours": 2.0, "note": "hi"}
    )
    assert d == {"type": "check_in", "durationHours": 2.0, "note": "hi"}
    svc = LocationChatService.__new__(LocationChatService)
    action = svc._build_client_action([d])
    assert (
        action["type"] == "check_in" and action["durationHours"] == 2.0 and action["note"] == "hi"
    )
