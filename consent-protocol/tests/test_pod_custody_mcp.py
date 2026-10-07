"""Curated MCP in the owner's agent runs only on credentials the agent itself holds.

``pod_custody_mcp`` builds a curated connector's turn configuration from a login sealed
to the agent: the access token is minted by refreshing at the issuer's own token
endpoint (on the issuer's own origin), a rotation is recorded, ``invalid_grant`` marks
the login for reauth, and anything that cannot be minted here is left out rather than
filled from the hub. A device may not claim a custody connector's id.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

# ruff: noqa: S106 -- token-shaped strings below name test fixtures, not credentials.
import pytest
from google.adk.tools.mcp_tool.mcp_tool import McpTool
from mcp.types import Tool

from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope, validate_mcp_turn_configurations
from hushh_mcp.one_adk.pod_custody_mcp import (
    CustodyMcpTokens,
    custody_configuration_admissions,
    custody_configurations,
    custody_connector_id,
    merge_turn_configurations,
)
from hushh_mcp.services import pod_connector_credentials as store
from tests import pod_connector_harness as h

ISSUER = "https://auth.crm.example"
MCP = {"endpoint": "https://mcp.crm.example/mcp", "issuer": ISSUER, "clientId": "client-1"}


@pytest.fixture
def agent(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch, tmp_path, connectors={"mcp_crm": h.credential("mcp_crm", (), mcp=dict(MCP))}
    )
    yield log
    h.uninstall()


def _tokens(post_answer, *, token_endpoint=f"{ISSUER}/token", log=None):
    posts: list[tuple[str, dict]] = []

    async def get(url: str):
        assert url == f"{ISSUER}/.well-known/oauth-authorization-server"
        return 200, {"token_endpoint": token_endpoint}

    async def post(url: str, form):
        posts.append((url, dict(form)))
        return post_answer

    return CustodyMcpTokens(get=get, post=post, log_resolver=lambda: log), posts


async def test_a_custody_login_becomes_an_admitted_turn_configuration(agent):
    minter, posts = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    (record,) = await custody_configurations(minter)
    assert record["connectorId"] == custody_connector_id("mcp_crm")
    assert record["authentication"]["accessToken"] == "mcp-access"
    assert validate_mcp_turn_configurations([record]), "the scope's own validator admits it"
    ((url, form),) = posts
    assert url == f"{ISSUER}/token" and form["grant_type"] == "refresh_token"


async def test_a_token_endpoint_off_the_issuers_origin_is_never_used(agent):
    minter, posts = _tokens((200, {"access_token": "x"}), token_endpoint="https://evil.example/t")
    assert await custody_configurations(minter) == []
    assert posts == []


async def test_invalid_grant_marks_the_login_for_reauth_and_leaves_it_out(agent):
    held = store.active_connector_credential("mcp_crm")
    await agent.append(store.RECORD_KIND, store._payload(h.OWNER_HUSHH, held))
    minter, _posts = _tokens((400, {"error": "invalid_grant"}), log=agent)
    assert await custody_configurations(minter) == []
    *_, newest = [r for r in await agent.replay() if r["kind"] == store.RECORD_KIND]
    assert newest["payload"]["status"] == store.STATUS_NEEDS_REAUTH
    assert newest["payload"]["generation"] == held.generation + 1


async def test_nothing_is_built_outside_an_owner_cloud_agent(agent, monkeypatch):
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    minter, posts = _tokens((200, {"access_token": "x"}))
    assert await custody_configurations(minter) == [] and posts == []


def test_a_device_record_may_not_claim_a_custody_id(agent):
    custody = [{"connectorId": custody_connector_id("mcp_crm"), "from": "custody"}]
    device = [
        {"connectorId": custody_connector_id("mcp_crm"), "from": "device"},
        {"connectorId": "custom_" + "a" * 32, "from": "device"},
    ]
    merged = merge_turn_configurations(device, custody)
    assert merged == [device[1], custody[0]]


async def test_concurrent_custody_token_requests_refresh_once_and_reuse_the_cache(agent):
    minter, posts = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    held = store.active_connector_credential("mcp_crm")
    results = await asyncio.gather(*(minter.token(held) for _ in range(10)))
    assert len(posts) == 1 and all(result[0] == "mcp-access" for result in results)


@pytest.mark.parametrize("rotation", [False, True])
async def test_a_custody_refresh_cannot_return_after_a_login_is_replaced(agent, rotation):
    held = store.active_connector_credential("mcp_crm")
    await agent.append(store.RECORD_KIND, store._payload(h.OWNER_HUSHH, held))

    async def get(_url):
        return 200, {"token_endpoint": f"{ISSUER}/token"}

    async def post(_url, _form):
        await store.clear_connector_credential(
            agent, hushh_id=h.OWNER_HUSHH, connector_id="mcp_crm"
        )
        from hushh_mcp.services.pod_connector_credential_seal import OpenedConnectorCredential

        await store.record_connector_credential(
            agent,
            hushh_id=h.OWNER_HUSHH,
            opened=OpenedConnectorCredential(
                kind="mcp_oauth",
                connector_id="mcp_crm",
                provider="mcp",
                credential_id="88888888-2222-4333-8444-555555555555",
                issued_at_ms=2,
                client_id="client-1",
                mcp=dict(MCP),
            ),
            account_subject=ISSUER,
            granted_scopes=(),
            refresh_token="replacement-refresh",
        )
        return 200, {
            "access_token": "stale-access",
            "expires_in": 3600,
            **({"refresh_token": "stale-rotation"} if rotation else {}),
        }

    minter = CustodyMcpTokens(get=get, post=post, log_resolver=lambda: agent)
    assert await minter.token(held) is None
    assert minter._cache == {}
    assert store.active_connector_credential("mcp_crm").refresh_token == "replacement-refresh"


async def test_a_custody_token_without_provider_expiry_is_never_given_an_invented_lifetime(agent):
    minter, posts = _tokens((200, {"access_token": "mcp-access"}))
    assert await custody_configurations(minter) == [] and len(posts) == 1


async def _governed_tool(scope, context, approve):
    toolset = await scope.acquire(context, custody_connector_id("mcp_crm"), authorize_call=approve)
    session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[
                    Tool(
                        name="inspect",
                        inputSchema={"type": "object"},
                        annotations={"readOnlyHint": True},
                    )
                ],
                nextCursor=None,
            )
        )
    )
    toolset._mcp_session_manager = SimpleNamespace(
        create_session=AsyncMock(return_value=session),
        _begin_session_use=Mock(),
        _end_session_use=Mock(),
        close=AsyncMock(),
    )
    (tool,) = await toolset.get_tools(context)
    return toolset, tool


def _change_login(change):
    held = store.active_connector_credential("mcp_crm")
    credentials = (
        {}
        if change == "disconnect"
        else {
            "mcp_crm": replace(
                held,
                credential_id=(
                    "88888888-2222-4333-8444-555555555555"
                    if change == "reconnect"
                    else held.credential_id
                ),
                generation=held.generation + 1,
            )
        }
    )
    store.set_active_connector_credentials(credentials)


async def test_custody_tools_keep_exact_review_even_with_provider_read_only_hints(
    agent, monkeypatch
):
    minter, _ = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    records = await custody_configurations(minter)
    context = h.tool_context()
    approve = AsyncMock(return_value={"status": "approval_required"})
    native = AsyncMock(return_value={"content": [], "structuredContent": {"count": 1}})
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    async with mcp_turn_scope(
        "conv-l6",
        owner_id=h.OWNER_UID,
        configurations=records,
        configuration_admissions=custody_configuration_admissions(records),
        owner_admission=AsyncMock(return_value=True),
        vault_only=True,
    ) as scope:
        toolset, tool = await _governed_tool(scope, context, approve)
        assert toolset.review_policy == "always"
        assert (await tool.run_async(args={}, tool_context=context))[
            "status"
        ] == "approval_required"
        native.assert_not_awaited()
        approve.return_value = None  # the existing approval port consumed exact consent
        result = await tool.run_async(args={}, tool_context=context)
        assert result["status"] == "ok" and result["review"] == "approved"
        native.assert_awaited_once()
    assert scope._configurations == {} and scope._configuration_admissions == {}


@pytest.mark.parametrize("change", ["disconnect", "reconnect", "rotation"])
@pytest.mark.parametrize("phase", ["before_provider", "after_provider"])
async def test_custody_tools_recheck_live_login_around_provider_await(
    agent, monkeypatch, change, phase
):
    minter, _ = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    records = await custody_configurations(minter)
    context = h.tool_context()

    async def provider(**_kwargs):
        _change_login(change)
        return {"content": [], "structuredContent": {"count": 1}}

    native = AsyncMock(side_effect=provider)
    monkeypatch.setattr(McpTool, "_run_async_impl", native)
    async with mcp_turn_scope(
        "conv-l6",
        owner_id=h.OWNER_UID,
        configurations=records,
        configuration_admissions=custody_configuration_admissions(records),
        owner_admission=AsyncMock(return_value=True),
        vault_only=True,
    ) as scope:
        _, tool = await _governed_tool(scope, context, AsyncMock(return_value=None))
        if phase == "before_provider":
            _change_login(change)
        result = await tool.run_async(args={}, tool_context=context)
        assert result["error"] == "MCP_CONNECTION_CHANGED"
        if phase == "before_provider":
            native.assert_not_awaited()
            assert "outcome" not in result
        else:
            native.assert_awaited_once()
            assert result["outcome"] == "unknown" and result["retryable"] is False


async def test_a_disconnect_keeps_custody_id_reserved_after_log_recovery(agent):
    held = store.active_connector_credential("mcp_crm")
    await agent.append(store.RECORD_KIND, store._payload(h.OWNER_HUSHH, held))
    await store.clear_connector_credential(agent, hushh_id=h.OWNER_HUSHH, connector_id="mcp_crm")
    device = [{"connectorId": custody_connector_id("mcp_crm")}]
    assert merge_turn_configurations(device, []) == []
    store.set_active_connector_credentials({})  # a fresh process starts with no active credentials
    await store.load_connector_credentials(agent)
    assert store.held_connector_ids() == ()
    assert merge_turn_configurations(device, []) == []


async def test_unminted_custody_id_cannot_be_supplied_by_the_device(agent):
    minter, _ = _tokens((503, {"error": "unavailable"}))
    assert await custody_configurations(minter) == []
    assert merge_turn_configurations([{"connectorId": custody_connector_id("mcp_crm")}], []) == []


async def test_owner_admission_await_cannot_admit_a_stale_custody_record(agent):
    from hushh_mcp.services.external_mcp_client import ExternalMcpError

    minter, _ = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    records = await custody_configurations(minter)

    async def admit(_context):
        _change_login("rotation")
        return True

    async with mcp_turn_scope(
        "conv-l6",
        owner_id=h.OWNER_UID,
        configurations=records,
        configuration_admissions=custody_configuration_admissions(records),
        owner_admission=admit,
        vault_only=True,
    ) as scope:
        with pytest.raises(ExternalMcpError) as caught:
            await scope.resolve_connection(h.tool_context(), records[0]["connectorId"])
        assert caught.value.code == "MCP_CONNECTION_CHANGED"


async def test_private_catalog_refuses_a_device_record_with_a_custody_id(agent):
    from hushh_mcp.one_adk.pod_mcp_catalog import discover_private_catalog
    from hushh_mcp.services.external_mcp_client import ExternalMcpError

    minter, _ = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    (record,) = await custody_configurations(minter)
    with pytest.raises(ExternalMcpError) as caught:
        await discover_private_catalog(
            SimpleNamespace(require_access=AsyncMock()), record["connectorId"], record
        )
    assert caught.value.code == "MCP_CONNECTION_CHANGED"


async def test_pod_turn_composes_custody_without_a_hub_resolver(agent, monkeypatch):
    from hushh_mcp.one_adk import mcp_turn_scope as scope_module
    from hushh_mcp.one_adk import pod_custody_mcp
    from hushh_mcp.one_adk.pod_agui_lifetime import PodTimedADKAgent

    minter, _ = _tokens((200, {"access_token": "mcp-access", "expires_in": 3600}))
    monkeypatch.setattr(pod_custody_mcp, "_TOKENS", minter)
    registry = AsyncMock(side_effect=AssertionError("no private hub fallback"))
    monkeypatch.setattr(scope_module, "resolve_registered_connection", registry)
    runner = PodTimedADKAgent.__new__(PodTimedADKAgent)
    runner.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=Mock(),
        mcp_owner_admission=AsyncMock(return_value=True),
    )
    async with runner._mcp_turn_resources("conv-l6", owner_id=h.OWNER_UID, configurations=[]):
        resolved = await runner._pod_mcp_scope.resolve_connection(
            h.tool_context(), custody_connector_id("mcp_crm")
        )
        assert resolved.headers == {"Authorization": "Bearer mcp-access"}
        assert resolved.review_policy == "always"
    await runner._pod_mcp_scope.close()
    registry.assert_not_awaited()
