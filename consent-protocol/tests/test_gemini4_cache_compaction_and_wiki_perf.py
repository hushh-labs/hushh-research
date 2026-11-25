"""Contract and regression tests for Gemini 4 Hydrogen prefix caching, silent
compaction, token telemetry, 1-hop Wiki PKM recall, and ADK 2.15 safe tool retry.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_tool import BaseTool
from google.genai import types as genai_types

from hushh_mcp.one_adk import agui_turn_timing, chat_memory
from hushh_mcp.one_adk.agui_factory import build_authenticated_agui
from hushh_mcp.one_adk.mail_instruction import mail_admission_instruction
from hushh_mcp.one_adk.rolling_horizon import (
    OLD_TOOL_RESPONSE_KEEP_VERBATIM_TURNS,
    TOOL_COMPACT_CACHE_STEP_TURNS,
    compact_horizon_before_model,
)
from hushh_mcp.one_adk.tool_retry_plugin import SafeSchemaRetryToolPlugin
from hushh_mcp.one_adk.tool_scoping import (
    _is_tool_scoping_enabled,
    scope_leaf_tools_before_model,
)
from hushh_mcp.one_adk.wiki_recall_tools import execute_pod_wiki_tool
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from hushh_mcp.services.wiki_memory.index_and_search import (
    LexicalSearchIndex,
    tokenize_wiki_text,
)
from hushh_mcp.services.wiki_memory.library import WikiLibrary


class _StubTool(BaseTool):
    def __init__(self, tool_name: str) -> None:
        super().__init__(name=tool_name, description=tool_name)


def test_turn_timing_logs_gemini4_token_and_cache_counters_without_private_text(caplog) -> None:
    caplog.set_level(logging.INFO, logger=agui_turn_timing.logger.name)
    timing = agui_turn_timing.TurnTiming(head="one", run="12345678", started_at=0.0)
    token = agui_turn_timing._CURRENT_TURN.set(timing)
    req = SimpleNamespace(
        model="gemini-4-hydrogen",
        config=SimpleNamespace(
            system_instruction="secret system text",
            thinking_config=SimpleNamespace(thinking_level=SimpleNamespace(value="LOW")),
            tools=[
                genai_types.Tool(
                    function_declarations=[
                        genai_types.FunctionDeclaration(name="search_wiki", description="search"),
                        genai_types.FunctionDeclaration(name="read_wiki_page", description="read"),
                    ]
                )
            ],
        ),
        contents=[SimpleNamespace(parts=[SimpleNamespace(text="secret user message")])],
    )
    resp_1 = LlmResponse(
        partial=False,
        usage_metadata=genai_types.GenerateContentResponseUsageMetadata(
            prompt_token_count=26000,
            cached_content_token_count=24000,
            candidates_token_count=60,
            thoughts_token_count=120,
            total_token_count=26180,
        ),
    )
    resp_2 = LlmResponse(
        partial=False,
        usage_metadata=genai_types.GenerateContentResponseUsageMetadata(
            prompt_token_count=26500,
            cached_content_token_count=24500,
            candidates_token_count=90,
            thoughts_token_count=80,
            total_token_count=26670,
        ),
    )
    try:
        timing.begin_model_call(req)
        agui_turn_timing.timed_one_after_model(object(), resp_1)
        timing.begin_model_call(req)
        agui_turn_timing.timed_one_after_model(object(), resp_2)
        timing.log()
    finally:
        agui_turn_timing._CURRENT_TURN.reset(token)

    lines = [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("one_agent_chat_turn_complete ")
    ]
    assert len(lines) == 1
    line = lines[0]
    assert "prompt_tokens=52500" in line
    assert "cached_tokens=48500" in line
    assert "uncached_prompt_tokens=4000" in line
    assert "cache_hit_pct=92.4" in line
    assert "output_tokens=150" in line
    assert "thoughts_tokens=200" in line
    assert "total_tokens=52850" in line
    assert "tools_schema_hash=" in line and "tools_schema_hash=none" not in line
    assert "secret system text" not in line
    assert "secret user message" not in line


def test_chat_memory_avoids_redundant_serialization_and_reports_cache_metrics(monkeypatch) -> None:
    calls = 0
    real_estimate = chat_memory.estimate_request_tokens

    def _counting_estimate(req):
        nonlocal calls
        calls += 1
        return real_estimate(req)

    monkeypatch.setattr(chat_memory, "estimate_request_tokens", _counting_estimate)
    recorded: list[dict] = []
    monkeypatch.setattr(chat_memory, "_record_usage", recorded.append)

    session = SimpleNamespace(app_name="one", user_id="u1", id="s1", state={}, events=[])
    ctx = SimpleNamespace(invocation_id="inv-1", session=session, state={})
    req = LlmRequest(
        model="gemini-4-hydrogen",
        contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text="hi")])],
        config=genai_types.GenerateContentConfig(),
    )
    chat_memory.chat_memory_before_model(ctx, req)
    assert calls == 1, "within-budget turns must estimate request bytes once, not 4x"

    resp = LlmResponse(
        partial=False,
        usage_metadata=genai_types.GenerateContentResponseUsageMetadata(
            prompt_token_count=28000,
            cached_content_token_count=25760,
            candidates_token_count=75,
            thoughts_token_count=110,
            total_token_count=28185,
        ),
    )
    chat_memory.chat_memory_after_model(ctx, resp)
    assert recorded[-1]["tokenCountMethod"] == "provider_usage"
    assert recorded[-1]["inputTokens"] == 28000
    assert recorded[-1]["cachedTokens"] == 25760
    assert recorded[-1]["cacheHitPct"] == 92.0
    assert recorded[-1]["outputTokens"] == 75
    assert recorded[-1]["thoughtsTokens"] == 110


def _make_turn_with_large_tool(turn_idx: int) -> list[genai_types.Content]:
    big_items = [{"id": i, "text": "kyoto ryokan detail " * 8} for i in range(15)]
    return [
        genai_types.Content(
            role="user", parts=[genai_types.Part.from_text(text=f"turn {turn_idx} prompt")]
        ),
        genai_types.Content(
            role="model",
            parts=[
                genai_types.Part(
                    function_call=genai_types.FunctionCall(
                        id=f"c_{turn_idx}", name="list_recent_receipts", args={}
                    )
                )
            ],
        ),
        genai_types.Content(
            role="user",
            parts=[
                genai_types.Part(
                    function_response=genai_types.FunctionResponse(
                        id=f"c_{turn_idx}",
                        name="list_recent_receipts",
                        response={"status": "ok", "count": 15, "items": big_items},
                    )
                )
            ],
        ),
        genai_types.Content(
            role="model", parts=[genai_types.Part.from_text(text=f"turn {turn_idx} answer")]
        ),
    ]


def test_rolling_horizon_quantizes_tool_compaction_to_preserve_prefix_cache() -> None:
    # Build 6 turns with a large tool payload on Turn 2 (would previously mutate at Turn 6!)
    contents: list[genai_types.Content] = []
    contents.extend(
        [
            genai_types.Content(role="user", parts=[genai_types.Part.from_text(text="turn 1")]),
            genai_types.Content(role="model", parts=[genai_types.Part.from_text(text="ans 1")]),
        ]
    )
    contents.extend(_make_turn_with_large_tool(2))
    for i in range(3, 7):
        contents.extend(
            [
                genai_types.Content(
                    role="user", parts=[genai_types.Part.from_text(text=f"turn {i}")]
                ),
                genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text=f"ans {i}")]
                ),
            ]
        )

    req_t6 = LlmRequest(
        model="gemini-4-hydrogen", contents=[c.model_copy(deep=True) for c in contents]
    )
    compact_horizon_before_model(SimpleNamespace(state={}), req_t6)
    tool_resp_t6 = req_t6.contents[4].parts[0].function_response.response
    assert "compacted_historical_tool_output" not in tool_resp_t6
    assert tool_resp_t6["count"] == 15

    # Once conversation reaches the quantized epoch boundary (4 + 8 = 12 turns),
    # the first 8 turns compact cleanly in one batch.
    target_turns = OLD_TOOL_RESPONSE_KEEP_VERBATIM_TURNS + TOOL_COMPACT_CACHE_STEP_TURNS
    for i in range(7, target_turns + 1):
        contents.extend(
            [
                genai_types.Content(
                    role="user", parts=[genai_types.Part.from_text(text=f"turn {i}")]
                ),
                genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text=f"ans {i}")]
                ),
            ]
        )
    req_t12 = LlmRequest(
        model="gemini-4-hydrogen", contents=[c.model_copy(deep=True) for c in contents]
    )
    compact_horizon_before_model(SimpleNamespace(state={}), req_t12)
    tool_resp_t12 = req_t12.contents[4].parts[0].function_response.response
    assert tool_resp_t12.get("compacted_historical_tool_output") is True


def test_tool_scoping_defaults_off_on_gemini4_and_latches_monotonically_when_enabled(
    monkeypatch,
) -> None:
    monkeypatch.delenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", raising=False)
    monkeypatch.delenv("HUSHH_ONE_TOOL_SCOPING_DISABLED", raising=False)
    monkeypatch.setenv("HUSSH_POD_SENTINEL_MODEL_URL", "http://127.0.0.1:8082")
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    # Even on a Sentinel Pod, Gemini models keep static tool declarations by default.
    assert _is_tool_scoping_enabled("gemini-4-hydrogen") is False
    assert _is_tool_scoping_enabled("projects/p/locations/global/models/gemini-4-hydrogen") is False

    # When explicitly enabled, packs latch monotonically in state and are never evicted.
    monkeypatch.setenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", "1")
    core_padding = [f"core_tool_{i}" for i in range(25)]
    all_names = [*core_padding, "calendar_summary", "create_drive_file", "list_active_grants"]
    tool = genai_types.Tool(
        function_declarations=[
            genai_types.FunctionDeclaration(name=n, description=n) for n in all_names
        ]
    )
    state: dict = {}
    ctx = SimpleNamespace(state=state)

    req1 = LlmRequest(
        model="gemini-4-hydrogen",
        contents=[
            genai_types.Content(
                role="user", parts=[genai_types.Part.from_text(text="check my calendar tomorrow")]
            )
        ],
        config=genai_types.GenerateContentConfig(tools=[tool]),
        tools_dict={n: _StubTool(n) for n in all_names},
    )
    scope_leaf_tools_before_model(ctx, req1)
    assert "calendar" in state.get("active_tool_packs", [])
    assert "calendar_summary" in {d.name for d in req1.config.tools[0].function_declarations}

    # Topic shifts to unrelated general question: calendar pack remains latched (no eviction bust).
    req2 = LlmRequest(
        model="gemini-4-hydrogen",
        contents=[
            genai_types.Content(
                role="user", parts=[genai_types.Part.from_text(text="why does encryption matter?")]
            )
        ],
        config=genai_types.GenerateContentConfig(tools=[tool]),
        tools_dict={n: _StubTool(n) for n in all_names},
    )
    scope_leaf_tools_before_model(ctx, req2)
    assert "calendar_summary" in {d.name for d in req2.config.tools[0].function_declarations}


def test_mail_admission_supports_day_invariant_static_prefix() -> None:
    la = mail_admission_instruction(
        admitted=True, mailbox_changes=True, timezone="America/Los_Angeles", include_clock=False
    )
    ist = mail_admission_instruction(
        admitted=True, mailbox_changes=True, timezone="Asia/Kolkata", include_clock=False
    )
    assert la == ist
    assert "Today is " not in la


@pytest.mark.asyncio
async def test_wiki_search_stemming_synonyms_and_one_hop_claims_preview(tmp_path) -> None:
    tokens = tokenize_wiki_text("residence_and_relocation allergies flights wpg_0000000000000001")
    assert "residence" in tokens
    assert "relocation" in tokens
    assert "allergy" in tokens
    assert "flight" in tokens
    assert "wpg_0000000000000001" in tokens

    async def _noop() -> None:
        return None

    wiki = WikiLibrary(
        owner="usr_eval",
        key=b"\x42" * 32,
        store=FilesLocalStore(str(tmp_path)),
        check=_noop,
    )
    await wiki.register_source(
        {
            "source_id": "wsr_0000000000000001",
            "kind": "chat_turn",
            "locator": "eval://chat/1",
            "content_sha256": "a" * 64,
            "observed_at": "2026-10-01",
            "consent_derived": False,
        },
        idempotency_key="src_1",
    )
    await wiki.create_page(
        page_id="wpg_0000000000000003",
        title="nutrition_and_health",
        folder="topics",
        tldr="Dietary restrictions and allergies.",
        status_as_of="2026-10-15",
        body="Severe tree nut allergy (cashews, walnuts).",
        claims=[
            {
                "claim_id": "wcl_0000000000000010",
                "statement": "Severe allergy to tree nuts including cashews and walnuts.",
                "status": "active",
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-10-01",
            },
            {
                "claim_id": "wcl_0000000000000011",
                "statement": "Forgotten private note that must never leak.",
                "status": "active",
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-10-01",
            },
        ],
        idempotency_key="pg_3",
    )
    await wiki.put_tombstone(
        {
            "tombstone_id": "wtb_0000000000000001",
            "target_kind": "claim",
            "target_id": "wcl_0000000000000011",
            "reason_code": "owner_request",
            "created_at": 1760000001,
            "page_id": "wpg_0000000000000003",
        },
        idempotency_key="tb_1",
    )

    # Paraphrased zero-overlap query now hits via weighted synonym bridge AND returns 1-hop claims_preview
    res = await execute_pod_wiki_tool(
        wiki, "search_wiki", {"query": "food reaction ingredients dining", "limit": 5}
    )
    assert res["status"] == "ok"
    assert res["results"][0]["page_id"] == "wpg_0000000000000003"
    preview = res["results"][0].get("claims_preview") or []
    assert any("tree nuts" in c["statement"].lower() for c in preview)
    # Tombstoned claim must NEVER appear in claims_preview!
    assert all(c["claim_id"] != "wcl_0000000000000011" for c in preview)

    # read_wiki_page must ALSO redact tombstoned claim text from both claims and body!
    page_res = await execute_pod_wiki_tool(
        wiki, "read_wiki_page", {"page_id": "wpg_0000000000000003"}
    )
    assert "Forgotten private note" not in str(page_res)
    redacted_claim = next(c for c in page_res["claims"] if c["claim_id"] == "wcl_0000000000000011")
    assert redacted_claim["tombstoned"] is True
    assert redacted_claim["statement"] == "[removed by owner request]"

    # Confirm index still ranks exact matches higher than synonyms
    idx = LexicalSearchIndex()
    assert idx.query_candidates("nothing") == []


@pytest.mark.asyncio
async def test_safe_schema_retry_tool_plugin_only_retries_read_only_validation_errors() -> None:
    plugin = SafeSchemaRetryToolPlugin(max_retries=2)
    ctx = SimpleNamespace()

    # Read-only tool with validation error -> intercepted
    err = await plugin.extract_error_from_result(
        tool=_StubTool("search_wiki"),
        tool_args={"query": ""},
        tool_context=ctx,
        result={"status": "unavailable", "code": "invalid_wiki_request"},
    )
    assert err == {"error_code": "invalid_wiki_request", "status": "unavailable"}

    # Read-only tool with auth/vault refusal -> NOT retried
    assert (
        await plugin.extract_error_from_result(
            tool=_StubTool("search_wiki"),
            tool_args={"query": "x"},
            tool_context=ctx,
            result={"status": "unavailable", "code": "owner_device_required"},
        )
        is None
    )

    # Mutating/consent tool -> NEVER retried even on validation error
    for mutating in ("propose_information_request", "open_gmail_email_draft", "add_to_pkm"):
        assert (
            await plugin.extract_error_from_result(
                tool=_StubTool(mutating),
                tool_args={},
                tool_context=ctx,
                result={"status": "error", "code": "validation_error"},
            )
            is None
        )

    # Wired automatically into build_authenticated_agui
    from google.adk.agents import LlmAgent
    from google.adk.sessions import InMemorySessionService

    dummy_root = LlmAgent(name="one", model="gemini-4-hydrogen", instruction="hi")
    agui = build_authenticated_agui(
        dummy_root,
        InMemorySessionService(),
        app_name="test_retry_app",
        user_id_extractor=lambda _x: "u1",
    )
    assert any(isinstance(p, SafeSchemaRetryToolPlugin) for p in agui._app.plugins)


@pytest.mark.asyncio
async def test_post_turn_hook_runs_silently_without_failing_turn() -> None:
    called: list[tuple[str, str]] = []

    async def _hook(owner_id: str, conversation_id: str) -> None:
        called.append((owner_id, conversation_id))

    agent = agui_turn_timing.TimedADKAgent.__new__(agui_turn_timing.TimedADKAgent)
    agent.head = agui_turn_timing.HEAD_ONE
    agent.post_turn_hook = _hook
    token = agui_turn_timing._CURRENT_TURN_IDENTITY.set(("owner-1", "thread-1"))
    try:
        await agent._settle_post_turn()
    finally:
        agui_turn_timing._CURRENT_TURN_IDENTITY.reset(token)
    assert called == [("owner-1", "thread-1")]

    # Failing hook must be swallowed cleanly without breaking a completed turn.
    agent.post_turn_hook = AsyncMock(side_effect=RuntimeError("boom"))
    token = agui_turn_timing._CURRENT_TURN_IDENTITY.set(("owner-1", "thread-1"))
    try:
        await agent._settle_post_turn()
    finally:
        agui_turn_timing._CURRENT_TURN_IDENTITY.reset(token)
