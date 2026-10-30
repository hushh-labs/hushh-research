"""Profile drafts use real ADK task completion and never write owner memory."""

import copy
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr, ValidationError
from slowapi.errors import RateLimitExceeded

from api.middlewares.chat_key import require_vault_owner_chat_key
from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
from api.routes.one import profile_research as routes
from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
from hushh_mcp.one_adk.profile_research import (
    ProfileReport,
    ProfileSourceRef,
    profile_research_policy_fingerprint,
    run_profile_research,
)
from hushh_mcp.services import profile_research_service as service

SOURCE = "https://example.test/team/alex"
pytestmark = pytest.mark.usefixtures("shared_hub_owner")
OWNER_TOKEN = "fixture-owner-token"  # A fixture label, never a credential.
REPORT = {
    "match_status": "matched",
    "name": "Alex Example",
    "summary": "A public engineering profile.",
    "sections": [
        {
            "kind": "career",
            "facts": [
                {
                    "statement": "I work in engineering.",
                    "confidence": "supported",
                    "sources": [{"title": "Team", "url": SOURCE}],
                }
            ],
        }
    ],
}
FOLLOWUP_SOURCES = [
    {"title": "University", "url": "https://example.test/university/alex"},
    {"title": "Project", "url": "https://example.test/projects/alex"},
    {"title": "Event organizer", "url": "https://example.test/events/alex"},
]
ENRICHED_REPORT = {
    **REPORT,
    "sections": [
        {
            "kind": "career",
            "facts": [
                *REPORT["sections"][0]["facts"],
                {
                    "statement": "I built an open-source image classifier.",
                    "confidence": "supported",
                    "sources": [FOLLOWUP_SOURCES[1]],
                },
            ],
        },
        {
            "kind": "education",
            "facts": [
                {
                    "statement": "I studied computer science at Example University.",
                    "confidence": "supported",
                    "sources": [FOLLOWUP_SOURCES[0]],
                }
            ],
        },
        {
            "kind": "personal",
            "facts": [
                {
                    "statement": "I organized a campus hackathon in 2025.",
                    "confidence": "supported",
                    "sources": [FOLLOWUP_SOURCES[2]],
                }
            ],
        },
    ],
}


@pytest.mark.parametrize("status", ["matched", "uncertain", "no_match"])
async def test_single_discovery_preserves_research_without_score_or_threshold(status):
    from hushh_mcp.one_adk.profile_research import run_profile_discovery

    report = {**REPORT, "match_status": status}
    if status == "no_match":
        report["sections"] = []
    research = AsyncMock(return_value={"report": report, "search_suggestions": []})
    charge = AsyncMock()
    identity = {
        "full_name": "Alex Example",
        "email": "alex@example.test",
        "phone_number": "+15555550123",
    }
    result = await run_profile_discovery(
        identity=identity,
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
        researcher=research,
        on_attempts_start=charge,
    )
    assert result == {"report": report, "search_suggestions": []}
    assert "verification" not in result
    research.assert_awaited_once()
    charge.assert_awaited_once_with((1,))
    assert research.await_args.kwargs["identity"] == identity
    assert (
        research.await_args.kwargs["exact_query"]
        == '"Alex Example" "alex@example.test" "+15555550123"'
    )
    assert research.await_args.kwargs["search_limit"] == 1


@pytest.mark.parametrize("missing", ["email", "phone_number"])
async def test_single_discovery_never_substitutes_missing_owner_fields(missing):
    from hushh_mcp.one_adk.profile_research import exact_identity_query, run_profile_discovery

    identity = {
        "full_name": "Alex Example",
        "email": "alex@example.test",
        "phone_number": "+15555550123",
    }
    identity[missing] = None
    research = AsyncMock(return_value={"report": REPORT, "search_suggestions": []})
    await run_profile_discovery(
        identity=identity,
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
        researcher=research,
    )
    expected = {key: value for key, value in identity.items() if value is not None}
    research.assert_awaited_once()
    assert research.await_args.kwargs["identity"] == expected
    assert research.await_args.kwargs["exact_query"] == exact_identity_query(expected)


async def test_single_discovery_failure_and_consumed_slot_never_repeat_research():
    from hushh_mcp.one_adk.profile_research import run_profile_discovery

    research = AsyncMock(side_effect=RuntimeError("fixture source unavailable"))
    args = dict(
        identity={"full_name": "Alex Example"},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
        researcher=research,
    )
    terminal = {"status": "unavailable", "retry_exhausted": True, "attempts": 1}
    assert await run_profile_discovery(**args) == terminal
    assert await run_profile_discovery(**args, attempts_used=(1,)) == terminal
    research.assert_awaited_once()
    research.side_effect = PermissionError("Owner session ended")
    with pytest.raises(PermissionError):
        await run_profile_discovery(**args)


@pytest.mark.parametrize(
    "changed",
    ["research_instruction", "search_description", "output_cap", "resolved_model", "search_limit"],
)
def test_cached_policy_tracks_active_research_not_unrelated_one_copy(monkeypatch, changed):
    from hushh_mcp.one_adk import agent_tree, profile_research

    manifest = agent_tree._ONE_MANIFEST
    original = profile_research_policy_fingerprint()
    monkeypatch.setattr(
        agent_tree,
        "_ONE_MANIFEST",
        manifest.model_copy(update={"system_instruction": "New head copy"}),
    )
    assert profile_research_policy_fingerprint() == original
    children = []
    for child in manifest.subagents:
        if changed == "research_instruction" and child.id == "one_profile_research":
            child = child.model_copy(
                update={"system_instruction": child.system_instruction + "\nNew coverage"}
            )
        elif changed == "search_description" and child.id == "google_search":
            child = child.model_copy(update={"description": child.description + " New description"})
        elif changed == "output_cap" and child.id == "one_profile_research":
            child = child.model_copy(
                update={
                    "performance": child.performance.model_copy(update={"max_output_tokens": 2048})
                }
            )
        children.append(child)
    monkeypatch.setattr(
        agent_tree, "_ONE_MANIFEST", manifest.model_copy(update={"subagents": children})
    )
    if changed == "resolved_model":
        monkeypatch.setattr(
            "hushh_mcp.runtime_providers.gemini_config.resolve_fleet_model_name",
            lambda name: "gemini-other",
        )
    elif changed == "search_limit":
        monkeypatch.setattr(profile_research, "MAX_SEARCH_ATTEMPTS", 3)
    assert profile_research_policy_fingerprint() != original


@pytest.mark.parametrize(
    "changed",
    [
        "request_dropped_phone",
        "receipt_dropped_phone",
        "receipt_dropped_local_part",
        "missing_receipt",
        "none",
    ],
)
async def test_full_contacts_reach_search_child_and_internal_reformulation_is_allowed(
    monkeypatch, changed
):
    from hushh_mcp.one_adk.profile_research import exact_identity_query

    identity = {
        "full_name": "Alex Example",
        "email": "alex@example.test",
        "phone_number": "+15555550123",
    }
    query = exact_identity_query(identity)
    request = query.replace(' "+15555550123"', "") if changed == "request_dropped_phone" else query
    observed = query
    if changed == "receipt_dropped_phone":
        observed = query.replace("+15555550123", "15555550123")
    if changed == "receipt_dropped_local_part":
        observed = query.replace("alex@example.test", "example.test")
    model = ProfileModel(
        query_request=request,
        observed_queries=[] if changed == "missing_receipt" else [observed],
        search_evidence=changed != "missing_receipt",
        no_match=changed == "missing_receipt",
    )
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda _: model
    )
    invoke = run_profile_research(
        identity=identity,
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
        search_limit=1,
        exact_query=query,
        include_evidence=True,
    )
    if changed in {"request_dropped_phone", "missing_receipt"}:
        with pytest.raises((ValueError, SpecialistAdkTurnError)):
            await invoke
        if changed == "request_dropped_phone":
            assert len(model._requests) == 1  # Refused before Search dispatch.
    else:
        result = await invoke
        assert result["report"] == REPORT and len(model._requests) == 3
        child = model._requests[1]
        assert child.contents[-1].parts[0].text == query
        assert any(tool.google_search is not None for tool in child.config.tools)
        # Exact identifiers must not strip the research intent at the child hop.
        # Otherwise Search receives a bare contact intersection instead of a
        # profile question, and can return no-match despite public name evidence.
        search_instruction = str(child.config.system_instruction)
        assert "Treat the identifiers as identity anchors, not a required conjunction" in (
            search_instruction
        )
        assert "roles, education, projects, competitions and public leadership" in (
            search_instruction
        )
        assert "Do not require the email or phone to be published" in search_instruction
    assert OWNER_TOKEN not in repr(model._requests)


@pytest.fixture(autouse=True)
def research_cohort(monkeypatch):
    monkeypatch.setattr(service, "magic_intelligence_saved", AsyncMock(return_value=False))
    monkeypatch.setattr(
        "hushh_mcp.services.actor_identity_service.ActorIdentityService.get_many",
        AsyncMock(return_value={"owner": {"phone_number": "+15555550123", "phone_verified": True}}),
    )
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "2")
    monkeypatch.setenv(
        "ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS",
        "alex@example.test,person@hushh.ai,owner@gmail.com,person@company.test",
    )


class ProfileModel(BaseLlm):
    _calls: int = PrivateAttr(default=0)
    _requests: list = PrivateAttr(default_factory=list)
    _cited_url: str = PrivateAttr(default=SOURCE)
    _no_match: bool = PrivateAttr(default=False)
    _search_evidence: bool = PrivateAttr(default=True)
    _recover_after_refusal: bool = PrivateAttr(default=False)
    _refuse_followup: bool = PrivateAttr(default=False)
    _parallel_tool: str | None = PrivateAttr(default=None)
    _repeat_search: bool = PrivateAttr(default=False)
    _enrich: bool = PrivateAttr(default=False)
    _followup_grounded: bool = PrivateAttr(default=True)
    _root_only_grounding: bool = PrivateAttr(default=False)
    _extra_sources: int = PrivateAttr(default=0)
    _forced_ref: str | None = PrivateAttr(default=None)
    _query_request: str | None = PrivateAttr(default=None)
    _observed_queries: list[str] | None = PrivateAttr(default=None)

    def __init__(
        self,
        cited_url=SOURCE,
        *,
        no_match=False,
        search_evidence=True,
        recover_after_refusal=False,
        refuse_followup=False,
        parallel_tool=None,
        repeat_search=False,
        enrich=False,
        followup_grounded=True,
        root_only_grounding=False,
        extra_sources=0,
        forced_ref=None,
        query_request=None,
        observed_queries=None,
    ):
        super().__init__(model="gemini-fixture")
        self._cited_url = cited_url
        self._no_match = no_match
        self._search_evidence = search_evidence
        self._recover_after_refusal = recover_after_refusal
        self._refuse_followup = refuse_followup
        self._parallel_tool = parallel_tool
        self._repeat_search = repeat_search
        self._enrich = enrich
        self._followup_grounded = followup_grounded
        self._root_only_grounding = root_only_grounding
        self._extra_sources = extra_sources
        self._forced_ref = forced_ref
        self._query_request = query_request
        self._observed_queries = observed_queries

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request)
        self._calls += 1
        followup = (
            self._recover_after_refusal
            or self._refuse_followup
            or self._repeat_search
            or self._enrich
        )
        if self._parallel_tool and self._calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="google_search",
                                args={"request": "Alex Example public profile"},
                            )
                        ),
                        types.Part(
                            function_call=types.FunctionCall(
                                name=self._parallel_tool,
                                args=REPORT
                                if self._parallel_tool == "finish_task"
                                else {"request": "Alex Example career"},
                            )
                        ),
                    ],
                )
            )
        elif (
            self._calls == 1
            or (followup and self._calls == 3)
            or (self._repeat_search and self._calls == 5)
        ):
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="google_search",
                                args={
                                    "request": self._query_request
                                    or "Public professional profile of Alex Example"
                                },
                            )
                        )
                    ],
                )
            )
        elif self._calls == 2 or (followup and self._calls == 4):
            refused = (self._recover_after_refusal and self._calls == 2) or (
                self._refuse_followup and self._calls == 4
            )
            sources = (
                FOLLOWUP_SOURCES
                if self._enrich and self._calls == 4
                else [{"title": "Team", "url": SOURCE}]
            )
            if self._enrich and self._calls == 4 and not self._followup_grounded:
                sources = sources[1:]
            sources = [
                *sources,
                *[
                    {"title": f"Extra {index}", "url": f"https://example.test/extra/{index}"}
                    for index in range(self._extra_sources)
                ],
            ]
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_text(
                            text="Search was unavailable."
                            if refused
                            else "No reliable match."
                            if self._no_match
                            else "Engineering profile [1]."
                        )
                    ],
                ),
                grounding_metadata=types.GroundingMetadata(
                    web_search_queries=(
                        self._observed_queries
                        if self._observed_queries is not None
                        else ["Synthetic Alex Example profile"]
                    )
                    if self._search_evidence and not refused
                    else [],
                    grounding_chunks=[
                        types.GroundingChunk(
                            web=types.GroundingChunkWeb(uri=source["url"], title=source["title"])
                        )
                        for source in sources
                    ]
                    if not self._no_match and not refused
                    else [],
                ),
            )
        else:
            report = {
                **REPORT,
                "sections": [
                    {
                        "kind": "career",
                        "facts": [
                            {
                                **REPORT["sections"][0]["facts"][0],
                                "sources": [{"title": "Team", "url": self._cited_url}],
                            }
                        ],
                    }
                ],
            }
            if self._no_match:
                report = {
                    **REPORT,
                    "match_status": "no_match",
                    "summary": "No reliable match.",
                    "sections": [],
                }
            elif self._enrich:
                report = ENRICHED_REPORT
            refs = {
                source["title"]: source["ref"]
                for content in llm_request.contents or []
                for part in content.parts or []
                if part.function_response and part.function_response.name == "google_search"
                for source in part.function_response.response.get("sources", [])
            }
            report = {
                **report,
                "sections": [
                    {
                        **section,
                        "facts": [
                            {
                                **fact,
                                "sources": [
                                    {
                                        "title": source["title"],
                                        "ref": self._forced_ref
                                        or (
                                            refs.get(source["title"], "s999")
                                            if self._cited_url == SOURCE
                                            else "s2"
                                            if self._root_only_grounding
                                            else "s999"
                                        ),
                                    }
                                    for source in fact["sources"]
                                ],
                            }
                            for fact in section["facts"]
                        ],
                    }
                    for section in report["sections"]
                ],
            }
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(name="finish_task", args=report)
                        )
                    ],
                ),
                grounding_metadata=types.GroundingMetadata(
                    grounding_chunks=[
                        types.GroundingChunk(
                            web=types.GroundingChunkWeb(uri=self._cited_url, title="Team")
                        )
                    ]
                )
                if self._root_only_grounding
                else None,
            )


@pytest.mark.parametrize("invented", [False, True])
async def test_real_task_runner_uses_structured_output_and_grounded_sources(monkeypatch, invented):
    model = ProfileModel("https://invented.test/profile" if invented else SOURCE)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    checks = []

    async def require_access():
        checks.append(True)

    async def run():
        return await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=require_access,
        )

    if invented:
        with pytest.raises(ValueError, match="grounding receipt"):
            await run()
    else:
        result = await run()
        assert result["report"] == REPORT
        assert result["search_suggestions"] == []
    assert model._calls == 3 and len(checks) >= 7
    # Both the root and its Search child must honor the bounded task policy;
    # leaving this absent silently selects the provider's thinking default.
    for request in model._requests:
        assert request.config.thinking_config.thinking_level == types.ThinkingLevel.LOW
        assert request.config.max_output_tokens == 4096
    assert "fixture-owner-token" not in repr(model._requests)
    responses = [
        part.function_response
        for content in model._requests[-1].contents or []
        for part in content.parts or []
        if part.function_response
    ]
    assert any(
        row.name == "google_search"
        and row.response.get("search_performed") is True
        and row.response.get("sources") == [{"title": "Team", "ref": "s1"}]
        for row in responses
    )


@pytest.mark.parametrize(
    "url,accepted",
    [
        (
            "https://vertexaisearch.cloud.google.com/grounding-api-redirect/" + "Opaque0-_" * 100,
            True,
        ),
        ("http://example.test/team/alex", False),
        ("https://fixture:fixture@example.test/team/alex", False),
    ],
)
async def test_source_refs_resolve_exact_receipts_without_changing_facts(
    monkeypatch, url, accepted
):
    expected = copy.deepcopy(REPORT)
    expected["sections"][0]["facts"][0]["sources"][0]["url"] = url
    monkeypatch.setattr(sys.modules[__name__], "SOURCE", url)
    monkeypatch.setattr(sys.modules[__name__], "REPORT", expected)
    model = ProfileModel(url)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    invoke = run_profile_research(
        identity={"full_name": "Alex Example", "email": None, "phone_number": None},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
    )
    if accepted:
        assert (await invoke)["report"] == expected
    else:
        with pytest.raises(ValidationError, match="HTTPS link"):
            await invoke


async def test_parent_only_metadata_cannot_mint_a_selectable_source_ref(monkeypatch):
    model = ProfileModel("https://example.test/root-only", root_only_grounding=True)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    with pytest.raises(ValueError, match="grounding receipt"):
        await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=AsyncMock(),
        )
    assert model._calls == 3


def test_internal_citation_contract_rejects_raw_url_fallback():
    report = copy.deepcopy(REPORT)
    report["sections"][0]["facts"][0]["sources"][0]["ref"] = "s1"
    with pytest.raises(ValidationError, match="Extra inputs"):
        ProfileReport[ProfileSourceRef].model_validate(report)


async def test_unexposed_receipts_cannot_be_selected_by_guessing_a_ref(monkeypatch):
    model = ProfileModel(extra_sources=20, forced_ref="s21")
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    with pytest.raises(ValueError, match="grounding receipt"):
        await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=AsyncMock(),
        )
    assert model._calls == 3


async def test_a_public_search_follow_up_recovers_without_more_than_five_model_calls(monkeypatch):
    model = ProfileModel(recover_after_refusal=True)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    result = await run_profile_research(
        identity={
            "full_name": "Alex Example",
            "email": "alex@example.test",
            "phone_number": "+15555550123",
        },
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=admitted,
    )
    assert result["report"] == REPORT
    assert model._calls == 5
    # Search's follow-up consumes the remaining read budget. The final model
    # request still owns the report, but may only finish, not research forever.
    final_policy = model._requests[-1].config.tool_config.function_calling_config
    assert final_policy.mode == types.FunctionCallingConfigMode.ANY
    assert final_policy.allowed_function_names == ["finish_task"]
    responses = [
        part.function_response
        for request in (model._requests[2], model._requests[4])
        for content in request.contents or []
        for part in content.parts or []
        if part.function_response and part.function_response.name == "google_search"
    ]
    # The first refused/offline answer remains unavailable, not a no-match finding.
    assert responses[0].response["search_performed"] is False
    assert responses[0].response["sources"] == []
    assert responses[-1].response["search_performed"] is True
    assert responses[-1].response["sources"] == [{"title": "Team", "ref": "s1"}]
    assert responses[-1].response["searches_remaining"] == 0


@pytest.mark.parametrize("followup_grounded", [True, False])
async def test_coverage_followup_preserves_both_passes_and_rejects_uncited_enrichment(
    monkeypatch, followup_grounded
):
    model = ProfileModel(enrich=True, followup_grounded=followup_grounded)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    invoke = run_profile_research(
        identity={"full_name": "Alex Example", "email": None, "phone_number": None},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=AsyncMock(),
    )
    if followup_grounded:
        assert (await invoke)["report"] == ENRICHED_REPORT
    else:
        with pytest.raises(ValueError, match="grounding receipt"):
            await invoke
    assert model._calls == 5
    responses = [
        part.function_response.response
        for content in model._requests[-1].contents or []
        for part in content.parts or []
        if part.function_response and part.function_response.name == "google_search"
    ]
    assert responses[0]["sources"] == [{"title": "Team", "ref": "s1"}]
    assert responses[1]["sources"] == [
        {"title": source["title"], "ref": f"s{index + 2}"}
        for index, source in enumerate(
            FOLLOWUP_SOURCES if followup_grounded else FOLLOWUP_SOURCES[1:]
        )
    ]
    assert responses[1]["searches_remaining"] == 0
    assert model._requests[
        -1
    ].config.tool_config.function_calling_config.allowed_function_names == ["finish_task"]


@pytest.mark.parametrize("parallel_tool", ["google_search", "finish_task"])
async def test_parallel_tools_are_rejected_before_search_receipts_can_mix(
    monkeypatch, parallel_tool
):
    model = ProfileModel(parallel_tool=parallel_tool)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    with pytest.raises(SpecialistAdkTurnError) as failed:
        await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=admitted,
        )
    assert isinstance(failed.value.__cause__, ValueError)
    assert str(failed.value.__cause__) == "Profile research tools must run sequentially"
    assert failed.value.partial_turn.tool_results == ()
    assert model._calls == 1


async def test_search_stops_after_one_followup_within_the_model_budget(monkeypatch):
    model = ProfileModel(no_match=True, repeat_search=True)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    with pytest.raises(SpecialistAdkTurnError) as failed:
        await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=admitted,
        )
    assert isinstance(failed.value.__cause__, ValueError)
    assert str(failed.value.__cause__) == "Profile research allows only one Search follow-up"
    assert model._calls == 5


@pytest.mark.parametrize("no_match", [False, True])
async def test_offline_followup_does_not_borrow_the_previous_search_receipt(monkeypatch, no_match):
    model = ProfileModel(no_match=no_match, refuse_followup=True)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    invoke = run_profile_research(
        identity={"full_name": "Alex Example", "email": None, "phone_number": None},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=admitted,
    )
    if no_match:
        # A failed broader search cannot establish that no public profile exists.
        with pytest.raises(ValueError, match="Search execution receipt"):
            await invoke
    else:
        # Supported findings from a completed search remain usable as a partial draft.
        assert (await invoke)["report"] == REPORT
    assert model._calls == 5
    responses = [
        part.function_response
        for content in model._requests[-1].contents or []
        for part in content.parts or []
        if part.function_response and part.function_response.name == "google_search"
    ]
    assert responses[0].response["search_performed"] is True
    assert responses[-1].response["search_performed"] is False
    assert responses[-1].response["sources"] == []


@pytest.mark.parametrize("search_evidence", [True, False])
async def test_empty_search_is_valid_but_refusal_without_search_is_not_absence(
    monkeypatch, search_evidence
):
    model = ProfileModel(no_match=True, search_evidence=search_evidence)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    invoke = run_profile_research(
        identity={"full_name": "Alex Example", "email": None, "phone_number": None},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=admitted,
    )
    if search_evidence:
        result = await invoke
        assert result["report"]["match_status"] == "no_match"
        assert result["report"]["sections"] == []
    else:
        with pytest.raises(ValueError, match="Search execution receipt"):
            await invoke


async def test_personal_profile_admission_does_not_depend_on_business_discovery(monkeypatch):
    from firebase_admin import auth as firebase_auth

    from hushh_mcp.services import business_suggestion_service, one_owner_admission

    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "false")
    monkeypatch.setenv("ONE_BUSINESS_LOCAL_REHEARSAL_ENABLED", "false")

    def business_must_not_run(*args, **kwargs):
        pytest.fail("Personal profile research must not use business discovery or admission")

    for name in (
        "_lookup_identity",
        "_setup_resolved",
        "lookup_directory",
        "get_pool",
        "get_firebase_auth_app",
    ):
        monkeypatch.setattr(business_suggestion_service, name, business_must_not_run)
    connection = SimpleNamespace(
        fetchrow=AsyncMock(return_value={"setup_completed": True, "vault_status": "active"})
    )
    lease = MagicMock()
    lease.__aenter__ = AsyncMock(return_value=connection)
    lease.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(
        one_owner_admission,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda: lease)),
    )
    monkeypatch.setattr(one_owner_admission, "get_firebase_auth_app", lambda: object())
    identity = SimpleNamespace(
        uid="owner",
        disabled=False,
        display_name="Alex Example",
        email="alex@example.test",
        email_verified=True,
        phone_number="+15555550123",
    )
    monkeypatch.setattr(firebase_auth, "get_user", lambda uid, *, app: identity)

    async def admitted(*args):
        return object()

    async def researcher(**kwargs):
        assert kwargs["identity"]["full_name"] == identity.display_name
        return {"report": REPORT, "search_suggestions": []}

    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
    )
    assert result["status"] == "offered" and result["pkm_written"] is False
    assert [section["kind"] for section in result["report"]["sections"]] == ["career"]
    connection.fetchrow.assert_awaited_once_with(
        "SELECT setup_completed, vault_status FROM vault_keys WHERE user_id = $1 LIMIT 1",
        "owner",
        timeout=5,
    )


async def test_current_owner_identifiers_only_and_no_persistence(monkeypatch, caplog):
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    calls = []

    async def researcher(**kwargs):
        calls.append(kwargs)
        await kwargs["require_access"]()
        return {"report": REPORT, "search_suggestions": []}

    async def admitted(*args):
        return object()

    async def complete(*args):
        return True

    identity = SimpleNamespace(
        uid="owner",
        disabled=False,
        display_name="Alex Example",
        email="alex@example.test",
        email_verified=True,
        phone_number="+15555550123",
    )
    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=lambda uid: identity,
    )
    assert result["pkm_written"] is False and result["status"] == "offered"
    assert calls[0]["identity"] == {
        "full_name": identity.display_name,
        "email": identity.email,
        "phone_number": identity.phone_number,
    }
    assert identity.email not in caplog.text and identity.phone_number not in caplog.text
    # A previously admitted owner loses access when the primary email is unverified.
    identity.email_verified = False
    denied = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=lambda uid: identity,
    )
    assert denied == {"status": "disabled", "pkm_written": False}
    assert len(calls) == 1


@pytest.mark.parametrize(
    "shadow_name,phone_verified",
    [("Alex Example", True), ("Alex Example", False), ("x" * 161, True), ("Alex\nExample", True)],
)
async def test_canonical_onboarding_name_fallback_keeps_contact_verification(
    monkeypatch, shadow_name, phone_verified
):
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    calls = []

    async def identities(self, ids):
        assert ids == ["owner"]
        return {
            "owner": {
                "display_name": shadow_name,
                "email": "shadow@example.test",
                "email_verified": True,
                "phone_number": "+15555550123",
                "phone_verified": phone_verified,
            }
        }

    monkeypatch.setattr(
        "hushh_mcp.services.actor_identity_service.ActorIdentityService.get_many", identities
    )

    async def admitted(*args):
        return object()

    async def complete(*args):
        return True

    async def researcher(**kwargs):
        calls.append(kwargs["identity"])
        return {"report": REPORT, "search_suggestions": []}

    record = SimpleNamespace(
        uid="owner",
        disabled=False,
        display_name=None,
        email="alex@example.test",
        email_verified=True,
        # A stale provider phone must not override the current verified binding.
        phone_number="+15555550999",
    )
    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=lambda uid: record,
    )
    if shadow_name == "Alex Example":
        assert result["status"] == "offered"
        assert calls == [
            {
                "full_name": shadow_name,
                "email": "alex@example.test",
                "phone_number": "+15555550123" if phone_verified else None,
            }
        ]
    else:
        assert result == {"status": "insufficient_identity", "pkm_written": False}
        assert calls == []


@pytest.mark.parametrize(
    "condition",
    [
        "disabled",
        "not_ready",
        "wrong_owner",
        "revoked",
        "kill_inflight",
        "phone_changed",
        "name_changed",
        "hosting_changed",
    ],
)
async def test_no_draft_crosses_an_ineligible_or_changed_owner_boundary(
    monkeypatch, condition, shared_hub_owner
):
    monkeypatch.setenv(
        "ONE_PROFILE_RESEARCH_ENABLED", "false" if condition == "disabled" else "true"
    )
    live = True
    changed = False
    calls = []

    async def admitted(*args):
        return object() if live else None

    async def complete(*args):
        return condition != "not_ready"

    def identity(uid):
        calls.append("identity")
        return SimpleNamespace(
            uid="other" if condition == "wrong_owner" else uid,
            disabled=False,
            display_name="Alex Changed"
            if changed and condition == "name_changed"
            else "Alex Example",
            email="alex@example.test",
            email_verified=True,
            phone_number="+15555550124"
            if changed and condition == "phone_changed"
            else "+15555550123",
        )

    async def researcher(**kwargs):
        nonlocal live, changed
        calls.append("research")
        if condition == "revoked":
            live = False
        if condition == "kill_inflight":
            monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "false")
        if condition == "hosting_changed":
            shared_hub_owner.return_value = "byoc"
            await kwargs["require_access"]()
        if condition in {"phone_changed", "name_changed"}:
            changed = True
        if condition == "phone_changed":
            monkeypatch.setattr(
                "hushh_mcp.services.actor_identity_service.ActorIdentityService.get_many",
                AsyncMock(return_value={"owner": {"phone_number": None, "phone_verified": False}}),
            )
        return {"report": REPORT, "search_suggestions": []}

    invoke = service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=identity,
    )
    if condition in {"wrong_owner", "revoked"}:
        with pytest.raises(PermissionError):
            await invoke
    elif condition == "hosting_changed":
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as error:
            await invoke
        assert error.value.status_code == 409
    else:
        result = await invoke
        assert result == {
            "status": "not_ready" if condition == "not_ready" else "disabled",
            "pkm_written": False,
        }
    if condition in {"disabled", "not_ready", "wrong_owner"}:
        assert "research" not in calls
    if condition == "disabled":
        assert "identity" not in calls


@pytest.mark.parametrize(
    "change",
    ["excluded", "phone_only", "phase_off", "email", "verification", "disabled", "failure"],
)
async def test_magic_cohort_blocks_research_and_withdraws_changed_identity(monkeypatch, change):
    from hushh_mcp.services.magic_intelligence_admission import PILOT_EMAIL

    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    record = SimpleNamespace(
        uid="owner",
        disabled=False,
        email_verified=True,
        email=PILOT_EMAIL,
        display_name="Pilot",
        phone_number="+15555550123",
    )
    if change == "excluded":
        record.email = "other@example.test"
    if change == "phone_only":
        record.email_verified = False
    lookups = []

    def lookup(uid):
        lookups.append(uid)
        if change == "failure" and len(lookups) == 2:
            raise RuntimeError("identity lookup failed")
        return record

    async def research(**kwargs):
        if change == "phase_off":
            monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "0")
        elif change == "email":
            # The second email is also admitted in phase 2; results still belong
            # to the exact initial identity, not whichever account is current.
            monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "2")
            record.email = "alex@example.test"
        elif change == "verification":
            record.email_verified = False
        elif change == "disabled":
            record.disabled = True
        return {"report": REPORT, "search_suggestions": []}

    researcher = AsyncMock(side_effect=research)
    invoke = service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=AsyncMock(return_value=object()),
        setup_check=AsyncMock(return_value=True),
        identity_lookup=lookup,
    )
    if change == "failure":
        with pytest.raises(RuntimeError, match="identity lookup failed"):
            await invoke
    else:
        assert await invoke == {"status": "disabled", "pkm_written": False}
    assert researcher.await_count == (0 if change in {"excluded", "phone_only"} else 1)


@pytest.mark.parametrize("phase", ["1", "5"])
async def test_pilot_or_general_uat_research_works_without_business_or_team_roster(
    monkeypatch, phase
):
    from hushh_mcp.services.magic_intelligence_admission import PILOT_EMAIL

    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", phase)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS", "")
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "false")
    identity = MagicMock(
        return_value=SimpleNamespace(
            uid="owner",
            disabled=False,
            email_verified=True,
            email=PILOT_EMAIL if phase == "1" else "new-owner@example.test",
            display_name="Pilot",
            phone_number="+15555550123",
        )
    )
    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        owner_check=AsyncMock(return_value=object()),
        setup_check=AsyncMock(return_value=True),
        identity_lookup=identity,
        researcher=AsyncMock(return_value={"report": REPORT, "search_suggestions": []}),
    )
    assert result["status"] == "offered"
    assert identity.call_count == 2


@pytest.mark.parametrize("completion", ["saved", "other_device", "unavailable"])
async def test_saved_personal_offer_suppresses_paid_or_inflight_research(monkeypatch, completion):
    from hushh_mcp.services.magic_intelligence_admission import PILOT_EMAIL

    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    identity = MagicMock(
        return_value=SimpleNamespace(
            uid="owner",
            disabled=False,
            email_verified=True,
            email=PILOT_EMAIL,
            display_name="Pilot",
            phone_number="+15555550123",
        )
    )
    researcher = AsyncMock(return_value={"report": REPORT, "search_suggestions": []})
    saved = AsyncMock(
        side_effect=(
            RuntimeError("completion unavailable")
            if completion == "unavailable"
            else [True]
            if completion == "saved"
            else [False, True]
        )
    )
    invoke = service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        owner_check=AsyncMock(return_value=object()),
        setup_check=AsyncMock(return_value=True),
        identity_lookup=identity,
        researcher=researcher,
        saved_check=saved,
    )
    if completion == "unavailable":
        with pytest.raises(RuntimeError):
            await invoke
    else:
        assert await invoke == {"status": "saved", "pkm_written": False}
    assert researcher.await_count == (1 if completion == "other_device" else 0)


@pytest.mark.parametrize("withdrawal", ["phase", "feature"])
async def test_withdrawal_during_final_completion_read_never_releases_report(
    monkeypatch, withdrawal
):
    from hushh_mcp.services.magic_intelligence_admission import PILOT_EMAIL

    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    calls = 0

    async def saved_check(_owner):
        nonlocal calls
        calls += 1
        if calls == 2:
            monkeypatch.setenv(
                "ONE_MAGIC_INTELLIGENCE_PHASE"
                if withdrawal == "phase"
                else "ONE_PROFILE_RESEARCH_ENABLED",
                "0" if withdrawal == "phase" else "false",
            )
        return False

    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        owner_check=AsyncMock(return_value=object()),
        setup_check=AsyncMock(return_value=True),
        identity_lookup=MagicMock(
            return_value=SimpleNamespace(
                uid="owner",
                disabled=False,
                email_verified=True,
                email=PILOT_EMAIL,
                display_name="Pilot",
                phone_number="+15555550123",
            )
        ),
        researcher=AsyncMock(return_value={"report": REPORT, "search_suggestions": []}),
        saved_check=saved_check,
    )
    assert calls == 2
    assert result == {"status": "disabled", "pkm_written": False}


def test_report_rejects_duplicate_sections_no_match_findings_and_unsafe_sources():
    for report in (
        {**REPORT, "sections": REPORT["sections"] * 2},
        {**REPORT, "match_status": "no_match"},
        {
            **REPORT,
            "sections": [
                {
                    "kind": "personal",
                    "facts": [
                        {
                            **REPORT["sections"][0]["facts"][0],
                            "sources": [{"title": "Unsafe", "url": "javascript:alert(1)"}],
                        }
                    ],
                }
            ],
        },
    ):
        with pytest.raises(ValidationError):
            ProfileReport.model_validate(report)


@pytest.fixture
def route_app(monkeypatch):

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }
    monkeypatch.setattr(limiter, "enabled", False)
    return app


def test_route_ignores_client_identity_and_denies_before_research(monkeypatch, route_app):

    app = route_app
    seen = []

    async def research(**kwargs):
        seen.append(kwargs)
        return {
            "status": "offered",
            "pkm_written": False,
            "report": REPORT,
            "search_suggestions": [],
        }

    monkeypatch.setattr(routes, "offer_profile_research", research)
    response = TestClient(app).post(
        "/api/one/profile-research", json={"user_id": "other", "full_name": "Wrong Person"}
    )
    assert response.status_code == 200 and seen == [
        {"user_id": "owner", "consent_token": "fixture-token"}
    ]
    assert response.headers["cache-control"] == "private, no-store"

    def denied():
        raise HTTPException(status_code=401, detail="Sign in")

    app.dependency_overrides[require_vault_owner_chat_key] = denied
    response = TestClient(app).post("/api/one/profile-research")
    assert response.status_code == 401 and len(seen) == 1
    assert response.headers["cache-control"] == "private, no-store"


def test_route_hides_provider_errors_and_owner_revocation(monkeypatch, route_app):

    app = route_app

    async def fails(**kwargs):
        raise RuntimeError("private-provider-details")

    monkeypatch.setattr(routes, "offer_profile_research", fails)
    response = TestClient(app).post("/api/one/profile-research")
    assert response.json() == {"status": "unavailable", "pkm_written": False}
    assert (
        "private-provider" not in response.text
        and response.headers["cache-control"] == "private, no-store"
    )

    async def revoked(**kwargs):
        raise PermissionError("private-owner-details")

    monkeypatch.setattr(routes, "offer_profile_research", revoked)
    response = TestClient(app).post("/api/one/profile-research")
    assert response.status_code == 403 and "private-owner" not in response.text


def test_rate_limit_is_private_and_does_not_start_a_fourth_research(monkeypatch, route_app):

    app = route_app
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    calls = []

    async def research(**kwargs):
        calls.append(kwargs)
        return {"status": "disabled", "pkm_written": False}

    monkeypatch.setattr(routes, "offer_profile_research", research)
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    try:
        with TestClient(app) as client:
            responses = [client.post("/api/one/profile-research") for _ in range(4)]
        assert [response.status_code for response in responses] == [200, 200, 200, 429]
        assert len(calls) == 3
        assert all(
            response.headers["cache-control"] == "private, no-store" for response in responses
        )
        assert responses[-1].json()["detail"]["code"] == "RATE_LIMITED"
    finally:
        limiter.reset()
