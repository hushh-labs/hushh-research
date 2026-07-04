# Tests for Task 4: API — thread `display` in and metadata out.
#
# The real serializer that builds AgentChatMessageModel from AgentChatMessage
# is named `_message_model` (not `_message_to_response` as the brief template
# suggests). We import it by its real name here.

from api.routes.kai.agent_chat import DelegateResultModel, _message_model
from hushh_mcp.services.agent_chat_service import AgentChatMessage


def test_delegate_result_accepts_display():
    m = DelegateResultModel(
        delegate_agent_id="agent_location",
        kind="selection",
        id="p1",
        display="Abdul Zalil",
    )
    assert m.display == "Abdul Zalil"


def test_history_response_exposes_ui_metadata_only():
    msg = AgentChatMessage(
        id="m1",
        conversation_id="c1",
        user_id="u1",
        role="user",
        status="complete",
        content="I selected: recipientUserId=x. Use exactly these ids.",
        model=None,
        created_at=None,
        completed_at=None,
        metadata={"kind": "selection", "display": "Abdul Zalil · 8 hours"},
    )
    out = _message_model(msg)
    assert out.metadata == {"kind": "selection", "display": "Abdul Zalil · 8 hours"}


def test_history_response_strips_server_only_metadata_keys():
    """Server-only keys must never be returned to the client."""
    msg = AgentChatMessage(
        id="m2",
        conversation_id="c2",
        user_id="u2",
        role="user",
        status="complete",
        content="I selected something.",
        model=None,
        created_at=None,
        completed_at=None,
        metadata={
            "kind": "selection",
            "display": "Bob · 2 hours",
            "server_secret": "should-not-appear",
            "internal_flag": True,
        },
    )
    out = _message_model(msg)
    assert out.metadata == {"kind": "selection", "display": "Bob · 2 hours"}
    assert "server_secret" not in (out.metadata or {})
    assert "internal_flag" not in (out.metadata or {})


def test_history_response_metadata_none_when_absent():
    """Messages without metadata must return metadata=None, not {}."""
    msg = AgentChatMessage(
        id="m3",
        conversation_id="c3",
        user_id="u3",
        role="assistant",
        status="complete",
        content="Hello!",
        model=None,
        created_at=None,
        completed_at=None,
        metadata=None,
    )
    out = _message_model(msg)
    assert out.metadata is None


def test_delegate_result_display_optional():
    """display must be optional — existing callers without it must not break."""
    m = DelegateResultModel(
        delegate_agent_id="agent_location",
        kind="selection",
        id="p2",
    )
    assert m.display is None
