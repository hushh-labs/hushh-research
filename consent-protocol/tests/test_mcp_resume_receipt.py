from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import mcp_call_approval as approval
from hushh_mcp.one_adk.governed_mcp_toolset import mcp_tool_name
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError


def payload():
    return {
        "directiveId": "dir_" + "a" * 32,
        "toolName": mcp_tool_name("custom-1", "search"),
        "connectorId": "custom-1",
        "receipt": "r" * 43,
    }


def admitted():
    forwarded = {"mcpApproval": payload(), "timezone": "UTC"}
    reference = approval.admit_resume_receipt(forwarded, owner_id="owner", conversation_id="thread")
    assert forwarded == {"timezone": "UTC"}
    assert reference.startswith("one_secret_ref:")
    assert payload()["receipt"] not in reference
    return reference


def test_absent_receipt_does_not_create_authority():
    assert approval.admit_resume_receipt({}, owner_id="owner", conversation_id="thread") == ""


@pytest.mark.parametrize(
    "change",
    [
        {"receipt": "short"},
        {"toolName": "search"},
        {"extra": True},
        {"directiveId": "forged"},
        {"connectorId": "../other"},
    ],
)
def test_invalid_envelope_is_scrubbed_even_when_rejected(change):
    forwarded = {"mcpApproval": {**payload(), **change}}
    with pytest.raises(ActionDirectiveAuthorityError):
        approval.admit_resume_receipt(forwarded, owner_id="owner", conversation_id="thread")
    assert "mcpApproval" not in forwarded


@pytest.mark.parametrize("owner,thread", [("", "thread"), ("owner", "")])
def test_anonymous_or_threadless_admission_is_rejected(owner, thread):
    with pytest.raises(ActionDirectiveAuthorityError):
        approval.admit_resume_receipt(
            {"mcpApproval": payload()}, owner_id=owner, conversation_id=thread
        )


@pytest.mark.parametrize("change", ["owner", "thread", "connector", "tool", "literal", "expired"])
async def test_mismatched_resume_never_reaches_ledger(monkeypatch, change):
    reference = admitted()
    context = SimpleNamespace(
        user_id="owner",
        state={
            approval.STATE_MCP_APPROVAL: reference,
            "hussh:conversation_id": "thread",
        },
    )
    binding = SimpleNamespace(owner_id="owner", connector_id="custom-1")
    name = "search"
    if change == "owner":
        context.user_id = "other"
    elif change == "thread":
        context.state["hussh:conversation_id"] = "other"
    elif change == "connector":
        binding.connector_id = "other"
    elif change == "tool":
        name = "send"
    elif change == "literal":
        context.state[approval.STATE_MCP_APPROVAL] = payload()["receipt"]
    else:
        context.state[approval.STATE_MCP_APPROVAL] = "one_secret_ref:missing"
    factory = AsyncMock()
    monkeypatch.setattr(approval, "receipt_authorizer", factory)
    with pytest.raises(ActionDirectiveAuthorityError):
        await approval.consume_resume_receipt(context, binding, name, "revision", {})
    factory.assert_not_called()


async def test_matching_resume_still_requires_exact_ledger_authority(monkeypatch):
    context = SimpleNamespace(
        user_id="owner",
        state={
            approval.STATE_MCP_APPROVAL: admitted(),
            "hussh:conversation_id": "thread",
        },
    )
    binding = SimpleNamespace(owner_id="owner", connector_id="custom-1")
    authorize = AsyncMock(side_effect=ActionDirectiveAuthorityError("already consumed"))

    def factory(store, *, directive_id, receipt):
        assert directive_id == payload()["directiveId"]
        assert receipt == payload()["receipt"]
        return authorize

    monkeypatch.setattr(approval, "receipt_authorizer", factory)
    with pytest.raises(ActionDirectiveAuthorityError):
        await approval.consume_resume_receipt(
            context, binding, "search", "new-revision", {"q": "x"}
        )
    authorize.assert_awaited_once_with(context, binding, "search", "new-revision", {"q": "x"})


@pytest.mark.parametrize("unlocked", [True, False])
async def test_chat_admission_scrubs_receipt_and_requires_vault_authority(monkeypatch, unlocked):
    from fastapi import HTTPException
    from starlette.requests import Request

    from api.routes.one import agent_chat
    from tests.test_agui_turn_timing import _input

    vault = AsyncMock(return_value={"user_id": "owner", "token": "synthetic-vault-token"})
    if not unlocked:
        vault.side_effect = HTTPException(status_code=403)
    monkeypatch.setattr(agent_chat, "require_vault_owner_token", vault)
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda _: "owner")
    monkeypatch.setattr(agent_chat, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    request = Request(
        {
            "type": "http",
            "headers": [(b"authorization", b"Bearer synthetic")]
            + ([(b"x-hushh-consent", b"HCT:synthetic")] if unlocked else []),
        }
    )
    run = _input()
    run.forwarded_props = {"mcpApproval": payload()}
    if unlocked:
        state = await agent_chat._extract_state(request, run)
        assert state[approval.STATE_MCP_APPROVAL].startswith("one_secret_ref:")
        assert payload()["receipt"] not in str(state)
    else:
        with pytest.raises(HTTPException) as error:
            await agent_chat._extract_state(request, run)
        assert error.value.status_code == 403
    assert "mcpApproval" not in run.forwarded_props
    assert run.state == {}


@pytest.mark.parametrize("unlocked", [True, False])
async def test_chat_configuration_admission_requires_unlock_and_scrubs_input(monkeypatch, unlocked):
    from fastapi import HTTPException
    from starlette.requests import Request

    from api.routes.one import agent_chat
    from hushh_mcp.one_adk.mcp_turn_scope import (
        STATE_MCP_CONFIGURATION,
        consume_turn_configurations,
    )
    from tests.test_agui_turn_timing import _input

    vault = AsyncMock(return_value={"user_id": "owner", "token": "synthetic"})
    if not unlocked:
        vault.side_effect = HTTPException(status_code=403)
    monkeypatch.setattr(agent_chat, "require_vault_owner_token", vault)
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda _: "owner")
    monkeypatch.setattr(agent_chat, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    request = Request(
        {
            "type": "http",
            "headers": [(b"authorization", b"Bearer synthetic")]
            + ([(b"x-hushh-consent", b"HCT:synthetic")] if unlocked else []),
        }
    )
    run = _input()
    run.forwarded_props = {"mcpConfigurations": []}
    if unlocked:
        state = await agent_chat._extract_state(request, run)
        assert state[STATE_MCP_CONFIGURATION].startswith("one_secret_ref:")
        assert (
            consume_turn_configurations(state, owner_id="owner", conversation_id=run.thread_id)
            == []
        )
    else:
        with pytest.raises(HTTPException):
            await agent_chat._extract_state(request, run)
    assert run.forwarded_props == {}


async def test_first_call_uses_native_confirmation_without_executing(monkeypatch):
    from datetime import UTC, datetime, timedelta

    from google.adk.agents.context import Context
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.sessions import InMemorySessionService, Session
    from google.adk.tools.tool_confirmation import ToolConfirmation

    from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding

    context = Context(
        InvocationContext(
            session_service=InMemorySessionService(),
            invocation_id="turn",
            session=Session(
                id="thread",
                user_id="owner",
                app_name="hussh_one",
                state={
                    "hussh:user_id": "owner",
                    "hussh:conversation_id": "thread",
                    "temp:one_execution_surface": "typed_chat",
                },
            ),
        ),
        function_call_id="call",
    )
    issued = SimpleNamespace(
        directive_id="dir_" + "a" * 32, expires_at=datetime.now(UTC) + timedelta(minutes=5)
    )
    issue = AsyncMock(return_value=issued)
    monkeypatch.setattr(approval.McpCallApproval, "issue", issue)
    binding = McpConnectionBinding("owner", "custom-1", 1, 1, "https://example.com/mcp")
    result = await approval.review_or_resume_call(
        context, binding, "search", "revision", {"q": "PRIVATE_ARGUMENT"}
    )
    assert result == {"status": "review_required"}
    requested = context.actions.requested_tool_confirmations["call"]
    assert requested.payload["kind"] == "mcp_call_review"
    assert requested.payload["pendingHandle"].startswith("one_secret_ref:")
    assert "PRIVATE_ARGUMENT" not in str(requested.payload)
    assert context.actions.skip_summarization is True
    issue.assert_awaited_once()
    context.tool_confirmation = ToolConfirmation(confirmed=False)
    assert (await approval.review_or_resume_call(context, binding, "search", "revision", {}))[
        "error"
    ] == "MCP_REVIEW_DECLINED"
    # Even the SDK's positive confirmation does not replace app-ledger authority.
    context.tool_confirmation = ToolConfirmation(confirmed=True)
    with pytest.raises(ActionDirectiveAuthorityError):
        await approval.review_or_resume_call(context, binding, "search", "revision", {})
    forwarded = {
        "mcpApproval": {
            **payload(),
            "pendingHandle": requested.payload["pendingHandle"],
        }
    }
    context.state[approval.STATE_MCP_APPROVAL] = approval.admit_resume_receipt(
        forwarded,
        owner_id="owner",
        conversation_id="thread",
    )
    authorize = AsyncMock(return_value=None)
    monkeypatch.setattr(approval, "receipt_authorizer", lambda *args, **kwargs: authorize)
    assert (
        await approval.review_or_resume_call(
            context,
            binding,
            "search",
            "revision",
            {"q": "PRIVATE_ARGUMENT"},
        )
        is None
    )
    authorize.assert_awaited_once()
    other = SimpleNamespace(
        user_id="owner",
        function_call_id="different-call",
        state=context.state,
        tool_confirmation=ToolConfirmation(confirmed=True),
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await approval.review_or_resume_call(
            other, binding, "search", "revision", {"q": "PRIVATE_ARGUMENT"}
        )
    assert authorize.await_count == 1
