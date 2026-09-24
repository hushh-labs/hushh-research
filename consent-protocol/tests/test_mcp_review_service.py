"""Browser review prepares authority; only the native Chat tool executes."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.sessions import InMemorySessionService, Session

from hushh_mcp.one_adk import mcp_review_service as module
from hushh_mcp.one_adk import mcp_turn_scope
from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding, ResolvedMcpConnection
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.external_mcp_client import ExternalMcpError


@pytest.fixture
def harness(monkeypatch):
    binding = McpConnectionBinding("owner", "custom", 1, 1, "https://example.com/mcp")
    registry = SimpleNamespace(
        get_connector=AsyncMock(return_value=SimpleNamespace(owner_user_id="owner"))
    )
    sessions = InMemorySessionService()
    sessions.get_session = AsyncMock(
        return_value=Session(
            id="thread",
            app_name="hussh_one",
            user_id="owner",
            state={"private": "never-forward-this"},
        )
    )
    resolver = AsyncMock(
        return_value=ResolvedMcpConnection(binding, {"Authorization": "synthetic"})
    )
    tool = SimpleNamespace(
        name="mcp_" + "a" * 40,
        descriptor={
            "name": "search",
            "inputSchema": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"],
                "additionalProperties": False,
            },
        },
        revision="rev1",
        run_async=AsyncMock(),
    )
    created = []

    def factory(**kwargs):
        toolset = SimpleNamespace(
            **kwargs, get_tools=AsyncMock(return_value=[tool]), close=AsyncMock()
        )
        tool.toolset = toolset
        created.append(toolset)
        return toolset

    issued = SimpleNamespace(directive_id="dir_" + "b" * 32, expires_at=datetime.now(UTC))
    ledger = SimpleNamespace(
        issue=AsyncMock(return_value=issued),
        confirm=AsyncMock(
            return_value=SimpleNamespace(receipt="synthetic-receipt", expires_at=issued.expires_at)
        ),
    )
    monkeypatch.setattr(module, "get_external_connector_registry_service", lambda: registry)
    monkeypatch.setattr(module, "EncryptedAdkSessionService", lambda: sessions)
    monkeypatch.setattr(module, "ActionDirectiveStore", lambda: ledger)
    monkeypatch.setattr(mcp_turn_scope, "resolve_registered_connection", resolver)
    monkeypatch.setattr(mcp_turn_scope, "GovernedMcpToolset", factory)
    request = dict(
        token={"user_id": "owner", "token": "synthetic-token"},
        connector_id="custom",
        conversation_id="thread",
        tool_name=tool.name,
        arguments={"q": "synthetic query"},
    )
    return SimpleNamespace(
        registry=registry,
        sessions=sessions,
        resolver=resolver,
        tool=tool,
        ledger=ledger,
        created=created,
        request=request,
    )


async def test_review_and_confirmation_use_current_terms_without_executing(harness):
    h = harness
    preview = await module.prepare_review(**h.request)
    assert preview["arguments"] == h.request["arguments"]
    assert preview["status"] == "review_required"
    assert "synthetic-token" not in str(preview)
    h.registry.get_connector.assert_awaited_once_with("custom", user_id="owner")
    h.sessions.get_session.assert_awaited_once_with(
        app_name="hussh_one", user_id="owner", session_id="thread"
    )
    context = h.resolver.await_args.args[0]
    assert context.user_id == "owner"
    assert context.state.get("private") is None
    assert context.state["hussh:consent_token"] != "synthetic-token"
    identity = h.ledger.issue.await_args.kwargs
    assert identity["channel"] == "adk_chat" and identity["session_id"] == "thread"
    response = await module.confirm_review(
        **h.request, directive_id=preview["directiveId"], confirmed=True
    )
    assert response["status"] == "confirmed" and response["receipt"] == "synthetic-receipt"
    h.tool.run_async.assert_not_called()
    for instance in h.created:
        instance.close.assert_awaited_once()


@pytest.mark.parametrize(
    "failure", ["registration", "session", "tool", "arguments", "confirmation", "stale"]
)
async def test_review_fails_closed_and_never_dispatches(harness, failure):
    h = harness
    if failure == "registration":
        h.registry.get_connector.return_value.owner_user_id = "other"
    elif failure == "session":
        h.sessions.get_session.return_value = None
    elif failure == "tool":
        h.request["tool_name"] = "mcp_" + "c" * 40
    elif failure == "arguments":
        h.request["arguments"] = {"q": 42}
    elif failure == "stale":
        h.ledger.confirm.side_effect = ActionDirectiveAuthorityError("stale")
    with pytest.raises((ExternalMcpError, ActionDirectiveAuthorityError)):
        await module.confirm_review(
            **h.request, directive_id="dir_" + "b" * 32, confirmed=failure != "confirmation"
        )
    h.tool.run_async.assert_not_called()
    h.ledger.issue.assert_not_called()
    if failure in {"registration", "session"}:
        h.resolver.assert_not_called()
