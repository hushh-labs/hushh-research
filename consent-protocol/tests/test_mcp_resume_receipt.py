import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import mcp_call_approval as approval
from hushh_mcp.one_adk.governed_mcp_toolset import mcp_tool_name
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from tests.helpers.chat_keys import bound_request_chat_key


@pytest.fixture
def owner_chat_key(monkeypatch):
    """The unlocked browser's chat key for ``owner``, as the middleware binds it."""
    from api.routes.one import agent_chat

    monkeypatch.setattr(
        agent_chat,
        "_session_service",
        SimpleNamespace(is_legacy_session=AsyncMock(return_value=False)),
    )
    with bound_request_chat_key("owner"):
        yield


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
async def test_chat_admission_scrubs_receipt_and_requires_vault_authority(
    monkeypatch, unlocked, owner_chat_key
):
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


async def test_chat_state_keeps_owner_name_as_an_expiring_reference(monkeypatch, owner_chat_key):
    from starlette.requests import Request

    from api.routes.one import agent_chat
    from hushh_mcp.one_adk.agent_tree import STATE_OWNER_DISPLAY_NAME
    from hushh_mcp.one_adk.request_secrets import resolve_request_secret
    from tests.test_agui_turn_timing import _input

    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(return_value={"user_id": "owner", "token": "synthetic"}),
    )
    monkeypatch.setattr(
        agent_chat, "_owner_display_name_for_turn", AsyncMock(return_value="Akshat Kumar")
    )
    # This branch admits the owner through Firebase identity plus the vault consent
    # header on shared hosting, the same shape as the admission tests above.
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda _: "owner")
    monkeypatch.setattr(agent_chat, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    request = Request(
        {
            "type": "http",
            "headers": [
                (b"authorization", b"Bearer synthetic"),
                (b"x-hushh-consent", b"HCT:synthetic"),
            ],
        }
    )

    state = await agent_chat._extract_state(request, _input())

    assert state[STATE_OWNER_DISPLAY_NAME].startswith("one_secret_ref:")
    assert "Akshat Kumar" not in str(state)
    assert resolve_request_secret(state[STATE_OWNER_DISPLAY_NAME]) == "Akshat Kumar"


@pytest.mark.parametrize("unlocked", [True, False])
async def test_chat_configuration_admission_requires_unlock_and_scrubs_input(
    monkeypatch, unlocked, owner_chat_key
):
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


@pytest.mark.usefixtures("shared_pending_store")
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


async def test_review_ledger_outage_is_reported_as_review_unavailable(monkeypatch):
    """A database without the review ledger must not read as a declined approval."""
    from google.adk.agents.context import Context
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.sessions import InMemorySessionService, Session

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
    issue = AsyncMock(side_effect=ActionDirectiveAuthorityError("private ledger diagnostic"))
    monkeypatch.setattr(approval.McpCallApproval, "issue", issue)
    binding = McpConnectionBinding("owner", "custom-1", 1, 1, "https://example.com/mcp")
    result = await approval.review_or_resume_call(
        context, binding, "write", "revision", {"q": "PRIVATE_ARGUMENT"}
    )
    assert result == {
        "status": "unavailable",
        "error": "MCP_REVIEW_UNAVAILABLE",
        "retryable": False,
    }
    assert not context.actions.requested_tool_confirmations
    # Owner/conversation mismatch stays an authority failure, not an outage.
    context.state["temp:one_execution_surface"] = "voice"
    with pytest.raises(ActionDirectiveAuthorityError):
        await approval.review_or_resume_call(context, binding, "write", "revision", {})


async def test_pod_port_keeps_arguments_private_and_refuses_changed_or_fenced_resume(monkeypatch):
    import json
    from dataclasses import replace
    from datetime import UTC, datetime, timedelta

    from hushh_mcp import runtime_settings
    from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding
    from hushh_mcp.one_adk.mcp_pending_call import capture_pending_call, pending_resume_scope
    from hushh_mcp.one_adk.request_secrets import store_request_secret
    from hushh_mcp.services import pod_mcp_approval as port_module

    monkeypatch.setenv("APP_SIGNING_KEY", "synthetic-pod-key-not-a-secret-32bytes")
    runtime_settings.clear_runtime_settings_caches()
    owner = SimpleNamespace(
        owner="owner",
        hushh_id="pod",
        require_access=AsyncMock(),
        authority=SimpleNamespace(
            pod_key_id="key",
            environment="dev",
            epoch=1,
            lease=SimpleNamespace(state=AsyncMock(return_value="held")),
        ),
    )
    requests = []

    def post(path, *, json):
        requests.append((path, json))
        if path.endswith("issue"):
            return SimpleNamespace(
                status_code=200,
                json=lambda: {
                    "directiveId": payload()["directiveId"],
                    "expiresAt": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
                    "podReview": {**json["review"], "serviceUid": "uid"},
                },
            )
        return SimpleNamespace(status_code=200, json=lambda: {"status": "consumed"})

    port = port_module.PodMcpApprovalPort(owner, client=SimpleNamespace(post=post))
    call = approval.McpCallApproval(
        "owner",
        "thread",
        McpConnectionBinding("owner", "custom-1", 1, 1, "https://example.com/mcp"),
        "search",
        "rev1",
        {"q": "PRIVATE_ARGUMENT"},
        "call-1",
    )
    with approval.bind_mcp_approval_port(port):
        issued = await call.issue(None)
    assert "PRIVATE_ARGUMENT" not in json.dumps(requests)
    with approval.bind_mcp_approval_port(port):
        handle = await capture_pending_call(
            SimpleNamespace(
                user_id="owner",
                function_call_id="call-1",
                state={"hussh:user_id": "owner", "hussh:conversation_id": "thread"},
            ),
            tool_name=payload()["toolName"],
            arguments=call.arguments,
            review={"podReview": issued.private_review},
        )
        reference = store_request_secret(json.dumps({"pendingHandle": handle}))
        async with pending_resume_scope(reference):
            for changed in (
                replace(call, arguments={"q": "changed"}),
                replace(call, call_id="other"),
                replace(call, catalog_revision="rev2"),
                replace(call, binding=replace(call.binding, authority_revision=("changed",))),
            ):
                with pytest.raises(ActionDirectiveAuthorityError):
                    await port.consume(changed, directive_id=issued.directive_id, receipt="r" * 43)
            assert len(requests) == 1
            await port.consume(call, directive_id=issued.directive_id, receipt="r" * 43)
            owner.authority.lease.state.side_effect = ["held", "fenced"]
            with pytest.raises(ActionDirectiveAuthorityError):
                await port.consume(call, directive_id=issued.directive_id, receipt="r" * 43)
    assert "PRIVATE_ARGUMENT" not in json.dumps(requests)
    # No pod port can turn its assertion into browser confirmation.
    assert not hasattr(port, "confirm")


async def test_unstorable_review_shows_no_card_and_dispatches_nothing(monkeypatch):
    """A card that could never be confirmed is not shown (nothing was sent)."""
    from datetime import UTC, datetime, timedelta

    from google.adk.agents.context import Context
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.sessions import InMemorySessionService, Session

    from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding
    from hushh_mcp.one_adk.mcp_pending_call import PendingCallStorageError

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
    monkeypatch.setattr(approval.McpCallApproval, "issue", AsyncMock(return_value=issued))
    monkeypatch.setattr(
        approval,
        "capture_pending_call",
        AsyncMock(
            side_effect=PendingCallStorageError("Connector review is temporarily unavailable.")
        ),
    )
    binding = McpConnectionBinding("owner", "custom-1", 1, 1, "https://example.com/mcp")
    result = await approval.review_or_resume_call(
        context, binding, "search", "revision", {"q": "PRIVATE_ARGUMENT"}
    )
    assert result == {
        "status": "unavailable",
        "error": "MCP_REVIEW_UNAVAILABLE",
        "retryable": False,
    }
    assert "call" not in context.actions.requested_tool_confirmations


async def test_supersede_is_scoped_to_owner_conversation_and_the_mcp_action():
    store = SimpleNamespace(cancel_unconfirmed_adk_chat=AsyncMock())
    await approval.supersede_unanswered_reviews("owner", "thread", store=store)
    store.cancel_unconfirmed_adk_chat.assert_awaited_once_with(
        user_id="owner", session_id="thread", action_id=approval.MCP_ACTION_ID
    )


@pytest.mark.parametrize("owner,thread", [("", "thread"), ("owner", "")])
async def test_supersede_without_an_exact_scope_touches_nothing(owner, thread):
    store = SimpleNamespace(cancel_unconfirmed_adk_chat=AsyncMock())
    await approval.supersede_unanswered_reviews(owner, thread, store=store)
    store.cancel_unconfirmed_adk_chat.assert_not_awaited()


async def test_supersede_fails_quietly(caplog):
    failing = SimpleNamespace(
        cancel_unconfirmed_adk_chat=AsyncMock(side_effect=ActionDirectiveAuthorityError("secret"))
    )
    with caplog.at_level("WARNING"):
        await approval.supersede_unanswered_reviews("owner", "thread", store=failing)
    assert "secret" not in caplog.text and "owner" not in caplog.text


async def test_supersede_is_never_abandoned_on_a_timeout():
    # A cancel left queued behind a busy database would run after the new turn
    # issued its review and disarm it. The turn therefore waits for the cancel.
    finished = []

    async def slow(**_):
        await asyncio.sleep(0.05)
        finished.append(True)

    await approval.supersede_unanswered_reviews(
        "owner", "thread", store=SimpleNamespace(cancel_unconfirmed_adk_chat=slow)
    )
    assert finished == [True]


async def test_private_review_supersession_never_opens_shared_authority():
    store = SimpleNamespace(cancel_unconfirmed_adk_chat=AsyncMock())
    with approval.bind_mcp_approval_port(SimpleNamespace()):
        await approval.supersede_unanswered_reviews("owner", "thread", store=store)
    store.cancel_unconfirmed_adk_chat.assert_not_awaited()


async def test_pod_without_approval_port_never_uses_shared_ledger(monkeypatch):
    from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding

    monkeypatch.setattr(approval, "pod_mode", lambda: True)
    store = SimpleNamespace(issue=AsyncMock(), consume=AsyncMock(), confirm=AsyncMock())
    call = approval.McpCallApproval(
        "owner",
        "thread",
        McpConnectionBinding("owner", "custom-1", 1, 1, "https://example.com/mcp"),
        "search",
        "rev1",
        {},
        "call-1",
    )
    for operation in (
        call.issue(store),
        call.consume(store, directive_id="dir_" + "a" * 32, receipt="r" * 43),
        call.confirm(store, directive_id="dir_" + "a" * 32, confirmed=True),
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            await operation
    store.issue.assert_not_awaited()
    store.consume.assert_not_awaited()
    store.confirm.assert_not_awaited()
