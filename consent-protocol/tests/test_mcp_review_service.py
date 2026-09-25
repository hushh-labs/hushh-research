"""Browser review prepares authority; only the native Chat tool executes."""

from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.sessions import InMemorySessionService, Session

from hushh_mcp.one_adk import mcp_review_service as module
from hushh_mcp.one_adk import mcp_turn_scope
from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding, ResolvedMcpConnection
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError


@pytest.fixture
def harness(monkeypatch):
    binding = McpConnectionBinding("owner", "custom", 1, 1, "https://example.com/mcp")
    registry = SimpleNamespace(
        get_connector=AsyncMock(
            return_value=SimpleNamespace(
                owner_user_id="owner",
                display_name="Synthetic connector",
                is_active=True,
                transport_kind="mcp",
                connector_id="custom",
            )
        )
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


async def test_vault_configuration_reviews_without_private_registry(harness, monkeypatch):
    h = harness
    monkeypatch.setattr(
        mcp_turn_scope, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )
    configuration = {
        "version": 1,
        "connectorId": "custom_" + "a" * 32,
        "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "displayName": "Vault connector",
        "endpoint": "https://example.com/mcp",
        "enabled": True,
        "authentication": {"kind": "api_key", "header": "X-API-Key", "value": "synthetic-secret"},
    }
    request = {
        **h.request,
        "connector_id": configuration["connectorId"],
        "configuration": configuration,
    }
    preview = await module.prepare_review(**request)
    assert preview["connectorLabel"] == "Vault connector"
    assert "synthetic-secret" not in str(preview)
    h.registry.get_connector.assert_not_called()
    h.resolver.assert_not_called()
    h.tool.run_async.assert_not_called()
    with pytest.raises(ExternalMcpError):
        await module.prepare_review(**{**request, "connector_id": "custom_" + "b" * 32})


async def test_review_and_confirmation_use_current_terms_without_executing(harness):
    h = harness
    preview = await module.prepare_review(**h.request)
    assert preview["arguments"] == h.request["arguments"]
    assert preview["status"] == "review_required"
    assert preview["connectorLabel"] == "Synthetic connector"
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


async def test_provider_snapshot_is_bound_to_review_and_confirmation(harness):
    h = harness
    original = h.resolver.return_value
    snapshot = ("synthetic-subject", "connection-1", "grant-1")
    h.resolver.return_value = replace(
        original, binding=replace(original.binding, authority_revision=snapshot)
    )
    preview = await module.prepare_review(**h.request)
    issued = h.ledger.issue.await_args.kwargs["resource_binding"]
    assert issued["authority_revision"] == list(snapshot)
    assert "synthetic-subject" not in str(preview)
    h.resolver.return_value = replace(
        original,
        binding=replace(
            original.binding, authority_revision=("synthetic-subject", "connection-1", "grant-2")
        ),
    )
    await module.confirm_review(**h.request, directive_id=preview["directiveId"], confirmed=True)
    current = h.ledger.confirm.await_args.kwargs["terms"].resource_binding
    assert current != issued
    assert current["authority_revision"][-1] == "grant-2"
    # The real ledger hashes the complete binding, not just numeric versions.
    ledger = ActionDirectiveStore(db=SimpleNamespace(), hmac_key="synthetic-key")
    assert ledger._hmac(current) != ledger._hmac(issued)
    h.tool.run_async.assert_not_called()


async def test_curated_drive_review_uses_same_scope_and_never_executes(harness):
    h = harness
    definition = h.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = "google_drive"
    definition.transport_kind = "google_drive_rest"
    h.request["connector_id"] = "google_drive"
    h.resolver.return_value = replace(
        h.resolver.return_value,
        binding=replace(h.resolver.return_value.binding, connector_id="google_drive"),
    )
    preview = await module.prepare_review(**h.request)
    assert preview["connectorId"] == "google_drive"
    context, connector_id = h.resolver.await_args.args
    assert connector_id == "google_drive"
    assert context.state["temp:hussh:workspace_chat_admission"] is True
    assert context.user_id == "owner"
    h.tool.run_async.assert_not_called()


@pytest.mark.parametrize("registration", ["disabled", "unsupported", "wrong-owner"])
async def test_curated_drive_review_rejects_registration_before_credentials(harness, registration):
    h = harness
    definition = h.registry.get_connector.return_value
    definition.owner_user_id = None
    definition.connector_id = "google_drive"
    definition.transport_kind = "google_drive_rest"
    if registration == "disabled":
        definition.is_active = False
    elif registration == "unsupported":
        definition.connector_id = "unreviewed_provider"
    else:
        definition.owner_user_id = "another-owner"
    with pytest.raises(ExternalMcpError):
        await module.prepare_review(**h.request)
    h.resolver.assert_not_awaited()
    h.tool.run_async.assert_not_called()


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


@pytest.fixture
def pending_harness(harness):
    from google.adk.events import Event
    from google.genai import types

    from hushh_mcp.one_adk.mcp_pending_call import capture_pending_call

    h = harness
    original = {"id": "call", "name": h.tool.name, "args": {}}
    h.sessions.get_session.return_value.events = [
        Event(
            author="one",
            content=types.Content(
                parts=[
                    types.Part(function_call=types.FunctionCall(**original)),
                    types.Part(
                        function_call=types.FunctionCall(
                            id="confirmation",
                            name="adk_request_confirmation",
                            args={
                                "originalFunctionCall": original,
                                "toolConfirmation": {"confirmed": False},
                            },
                        )
                    ),
                ]
            ),
        )
    ]
    h.directive = "dir_" + "d" * 32
    h.handle = capture_pending_call(
        SimpleNamespace(
            user_id="owner",
            function_call_id="call",
            state={"hussh:user_id": "owner", "hussh:conversation_id": "thread"},
        ),
        tool_name=h.tool.name,
        arguments=h.request["arguments"],
        review={
            "connectorId": "custom",
            "directiveId": h.directive,
            "catalogRevision": "rev1",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        },
    )
    h.request["pending_handle"] = h.handle
    return h


async def test_pending_review_reuses_native_directive_without_reissuing(pending_harness):
    h = pending_harness
    preview = await module.prepare_review(**{**h.request, "arguments": {}})
    assert preview["directiveId"] == h.directive
    assert preview["arguments"] == {"q": "synthetic query"}
    assert preview["pendingHandle"] == h.handle
    result = await module.confirm_review(**h.request, directive_id=h.directive, confirmed=True)
    assert result["status"] == "confirmed"
    assert h.ledger.confirm.await_args.kwargs["directive_id"] == h.directive
    h.ledger.issue.assert_not_called()
    h.tool.run_async.assert_not_called()


@pytest.mark.parametrize("failure", ["owner", "call", "catalog", "arguments", "directive"])
async def test_pending_confirmation_rejects_mismatched_call(pending_harness, failure):
    h = pending_harness
    directive = h.directive
    if failure == "owner":
        h.sessions.get_session.return_value.user_id = "other"
    elif failure == "call":
        h.sessions.get_session.return_value.events = []
    elif failure == "catalog":
        h.tool.revision = "rev2"
    elif failure == "arguments":
        h.request["arguments"] = {"q": "changed"}
    else:
        directive = "dir_" + "f" * 32
    with pytest.raises(ActionDirectiveAuthorityError):
        await module.confirm_review(**h.request, directive_id=directive, confirmed=True)
    h.ledger.confirm.assert_not_called()
    h.ledger.issue.assert_not_called()
    h.tool.run_async.assert_not_called()
