# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Regression contracts for Personal Sandbox (`virgin_pool_v1`) ADK chat harness parity."""

from __future__ import annotations

import asyncio
import secrets
from typing import Any

import httpx
import pytest

from hushh_mcp.one_adk import action_tools
from hushh_mcp.one_adk.agui_factory import _adk_context_cache_config
from hushh_mcp.services.agent_sandbox.edge_gateway_app import (
    SandboxEdgeGatewayManager,
    create_sandbox_edge_gateway_app,
)
from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import (
    ClaimedSandboxEndpoint,
)
from hushh_mcp.services.pod_information_discovery import (
    InformationDiscoveryOptions,
    PrivateInformationDiscovery,
    project_information_discovery,
)
from hushh_mcp.services.pod_owner_cloud import (
    hosted_ace_runtime,
    owner_cloud_agent,
    private_pod_runtime,
)


def test_virgin_pool_sandbox_is_private_pod_runtime_not_owner_cloud(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_PROFILE", "virgin_pool_v1")
    monkeypatch.setenv("HUSSH_LEASE_ID", "lease_abc123")
    monkeypatch.setenv("HUSSH_ID", "ha1_7o6wt3s4mtydneyytqfswsxtafdlpjwz")
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_AWS_KMS_KEY_ARN", raising=False)

    assert hosted_ace_runtime() is True
    assert private_pod_runtime() is True
    assert owner_cloud_agent() is False


def test_sentinel_model_gateway_disables_adk_context_cache_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_URL", "http://127.0.0.1:8082")
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_TOKEN", "surrogate_tok_123")
    monkeypatch.setenv("HUSHH_ADK_CONTEXT_CACHE_FORCE_TEST", "1")

    class DummyRoot:
        model = "gemini-4-hydrogen"

    assert _adk_context_cache_config(DummyRoot()) is None


@pytest.mark.asyncio
async def test_list_information_shared_with_me_routes_via_owner_feed_in_sandbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_PROFILE", "virgin_pool_v1")
    monkeypatch.setenv("HUSSH_LEASE_ID", "lease_abc123")
    monkeypatch.setenv("HUSSH_ID", "ha1_7o6wt3s4mtydneyytqfswsxtafdlpjwz")

    class FakeFeedClient:
        def read(self, kind: str, owner: str, *, params: dict[str, Any] | None = None) -> dict:
            assert kind == "information"
            assert owner == "user_kt"
            op = (params or {}).get("operation")
            if op == "connections":
                return {
                    "operation": "connections",
                    "people": [
                        {
                            "displayName": "Kushal Trivedi",
                            "publicPersonRef": "pref_kushal_trivedi_0001",
                            "email": None,
                        }
                    ],
                    "hasMore": False,
                }
            if op == "granted_shares":
                return project_information_discovery(
                    {
                        "operation": "granted_shares",
                        "grantedShares": [
                            {
                                "personRef": "pref_kushal_trivedi_0001",
                                "person": "Kushal Trivedi",
                                "grantRef": "req_kushal_bank_01",
                                "requestId": "req_kushal_bank_01",
                                "bundleId": "11111111-2222-3333-4444-555555555555",
                                "label": "Bank Accounts",
                                "sensitivity": "sensitive",
                                "fieldOutline": ["Liquid cash", "Checking"],
                                "fields": [{"name": "Liquid cash", "sensitivity": "sensitive"}],
                                "sharedAt": "2026-11-20T18:00:00Z",
                                "accessEndsAt": "2026-11-27T18:00:00Z",
                                "purpose": "Portfolio review",
                                "decryptable": True,
                            }
                        ],
                    }
                )
            raise AssertionError(f"unexpected operation {op}")

    disc = PrivateInformationDiscovery("user_kt", FakeFeedClient())
    opts = InformationDiscoveryOptions(
        operation="granted_shares", person_ref="pref_kushal_trivedi_0001"
    )
    assert opts.operation == "granted_shares"
    from api.routes.one.pod_owner_feed import _query_read_options

    parsed = _query_read_options(
        "information",
        {"operation": "granted_shares", "person_ref": "pref_kushal_trivedi_0001"},
    )
    assert parsed["information"].operation == "granted_shares"

    async def fake_read_uid(_tc: Any) -> tuple[str, None]:
        return ("user_kt", None)

    monkeypatch.setattr(action_tools, "_read_tool_user_id", fake_read_uid)
    monkeypatch.setattr(action_tools, "_information_read_user_id", fake_read_uid)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_information_discovery.private_information_discovery",
        lambda uid: disc,
    )

    class DummyToolContext:
        def __init__(self) -> None:
            self.state: dict[str, Any] = {}

    res = await action_tools.list_information_shared_with_me(
        DummyToolContext(),  # type: ignore[arg-type]
        person="Kushal Trivedi",
    )
    assert res["status"] == "ok"
    assert res["count"] == 1
    assert res["card"]["person"]["displayName"] == "Kushal Trivedi"
    assert res["card"]["items"][0]["label"] == "Bank Accounts"


@pytest.mark.asyncio
async def test_edge_gateway_active_http_count_blocks_mid_stream_idle_reap() -> None:
    import socket
    import threading

    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse

    first_chunk_sent = threading.Event()
    allow_finish = threading.Event()
    upstream_app = FastAPI()

    @upstream_app.post("/internal/v1/activate-lease")
    async def activate() -> dict[str, str]:
        return {"status": "activated"}

    @upstream_app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @upstream_app.post("/api/one/pod/agent-chat")
    async def slow_sse() -> StreamingResponse:
        async def gen():
            yield b'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hey KT!"}\n\n'
            first_chunk_sent.set()
            await asyncio.to_thread(allow_finish.wait, 5.0)
            yield b'data: {"type":"RUN_FINISHED"}\n\n'

        return StreamingResponse(gen(), media_type="text/event-stream")

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        up_port = s.getsockname()[1]
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        gw_port = s.getsockname()[1]

    up_server = uvicorn.Server(
        uvicorn.Config(upstream_app, host="127.0.0.1", port=up_port, log_level="error")
    )
    threading.Thread(target=up_server.run, daemon=True).start()

    class LocalClaimClient:
        def __init__(self) -> None:
            self.deleted: list[str] = []

        def create_and_wait_claim(
            self, *, claim_name: str, **kwargs: Any
        ) -> ClaimedSandboxEndpoint:
            return ClaimedSandboxEndpoint(
                claim_name=claim_name,
                namespace="hussh-agents",
                sandbox_name="sbx-1",
                pod_ip="127.0.0.1",
                port=up_port,
            )

        def delete_claim(self, claim_name: str) -> None:
            self.deleted.append(claim_name)

    now_val = [100.0]
    claims = LocalClaimClient()
    mgr = SandboxEdgeGatewayManager(
        claim_client=claims,
        master_seed=secrets.token_bytes(32),
        idle_timeout_s=10.0,
        clock_s=lambda: now_val[0],
    )
    gw = create_sandbox_edge_gateway_app(mgr, enable_reaper=False)
    gw_server = uvicorn.Server(
        uvicorn.Config(gw, host="127.0.0.1", port=gw_port, log_level="error")
    )
    threading.Thread(target=gw_server.run, daemon=True).start()

    for port in (up_port, gw_port):
        for _ in range(40):
            try:
                async with httpx.AsyncClient() as c:
                    if (await c.get(f"http://127.0.0.1:{port}/health")).status_code == 200:
                        break
            except Exception:
                await asyncio.sleep(0.05)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            chunks: list[bytes] = []

            async def consume_sse() -> None:
                async with client.stream(
                    "POST",
                    f"http://127.0.0.1:{gw_port}/u/ha1_owner_test/api/one/pod/agent-chat",
                    content=b"{}",
                ) as resp:
                    assert resp.status_code == 200
                    async for ch in resp.aiter_bytes():
                        chunks.append(ch)

            sse_task = asyncio.create_task(consume_sse())
            assert await asyncio.to_thread(first_chunk_sent.wait, 5.0)

            lease = mgr.get_lease("ha1_owner_test")
            assert lease is not None
            assert lease.active_http_count == 1

            # Advance clock past idle timeout while SSE stream is open: must NOT reap!
            now_val[0] = 200.0
            reaped = await mgr.reap_idle_leases()
            assert reaped == []
            assert claims.deleted == []

            allow_finish.set()
            await sse_task
            joined = b"".join(chunks).decode("utf-8")
            assert "RUN_FINISHED" in joined
            assert lease.active_http_count == 0
    finally:
        allow_finish.set()
        gw_server.should_exit = True
        up_server.should_exit = True


def test_dynamic_scope_phosphor_icons_ban_sparkles_and_infer_semantics() -> None:
    from hushh_mcp.consent.scope_icons import (
        CANONICAL_PHOSPHOR_SCOPE_ICONS,
        normalize_or_infer_scope_icon,
    )

    assert "sparkles" not in CANONICAL_PHOSPHOR_SCOPE_ICONS
    assert normalize_or_infer_scope_icon(icon_name="sparkles", domain="financial") == "chart-line"
    assert (
        normalize_or_infer_scope_icon(
            scope="attr.financial.accounts",
            label="Bank Accounts",
            domain="financial",
        )
        == "bank"
    )
    assert (
        normalize_or_infer_scope_icon(
            scope="attr.financial.liabilities",
            label="Credit & Loans",
            domain="financial",
        )
        == "credit-card"
    )
    assert (
        normalize_or_infer_scope_icon(
            icon_name="folder",
            domain="schwab_tax_docs",
            label="Charles Schwab 2026 Statements",
        )
        == "receipt"
    )
    assert (
        normalize_or_infer_scope_icon(
            domain="culinary_notes",
            label="Favorite Coffee & Restaurants",
        )
        == "fork-knife"
    )


@pytest.mark.asyncio
async def test_propose_information_request_excludes_already_granted_scopes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.one_adk import action_tools

    class FakeDiscovery:
        def list_connections(self, *, user_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "displayName": "Kushal Trivedi",
                    "publicPersonRef": "pref_kushal_01",
                }
            ]

        def catalog(self, person_ref: str) -> dict[str, Any]:
            return {
                "personRef": person_ref,
                "connectorReady": True,
                "requestableScopes": [
                    {
                        "scopeRef": "sref_fin_accounts",
                        "label": "Bank Accounts",
                        "description": "Checking and savings accounts",
                        "domain": "financial",
                        "domainLabel": "Financial",
                        "iconName": "bank",
                        "sensitivity": "sensitive",
                        "wildcard": False,
                        "pathSegments": ["accounts"],
                    },
                    {
                        "scopeRef": "sref_fin_liabilities",
                        "label": "Credit & Loans",
                        "description": "Credit card liabilities and loans",
                        "domain": "financial",
                        "domainLabel": "Financial",
                        "iconName": "credit-card",
                        "sensitivity": "sensitive",
                        "wildcard": False,
                        "pathSegments": ["liabilities"],
                    },
                ],
            }

        def granted_shares(self, person_ref: str = "") -> list[dict[str, Any]]:
            return [
                {
                    "personRef": "pref_kushal_01",
                    "person": "Kushal Trivedi",
                    "grantRef": "req_acc_1",
                    "requestId": "req_acc_1",
                    "bundleId": "11111111-2222-3333-4444-555555555555",
                    "scopeRef": "sref_fin_accounts",
                    "label": "Bank Accounts",
                    "sensitivity": "sensitive",
                    "fieldOutline": ["Checking"],
                    "fields": [{"name": "Checking", "sensitivity": "sensitive"}],
                    "sharedAt": "2026-11-20T18:00:00Z",
                    "accessEndsAt": "2026-11-27T18:00:00Z",
                    "purpose": "Review",
                    "decryptable": True,
                }
            ]

        def pending(self, person_ref: str, scope_refs: list[str]) -> list[dict[str, Any]]:
            return []

    async def fake_read_uid(_tc: Any) -> tuple[str, None]:
        return ("user_kt", None)

    monkeypatch.setattr(action_tools, "_information_read_user_id", fake_read_uid)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_information_discovery.private_information_discovery",
        lambda _uid: FakeDiscovery(),
    )

    class DummyToolContext:
        def __init__(self) -> None:
            self.state: dict[str, Any] = {"temp:session_id": "sess_test_1"}

    # Asking solely for already-shared Bank Accounts returns already_shared instead of re-selecting
    res_dup = await action_tools.propose_information_request(
        person="Kushal Trivedi",
        fields="Bank Accounts",
        purpose="Portfolio review",
        tool_context=DummyToolContext(),  # type: ignore[arg-type]
        question="Show Kushal's bank accounts",
    )
    assert res_dup["status"] == "already_shared"

    # Asking for financial accounts + credit liabilities proposes ONLY Credit & Loans!
    res_second = await action_tools.propose_information_request(
        person="Kushal Trivedi",
        fields="Bank Accounts and Credit & Loans",
        purpose="Liability review",
        tool_context=DummyToolContext(),  # type: ignore[arg-type]
        question="Fetch Kushal's liabilities and accounts",
    )
    proposed_refs = [p["scope"] for p in res_second.get("proposed", [])]
    assert proposed_refs == ["sref_fin_liabilities"]


def test_search_directory_exclude_connected_handles_string_relationship(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Directory items carry relationship as a plain string ('connected' / 'none' / 'pending_outgoing')."""
    from hushh_mcp.services import connections_service as cs_mod
    from hushh_mcp.services import one_location_agent_service as loc_mod

    svc = cs_mod.ConnectionsService()
    monkeypatch.setattr(svc, "_active_connected_user_ids", lambda _uid: {"user_connected"})
    monkeypatch.setattr(svc, "_public_person_refs", lambda ids: {i: f"ref_{i}" for i in ids})
    monkeypatch.setattr(svc, "_verified_ria_user_ids", lambda _ids: set())
    monkeypatch.setattr(svc, "_directory_profiles", lambda _ids: {}, raising=False)

    class FakeLocationService:
        def search_directory_candidates(
            self,
            *_args: Any,
            exclude_network_user_ids: set[str] | None = None,
            **_kwargs: Any,
        ) -> dict[str, Any]:
            assert exclude_network_user_ids == {"user_connected"}
            return {
                "items": [
                    {"userId": "user_connected", "displayName": "Connected Peer"},
                    {"userId": "user_pending", "displayName": "Pending Peer"},
                    {"userId": "user_new", "displayName": "New Peer"},
                ],
                "hasMore": False,
            }

    class FakeSettler:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def settle(self) -> dict[str, dict[str, Any]]:
            return {
                "user_connected": {"relationship": "connected"},
                "user_pending": {"relationship": "pending_outgoing"},
                "user_new": {"relationship": "none"},
            }

    monkeypatch.setattr(loc_mod, "OneLocationAgentService", FakeLocationService)
    monkeypatch.setattr(cs_mod, "ConnectionRowMetadata", FakeSettler)

    out = svc.search_directory("viewer_uid", exclude_connected=True)
    names = [item["displayName"] for item in out["items"]]
    assert names == ["Pending Peer", "New Peer"]


def test_inject_dynamic_turn_context_keeps_function_response_content_pure() -> None:
    """Vertex gemini-4-hydrogen rejects function_response Content mixed with text parts."""
    from types import SimpleNamespace

    from google.genai import types as genai_types

    from hushh_mcp.one_adk import agent_tree

    ctx = SimpleNamespace(
        state={
            "temp:one_execution_surface": "typed_chat",
            "temp:hussh:split_dynamic_context": True,
            "hussh:user_id": "owner_1",
            "hussh:timezone": "America/Los_Angeles",
            "hussh:voice_context": {"screen": "chat", "screen_state": {"plaid_connected": True}},
        }
    )
    user_turn = genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text="Request financial accounts from Kushal")],
    )
    model_turn = genai_types.Content(
        role="model",
        parts=[
            genai_types.Part.from_function_call(
                name="propose_information_request",
                args={"person": "Kushal", "fields": ["accounts"]},
            )
        ],
    )
    tool_turn = genai_types.Content(
        role="user",
        parts=[
            genai_types.Part.from_function_response(
                name="propose_information_request",
                response={"status": "proposal_ready"},
            )
        ],
    )
    req = SimpleNamespace(contents=[user_turn, model_turn, tool_turn])
    agent_tree.inject_dynamic_turn_context_before_model(ctx, req)

    # Tool-response Content must stay 100% pure function_response (no appended text part!)
    assert len(req.contents[2].parts) == 1
    assert req.contents[2].parts[0].function_response is not None
    assert req.contents[2].parts[0].text is None
    # Dynamic turn context is attached cleanly to the human user turn
    assert any(
        (p.text or "").startswith(agent_tree._DYNAMIC_TURN_CONTEXT_MARKER)
        for p in req.contents[0].parts
    )


@pytest.mark.asyncio
async def test_list_granted_shares_batches_request_statuses_once_per_subject() -> None:
    from hushh_mcp.services.information_request_service import InformationRequestService

    svc = InformationRequestService()
    batch_calls: list[tuple[str, list[str]]] = []
    single_calls: list[str] = []

    class FakeConsent:
        async def get_request_statuses(
            self, user_id: str, request_ids: list[str]
        ) -> dict[str, dict[str, Any]]:
            batch_calls.append((user_id, list(request_ids)))
            return {}

        async def get_request_status(self, _user_id: str, request_id: str) -> dict[str, Any] | None:
            single_calls.append(request_id)
            return None

        async def get_active_tokens(self, *_a: Any, **_kw: Any) -> list[dict[str, Any]]:
            return []

    svc._consent = FakeConsent()  # type: ignore[assignment]

    async def fake_rows(sql: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if "FROM one_information_request_bundles bundle" in sql:
            return [
                {
                    "bundle_id": f"00000000-0000-0000-0000-00000000000{idx}",
                    "purpose": "Portfolio check",
                    "created_at": 1700000000000,
                    "subject_user_id": "subj_1",
                    "public_person_ref": "pref_1",
                    "display_name": "Kushal",
                    "request_id": f"req_{idx}",
                    "scope_ref": f"sref_{idx}",
                    "scope": "attr.financial.accounts",
                    "label": "Bank accounts",
                    "sensitivity": "sensitive",
                }
                for idx in (1, 2, 3)
            ]
        return [{"public_person_ref": "viewer_ref", "display_name": "KT"}]

    svc._rows = fake_rows  # type: ignore[method-assign]
    out = await svc.list_granted_shares(requester_user_id="viewer_1", person_ref="pref_1")
    assert out == []
    assert batch_calls == [("subj_1", ["req_1", "req_2", "req_3"])]
    assert single_calls == []


def test_all_59_root_adk_tools_verified_across_tier1_stems_and_tier2_dynamic_unlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify 100% of `_one_roster_tools()` remain reachable across Tier-1 and Tier-2 scoping."""
    from types import SimpleNamespace

    from google.adk.models.llm_request import LlmRequest
    from google.adk.tools.base_tool import BaseTool
    from google.genai import types as genai_types

    from hushh_mcp.one_adk.agent_tree import _one_roster_tools
    from hushh_mcp.one_adk.tool_scoping import (
        ACTIVATE_PACK_TOOL_NAME,
        ALL_SCOPED_LEAF_TOOLS,
        CAPABILITY_PACKS_BY_ID,
        activate_capability_pack,
        scope_leaf_tools_before_model,
    )

    monkeypatch.setenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", "1")
    roster = _one_roster_tools(allow_receipt_tools=True)
    roster_names = [str(getattr(t, "name", None) or getattr(t, "__name__", "")) for t in roster]
    assert len(roster_names) >= 59
    always_on_names = {n for n in roster_names if n not in ALL_SCOPED_LEAF_TOOLS}
    assert len(always_on_names) >= 23

    class _StubTool(BaseTool):
        def __init__(self, tool_name: str) -> None:
            super().__init__(name=tool_name, description=tool_name)

    def _build_req(prompt: str, extra_contents: list[Any] | None = None) -> LlmRequest:
        decls = [
            genai_types.FunctionDeclaration(name=name, description=name) for name in roster_names
        ]
        contents = [
            genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)]),
            *(extra_contents or []),
        ]
        return LlmRequest(
            model="gemini-4-hydrogen",
            contents=contents,
            config=genai_types.GenerateContentConfig(
                tools=[genai_types.Tool(function_declarations=decls)]
            ),
            tools_dict={name: _StubTool(name) for name in roster_names},
        )

    # 1. Verify every single pack unlocks via Tier-1 colloquial phrasing (1 LLM call).
    colloquial_prompts_by_pack = {
        "calendar": "can we push back my 3pm on thursday?",
        "location": "where is everyone in my family circle right now?",
        "drive_files": "ask Kushal for his 2026 Schwab pdf statement",
        "sharing_consent": "is anything waiting on me to allow?",
        "mail": "write to alex@example.com with a quick update",
        "style_model": "please be briefer and more direct with me",
        "onboarding_goals": "help me set up my next milestone plan",
        "receipts": "how much did i spend at merchants last month?",
    }
    covered_tools: set[str] = set()
    for pack_id, prompt in colloquial_prompts_by_pack.items():
        ctx = SimpleNamespace(state={})
        req = _build_req(prompt)
        scope_leaf_tools_before_model(ctx, req)
        present = {d.name for d in req.config.tools[0].function_declarations}
        assert always_on_names.issubset(present)
        expected_pack = CAPABILITY_PACKS_BY_ID[pack_id] & set(roster_names)
        assert expected_pack.issubset(present), f"Pack {pack_id} missing tools on prompt {prompt!r}"
        covered_tools.update(present - {ACTIVATE_PACK_TOOL_NAME})

    # Every single tool in the full 59+ roster was unlocked and verified!
    assert set(roster_names).issubset(covered_tools)

    # 2. Verify Tier-2 zero-keyword oblique prompt exposes `activate_capability_pack`,
    #    and calling it unlocks the requested pack immediately in the same turn!
    oblique_ctx = SimpleNamespace(state={})
    step1_req = _build_req("adjust verbosity posture")  # zero keyword overlap on purpose
    scope_leaf_tools_before_model(oblique_ctx, step1_req)
    step1_names = {d.name for d in step1_req.config.tools[0].function_declarations}
    assert ACTIVATE_PACK_TOOL_NAME in step1_names
    assert ACTIVATE_PACK_TOOL_NAME in step1_req.tools_dict
    assert "propose_style_settings" not in step1_names

    unlock_res = activate_capability_pack(["style_model"], tool_context=oblique_ctx)
    assert unlock_res["status"] == "ok"
    assert "propose_style_settings" in unlock_res["unlockedTools"]

    step2_req = _build_req("adjust verbosity posture")
    scope_leaf_tools_before_model(oblique_ctx, step2_req)
    step2_names = {d.name for d in step2_req.config.tools[0].function_declarations}
    assert "propose_style_settings" in step2_names
    assert "set_preferred_model" in step2_names
    assert "list_available_models" in step2_names


@pytest.mark.asyncio
async def test_list_pending_information_requests_prestages_natural_language_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    async def fake_uid(_tc: Any) -> tuple[str, None]:
        return ("owner_kushal", None)

    class FakeLifecycle:
        async def list_pending_incoming(self, _uid: str) -> list[dict[str, Any]]:
            return [
                {
                    "requesterLabel": "KT",
                    "label": "Cashflow as of",
                    "requestIds": ["one_person_cashflow_01"],
                },
                {
                    "requesterLabel": "Rohan",
                    "label": "Identity",
                    "requestIds": ["one_person_rohan_02"],
                },
            ]

    monkeypatch.setattr(action_tools, "_read_tool_user_id", fake_uid)
    monkeypatch.setattr(action_tools, "ConsentLifecycleService", FakeLifecycle)

    res = await action_tools.list_pending_information_requests(
        SimpleNamespace(state={}),  # type: ignore[arg-type]
        requester_query="KT",
        staged_duration_hours=72,
    )
    assert res["status"] == "ok"
    assert res["pendingRequestIds"] == ["one_person_cashflow_01"]
    assert res["stagedConsentDecision"] == {
        "requestIds": ["one_person_cashflow_01"],
        "expiryHours": 72,
    }


@pytest.mark.asyncio
async def test_pod_mode_consent_and_connection_read_tools_route_via_owner_feed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    from hushh_mcp.services.pod_information_discovery import PrivateInformationDiscovery

    async def fake_info_uid(_tc: Any) -> tuple[str, None]:
        return ("owner_kushal", None)

    class FakeOwnerFeedClient:
        def read(
            self, kind: str, owner: str, *, params: dict[str, Any], fresh: bool = False
        ) -> dict[str, Any]:
            assert kind == "information"
            assert owner == "owner_kushal"
            op = params["operation"]
            if op == "pending_incoming":
                assert fresh is True
                return {
                    "operation": "pending_incoming",
                    "pendingIncoming": [
                        {
                            "requestId": "req_kt_01",
                            "requestIds": ["req_kt_01"],
                            "requesterLabel": "KT",
                            "requesterType": "person",
                            "description": "Liabilities as of",
                            "reason": "Cashflow review",
                        }
                    ],
                }
            if op == "active_grants":
                return {
                    "operation": "active_grants",
                    "activeGrants": [
                        {
                            "scope": "attr.financial.accounts",
                            "requestId": "req_acc_01",
                            "label": "Accounts",
                            "holderLabel": "KT",
                        }
                    ],
                }
            if op == "connections":
                return {
                    "operation": "connections",
                    "people": [
                        {
                            "displayName": "KT",
                            "publicPersonRef": "pref_kt",
                            "email": "kt@example.com",
                        }
                    ],
                }
            if op == "outgoing_requests":
                return {
                    "operation": "outgoing_requests",
                    "outgoingRequests": [
                        {
                            "bundleId": "bundle_01",
                            "personRef": "pref_kt",
                            "displayName": "KT",
                            "purpose": "Review",
                        }
                    ],
                }
            if op == "connection_requests":
                return {
                    "operation": "connection_requests",
                    "connectionRequests": [
                        {
                            "id": "conn_req_01",
                            "status": "pending",
                            "counterpartUserId": "uid_kt",
                            "counterpartDisplayName": "KT",
                        }
                    ],
                }
            raise AssertionError(f"Unexpected op: {op}")

    monkeypatch.setattr("hushh_mcp.runtime_settings.pod_mode", lambda: True)
    monkeypatch.setattr(action_tools, "_information_read_user_id", fake_info_uid)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_information_discovery.private_information_discovery",
        lambda owner: PrivateInformationDiscovery(owner, FakeOwnerFeedClient()),
    )

    tc = SimpleNamespace(state={})  # type: ignore[arg-type]
    pending = await action_tools.list_pending_information_requests(
        tc, requester_query="KT", staged_duration_hours=72
    )
    assert pending["status"] == "ok"
    assert pending["stagedConsentDecision"] == {"requestIds": ["req_kt_01"], "expiryHours": 72}

    grants = await action_tools.list_active_grants(tc)
    assert grants["status"] == "ok"
    assert grants["count"] == 1

    conns = await action_tools.list_my_connections(tc)
    assert conns["status"] == "ok"
    assert len(conns["connections"]) == 1

    outgoing = await action_tools.list_my_outgoing_information_requests(tc)
    assert outgoing["status"] == "ok"
    assert len(outgoing["requests"]) == 1

    conn_reqs = await action_tools.list_pending_connection_requests(tc, direction="incoming")
    assert conn_reqs["status"] == "ok"
    assert len(conn_reqs["requests"]) == 1


def test_silent_rolling_horizon_preserves_prefix_cache_and_tool_pairs() -> None:
    from types import SimpleNamespace

    from google.genai import types as genai_types

    from hushh_mcp.one_adk.rolling_horizon import (
        ROLLING_THREAD_DIGEST_STATE_KEY,
        compact_horizon_before_model,
        compile_rolling_thread_digest,
    )

    def _make_turn(i: int) -> list[genai_types.Content]:
        return [
            genai_types.Content(
                role="user", parts=[genai_types.Part.from_text(text=f"User question {i}")]
            ),
            genai_types.Content(
                role="model",
                parts=[
                    genai_types.Part(
                        function_call=genai_types.FunctionCall(
                            id=f"c{i}", name="search_wiki", args={"query": f"q{i}"}
                        )
                    )
                ],
            ),
            genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part(
                        function_response=genai_types.FunctionResponse(
                            id=f"c{i}",
                            name="search_wiki",
                            response={"status": "ok", "blob": "x" * 2400},
                        )
                    )
                ],
            ),
            genai_types.Content(
                role="model", parts=[genai_types.Part.from_text(text=f"Answer {i}")]
            ),
        ]

    # 1. <= 20 user turns -> untouched
    short_contents = [c for i in range(18) for c in _make_turn(i)]
    short_req = SimpleNamespace(contents=list(short_contents))
    compact_horizon_before_model(SimpleNamespace(state={}), short_req)
    assert len(short_req.contents) == len(short_contents)

    # 2. 25 and 26 user turns -> both snap to the same 4-turn quantized horizon anchor (cut_turn=4)
    #    so Gemini prefix cache hits across consecutive turns, and tool pairs are never split!
    c25 = [c for i in range(25) for c in _make_turn(i)]
    c26 = [c for i in range(26) for c in _make_turn(i)]
    req25 = SimpleNamespace(contents=list(c25))
    req26 = SimpleNamespace(contents=list(c26))
    state = {ROLLING_THREAD_DIGEST_STATE_KEY: "Earlier summary: turns 0..3 covered onboarding."}
    compact_horizon_before_model(SimpleNamespace(state=state), req25)
    compact_horizon_before_model(SimpleNamespace(state=state), req26)

    assert "User question 4" in req25.contents[0].parts[1].text
    assert "User question 4" in req26.contents[0].parts[1].text
    assert "Earlier summary" in req25.contents[0].parts[0].text
    # Ensure every function_call in kept contents still has its matching function_response
    fc_ids = {
        p.function_call.id
        for c in req26.contents
        for p in (c.parts or [])
        if p.function_call is not None
    }
    fr_ids = {
        p.function_response.id
        for c in req26.contents
        for p in (c.parts or [])
        if p.function_response is not None
    }
    assert fc_ids == fr_ids

    # 3. Consent-tagged invocations are excluded from rolling digest compilation
    from hushh_mcp.one_adk.consent_redaction import CONSENT_INVOCATIONS_PREFIX

    fake_events = [
        SimpleNamespace(
            author="user",
            invocation_id=f"inv_{i}",
            content=genai_types.Content(
                role="user",
                parts=[genai_types.Part.from_text(text=f"Secret {i}" if i == 1 else f"Topic {i}")],
            ),
        )
        for i in range(26)
    ]
    digest, older_cnt = compile_rolling_thread_digest(
        fake_events, {f"{CONSENT_INVOCATIONS_PREFIX}bundle_1": ["inv_1"]}
    )
    assert older_cnt == 4
    assert "Secret 1" not in digest
    assert "Topic 0" in digest


def test_cursor_paged_conversation_history_projects_seamlessly() -> None:
    from types import SimpleNamespace

    from hushh_mcp.one_adk.history_projection import project_conversation_history

    events = [
        SimpleNamespace(
            id=f"ev_{i}",
            invocation_id=f"turn_{i // 2}",
            author="user" if i % 2 == 0 else "one",
            interrupted=False,
            model_version="gemini-4-hydrogen",
            timestamp=1700000000 + i,
            content=SimpleNamespace(
                parts=[SimpleNamespace(text=f"Msg {i}", function_response=None)]
            ),
        )
        for i in range(70)
    ]

    page1 = project_conversation_history(
        events,
        "conv_one",
        30,
        project_event=lambda ev: (ev.content.parts[0].text, None),
    )
    assert len(page1["messages"]) == 30
    assert page1["has_more"] is True
    assert page1["oldest_cursor"] == "ev_40"

    page2 = project_conversation_history(
        events,
        "conv_one",
        30,
        before_id=page1["oldest_cursor"],
        project_event=lambda ev: (ev.content.parts[0].text, None),
    )
    assert len(page2["messages"]) == 30
    assert page2["has_more"] is True
    assert page2["oldest_cursor"] == "ev_10"
    assert page2["messages"][-1]["id"] == "ev_39"

    page3 = project_conversation_history(
        events,
        "conv_one",
        30,
        before_id=page2["oldest_cursor"],
        project_event=lambda ev: (ev.content.parts[0].text, None),
    )
    assert len(page3["messages"]) == 10
    assert page3["has_more"] is False
    assert page3["oldest_cursor"] is None
    assert page3["messages"][0]["id"] == "ev_0"


@pytest.mark.asyncio
async def test_optimize_knowledge_base_deduplicates_repairs_and_hard_pins_paid_grants() -> None:
    from hushh_mcp.services.wiki_memory import WikiLibrary, WikiMaintenanceRunner

    class _InMemStore:
        def __init__(self) -> None:
            self._blobs: dict[str, tuple[bytes, str]] = {}
            self._seq = 0

        async def verify_bucket(self, _kms_ref: str) -> None:
            return None

        async def get_with_generation(self, path: str) -> tuple[bytes | None, str]:
            hit = self._blobs.get(path)
            return (hit[0], hit[1]) if hit else (None, "")

        async def put_if_generation(self, path: str, data: bytes, expected_generation: str) -> str:
            cur = self._blobs.get(path)
            cur_gen = cur[1] if cur else ""
            if cur_gen != expected_generation:
                raise RuntimeError("CAS mismatch")
            self._seq += 1
            next_gen = str(self._seq)
            self._blobs[path] = (bytes(data), next_gen)
            return next_gen

        async def list_page(
            self, prefix: str, *, cursor: str = "", limit: int = 100
        ) -> tuple[list[str], str]:
            _ = cursor, limit
            return sorted(k for k in self._blobs if k.startswith(prefix)), ""

        async def delete_key(self, path: str) -> bool:
            return self._blobs.pop(path, None) is not None

    async def _noop() -> None:
        return None

    wiki = WikiLibrary(
        owner="owner_kushal",
        key=b"\x42" * 32,
        store=_InMemStore(),
        check=_noop,
    )

    # 1. Financial page backing a paid/active shared scope with an expired-dated sole claim + missing tldr + broken link
    await wiki.create_page(
        page_id="wpg_0000000000000001",
        title="Accounts Overview",
        folder="financial",
        tldr="",
        status_as_of="2026-01-10",
        body="Primary brokerage account details.",
        claims=[
            {
                "claim_id": "wcl_0000000000000001",
                "statement": "Primary brokerage balance is $142,000.",
                "status": "active",
                "valid_from": "2025-01-01",
                "valid_until": "2025-12-31",
                "source_ids": ["wsr_0000000000000001"],
            }
        ],
        links=[
            {"target_page_id": "wpg_0000000000000002", "relation": "related"},
            {"target_page_id": "wpg_0000000000000099", "relation": "related"},
        ],
        idempotency_key="idem_create_fin_opt_01",
    )

    # 2. Travel page with duplicate claims + expired temporary claim
    await wiki.create_page(
        page_id="wpg_0000000000000002",
        title="Travel Preferences",
        folder="travel",
        tldr="Window seat preference.",
        status_as_of="2026-06-01",
        body="Seat and hotel notes.",
        claims=[
            {
                "claim_id": "wcl_0000000000000002",
                "statement": "Prefers window seats on long-haul flights.",
                "status": "active",
                "source_ids": ["wsr_000000000000000a"],
            },
            {
                "claim_id": "wcl_0000000000000003",
                "statement": "prefers   window seats on long-haul flights!",
                "status": "active",
                "source_ids": ["wsr_000000000000000b"],
            },
            {
                "claim_id": "wcl_0000000000000004",
                "statement": "Temporary 2024 pass active.",
                "status": "active",
                "valid_until": "2024-12-31",
                "source_ids": ["wsr_000000000000000c"],
            },
        ],
        links=[],
        idempotency_key="idem_create_trv_opt_01",
    )

    summary = await WikiMaintenanceRunner(wiki).optimize_knowledge_base(
        idempotency_key="idem_run_optimize_001",
        protected_scopes={"attr.financial.accounts"},
        reference_date="2026-11-20",
    )

    assert summary["inspected_page_count"] == 2
    assert summary["deduplicated_claim_count"] >= 1
    assert summary["stale_retired_count"] >= 1
    assert summary["structure_repairs_count"] >= 2  # pruned broken link + backfilled missing tldr
    assert summary["protected_grant_pages_count"] == 1
    assert summary["protected_claims_preserved_count"] == 1

    # Verify paid/shared financial claim stayed ACTIVE and TLDR + broken link were repaired!
    fin_after = await wiki.read_page("wpg_0000000000000001")
    assert fin_after["claims"][0]["status"] == "active"
    assert "142,000" in fin_after["tldr"]
    assert fin_after["links"][0]["target_page_id"] == "wpg_0000000000000002"
    assert len(fin_after["links"]) == 1

    # Verify unshared travel page merged duplicate sources and retired expired noise
    trv_after = await wiki.read_page("wpg_0000000000000002")
    active_trv = [c for c in trv_after["claims"] if c["status"] == "active"]
    assert len(active_trv) == 1
    assert sorted(active_trv[0]["source_ids"]) == [
        "wsr_000000000000000a",
        "wsr_000000000000000b",
    ]


@pytest.mark.asyncio
async def test_active_lease_renews_sentinel_model_surrogate_in_place_past_one_hour() -> None:
    """An active sandbox lease with open streams past 60m renews its surrogate in place instead of 401-ing."""
    import secrets

    from hushh_mcp.services.agent_sandbox.edge_gateway_app import (
        ActiveOwnerLease,
        SandboxEdgeGatewayManager,
    )
    from hushh_mcp.services.agent_sandbox.sentinel_proxy_server import SentinelProxyRuntime

    fake_now = [1_000_000]
    sentinel = SentinelProxyRuntime(
        hmac_key=b"S" * 32,
        control_token=secrets.token_hex(16),
        clock_s=lambda: fake_now[0],
    )
    token, exp_s = sentinel.mint_model_surrogate(
        lease_id="lease_live_1", owner_id="ha1_ownerrenew000000000000000000", ttl_seconds=3600
    )
    assert exp_s == 1_003_600

    class _SentinelBridge:
        def mint_model_surrogate(
            self, *, lease_id: str, owner_id: str, ttl_seconds: int = 3600
        ) -> str:
            tok, _ = sentinel.mint_model_surrogate(
                lease_id=lease_id, owner_id=owner_id, ttl_seconds=ttl_seconds
            )
            return tok

        def delete_lease(self, lease_id: str) -> bool:
            sentinel.delete_lease(lease_id)
            return True

    deleted_claims: list[str] = []

    class _DummyClaimClient:
        def delete_claim(self, claim_name: str) -> None:
            deleted_claims.append(claim_name)

    mgr = SandboxEdgeGatewayManager(
        claim_client=_DummyClaimClient(),  # type: ignore[arg-type]
        master_seed=b"M" * 32,
        sentinel_control=_SentinelBridge(),
        idle_timeout_s=1800.0,
        clock_s=lambda: float(fake_now[0]),
    )
    owner_id = "ha1_ownerrenew000000000000000000"
    mgr._leases[owner_id] = ActiveOwnerLease(
        hushh_id=owner_id,
        lease_id="lease_live_1",
        claim_name="claim-live-1",
        sandbox_name="sbx-live-1",
        pod_ip="10.0.0.5",
        port=8080,
        pod_key_id="pk1",
        pod_public_key="pub1",
        last_activity_s=float(fake_now[0]),
        surrogate_expires_at_s=float(exp_s),
        active_ws_count=1,
    )

    # Advance 57 minutes (inside the 300s renewal window, with active_ws_count=1!)
    fake_now[0] = 1_003_420
    renewed = await mgr.ensure_owner_lease(owner_id)
    assert renewed.claim_name == "claim-live-1"
    assert deleted_claims == []
    assert renewed.surrogate_expires_at_s == float(1_003_420 + 3600)

    # Advance past the original 60m mark (65 minutes): original token is still valid!
    fake_now[0] = 1_003_900
    grant = sentinel.authorize_model_surrogate(token, client_ip="10.0.0.5")
    assert grant.surrogate_token == token


def test_information_discovery_projection_admits_paid_scopes() -> None:
    """Strict InformationDiscoveryProjection admits paidScopes alongside activeGrants for owner-feed sealing."""
    from hushh_mcp.services.pod_information_discovery import project_information_discovery

    out = project_information_discovery(
        {
            "operation": "active_grants",
            "activeGrants": [
                {
                    "scope": "attr.financial.accounts",
                    "requestId": "req_1",
                    "label": "Financial accounts",
                    "holderLabel": "KT",
                }
            ],
            "paidScopes": ["attr.financial.accounts", "attr.financial.transactions"],
        }
    )
    assert out["paidScopes"] == ["attr.financial.accounts", "attr.financial.transactions"]
    assert out["activeGrants"][0]["scope"] == "attr.financial.accounts"
