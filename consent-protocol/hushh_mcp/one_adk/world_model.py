"""Vertex-native PWM research, separate from HTTP, UI and approved knowledge."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

from pydantic import Field

from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.one_adk.profile_research import ProfileReport, ProfileSource
from hushh_mcp.one_adk.world_model_contracts import (
    TOPICS,
    Contract,
    IdentityAssessment,
    QueryPlan,
    ShortText,
    WorldModelReport,
)

POLICY = load_pwm_policy()
MAX_SEARCHES = POLICY["search_invocations"]
MAX_MODEL_CALLS = POLICY["model_calls"]
TASK_SECONDS = POLICY["slice_seconds"]


class OwnerDecisions(Contract):
    """Statements the owner already confirmed or rejected; model data only."""

    confirmed: list[ShortText] = Field(default_factory=list, max_length=50)
    rejected: list[ShortText] = Field(default_factory=list, max_length=50)


class ResearchSliceComplete(RuntimeError):
    """A fresh owner-key lease can continue the same paid research generation."""


def manifest():
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST

    return next(
        child for child in _ONE_MANIFEST.subagents if child.id == "one_personal_world_model"
    )


def policy_fingerprint() -> str:
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    task = manifest()
    return hashlib.sha256(
        json.dumps(
            {
                "manifest": task.model_dump(mode="json"),
                "schema": WorldModelReport.model_json_schema(),
                "assessment": IdentityAssessment.model_json_schema(),
                "query_plan": QueryPlan.model_json_schema(),
                "search_manifest": next(
                    child for child in _ONE_MANIFEST.subagents if child.id == "google_search"
                ).model_dump(mode="json"),
                "model": resolve_fleet_model_name(task.model.name),
                "searches": MAX_SEARCHES,
                "calls": MAX_MODEL_CALLS,
                "policy": POLICY,
                "provider": "vertex-google-search-v1",
                "gate": "evidence-chain-v1",
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


async def run_world_model(
    *,
    identity,
    user_id,
    consent_token,
    require_access,
    attempts_used=(),
    on_attempts_start=None,
    work=None,
    on_progress=None,
    owner_decisions=None,
):
    """Run a resumable research slice, with no PKM or messaging authority.

    Google grounding stays in the owner's view-only research conversation.
    Its links cannot become crawl inputs or permanent knowledge imports.
    """
    from google.adk.agents import LlmAgent
    from google.genai import types

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import build_google_search_agent
    from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
    from hushh_mcp.runtime_providers.gemini_config import (
        build_generate_content_config,
        resolve_fleet_model_name,
        thinking_config_for,
    )

    await require_access()
    if on_attempts_start is None:
        raise ValueError("Durable provider budget is required")
    decisions = OwnerDecisions.model_validate(owner_decisions or {}).model_dump()
    task = manifest()
    model_name = resolve_fleet_model_name(task.model.name)
    model = build_managed_regional_gemini_adk_model(model_name)
    generation = build_generate_content_config(
        types,
        model_name,
        max_output_tokens=task.performance.max_output_tokens,
        thinking_config=thinking_config_for(model_name, task.model.thinking_level, types),
    )
    history = json.loads(json.dumps(work or {}))
    receipts = history.setdefault("sources", {})
    attempts = history.setdefault("attempts", {})
    suggestions = history.setdefault("search_suggestions", [])
    assessment = (
        IdentityAssessment.model_validate(history["assessment"]).validate_evidence(
            identity=identity,
            source_refs=set(receipts),
        )
        if history.get("assessment")
        else None
    )
    used = set(attempts_used)
    model_slots = set(range(MAX_SEARCHES + 1, MAX_SEARCHES + MAX_MODEL_CALLS + 1))
    if not model_slots - used:
        return {"status": "unavailable", "pkm_written": False, "research_exhausted": True}
    lock = asyncio.Lock()
    deadline = time.monotonic() + TASK_SECONDS
    parallel_response = False

    async def checkpoint():
        if len(json.dumps(history).encode()) > 6 * 1024 * 1024:
            raise ValueError("Research checkpoint exceeds supported evidence size")
        if on_progress:
            await require_access()
            await on_progress(history)

    async def charge(slots):
        async with lock:
            remaining = sorted(set(slots) - used)
            if not remaining:
                raise ValueError("Research budget exhausted")
            index = remaining[0]
            await on_attempts_start((index,))
            used.add(index)
            return index

    async def before_model(callback_context, llm_request):
        nonlocal parallel_response
        if callback_context.agent_name == task.id:
            parallel_response = False
        await require_access()
        if time.monotonic() > deadline - 25:
            raise ResearchSliceComplete()
        await charge(range(MAX_SEARCHES + 1, MAX_SEARCHES + MAX_MODEL_CALLS + 1))
        if callback_context.agent_name == task.id and len(model_slots - used) <= 1 and assessment:
            llm_request.config.tool_config = types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=["finish_task"],
                )
            )

    async def search_public_web(plan_json: str) -> dict:
        """Run a QueryPlan JSON against native Google Search with exact owner inputs."""
        await require_access()
        if time.monotonic() > deadline - 70:
            raise ResearchSliceComplete()
        if len(model_slots - used) < 3 or not set(range(1, MAX_SEARCHES + 1)) - used:
            return {
                "available": False,
                "reason": "budget_exhausted",
                "action": "finish_with_received_evidence",
            }
        plan = QueryPlan.model_validate_json(plan_json)
        if any(not identity.get(field) for field in plan.seed_fields):
            raise ValueError("Query uses an absent owner field")
        anchors = {row.id: row for row in assessment.anchors} if assessment else {}
        if any(ref not in anchors for ref in plan.anchor_ids):
            raise ValueError("Query uses an unevidenced anchor")
        if any(anchors[ref].candidate_id != plan.candidate_id for ref in plan.anchor_ids):
            raise ValueError("Query mixes candidate identities")
        if plan.purpose == "coverage" and (
            not assessment
            or assessment.identity.selected_candidate_id != plan.candidate_id
            or assessment.identity.state in {"ambiguous", "no_match"}
        ):
            raise ValueError("Resolve the candidate before expanding research")
        request = {
            "exact_owner_fields": {field: identity[field] for field in sorted(plan.seed_fields)},
            "evidenced_anchors": [anchors[ref].model_dump() for ref in sorted(plan.anchor_ids)],
            "research_question": plan.question,
        }
        query_key = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        if any(row.get("query_key") == query_key for row in attempts.values()):
            return {"available": False, "reason": "duplicate_query"}
        index = await charge(range(1, MAX_SEARCHES + 1))
        observed = False
        received = []
        attempts[str(index)] = {
            "plan": plan.model_dump(),
            "query_key": query_key,
            "observed": False,
            "answer": "",
            "source_refs": [],
            "state": "started",
        }
        await checkpoint()

        async def receive(callback_context, llm_response):
            nonlocal observed
            await require_access()
            metadata = getattr(llm_response, "grounding_metadata", None)
            observed |= bool(
                getattr(metadata, "web_search_queries", None)
                or getattr(metadata, "grounding_chunks", None)
            )
            chunks = getattr(metadata, "grounding_chunks", None) or []
            if len(chunks) > 100 or len(receipts) + len(chunks) > 3200:
                raise ValueError("Provider receipt exceeds supported bounds")
            for chunk in chunks:
                web = getattr(chunk, "web", None)
                try:
                    source = ProfileSource(
                        title=str(getattr(web, "title", "") or "Source")[:160],
                        url=getattr(web, "uri", None),
                    ).model_dump()
                except ValueError:
                    continue
                ref = next((key for key, value in receipts.items() if value == source), None)
                if ref is None:
                    ref = f"s{len(receipts) + 1}"
                    receipts[ref] = source
                if ref not in received:
                    received.append(ref)
            html = getattr(getattr(metadata, "search_entry_point", None), "rendered_content", None)
            if isinstance(html, str) and len(html) > 40_000:
                raise ValueError("Provider attribution exceeds supported bounds")
            if isinstance(html, str) and html and html not in suggestions:
                suggestions.append(html)
            answer = "".join(
                part.text
                for part in getattr(getattr(llm_response, "content", None), "parts", None) or []
                if getattr(part, "text", None) and not getattr(part, "thought", False)
            )
            if len(answer) > 100_000:
                raise ValueError("Provider answer exceeds supported bounds")
            attempts[str(index)].update(
                observed=observed,
                source_refs=list(received),
                answer=answer,
                state="received" if observed else "unavailable",
                search_suggestions=[html] if isinstance(html, str) and html else [],
            )
            await checkpoint()

        search = build_google_search_agent(model=model)
        search.before_model_callback = before_model
        search.after_model_callback = receive
        search.generate_content_config = generation
        result = await run_specialist_adk_turn(
            agent=search,
            app_name="one_personal_world_model_search",
            user_id=user_id,
            consent_token=consent_token,
            message=json.dumps(request),
            max_llm_calls=2,
            first_event_timeout_s=75,
            between_event_timeout_s=75,
            total_timeout_s=min(90, max(1, deadline - time.monotonic() - 10)),
        )
        await require_access()
        if len(result.final_text) > 100_000:
            raise ValueError("Provider answer exceeds supported bounds")
        attempts[str(index)].update(
            observed=observed,
            answer=result.final_text,
            source_refs=received,
            state="received" if observed else "unavailable",
        )
        await checkpoint()
        return {
            "attempt_id": index,
            "available": observed,
            "answer": result.final_text,
            "sources": [{"ref": ref, **receipts[ref]} for ref in received],
            "searches_remaining": MAX_SEARCHES - len(set(range(1, MAX_SEARCHES + 1)) & used),
        }

    async def assess_identity(assessment_json: str) -> dict:
        """Record Gemini's IdentityAssessment JSON before expanding candidate research."""
        nonlocal assessment
        await require_access()
        if not any(row["observed"] for row in attempts.values()):
            raise ValueError("Identity assessment needs an observed search")
        assessment = IdentityAssessment.model_validate_json(assessment_json).validate_evidence(
            identity=identity,
            source_refs=set(receipts),
        )
        history["assessment"] = assessment.model_dump()
        await checkpoint()
        return {"accepted": True, "identity": assessment.identity.model_dump()}

    async def after_model(callback_context, llm_response):
        nonlocal parallel_response
        parts = getattr(getattr(llm_response, "content", None), "parts", None) or []
        parallel_response = sum(bool(getattr(part, "function_call", None)) for part in parts) > 1

    async def before_tool(tool, args, tool_context):
        await require_access()
        if parallel_response:
            return {
                "error": "sequential_execution_required",
                "action": "Call one identity-dependent tool at a time using its returned evidence.",
            }
        return None

    def tool_error(*, tool, args, tool_context, error):
        if isinstance(error, ValueError):
            return {
                "error": "invalid_argument",
                "action": "repair_against_supplied_schema_and_received_evidence",
            }
        return None

    agent = LlmAgent(
        name=task.id,
        model=model,
        mode="task",
        instruction=task.system_instruction,
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[search_public_web, assess_identity],
        output_schema=WorldModelReport,
        before_model_callback=before_model,
        after_model_callback=after_model,
        before_tool_callback=before_tool,
        generate_content_config=generation,
        on_tool_error_callback=tool_error,
    )
    try:
        turn = await run_specialist_adk_turn(
            agent=agent,
            app_name=task.id,
            user_id=user_id,
            consent_token=consent_token,
            message=json.dumps(
                {
                    "identity": identity,
                    "research_history": history,
                    "query_plan_schema": QueryPlan.model_json_schema(),
                    "assessment_schema": IdentityAssessment.model_json_schema(),
                    "topics": TOPICS,
                    "owner_decisions": decisions,
                    "requested_by": "consenting_verified_owner",
                    "searches_remaining": MAX_SEARCHES
                    - len(used & set(range(1, MAX_SEARCHES + 1))),
                    "model_calls_remaining": MAX_MODEL_CALLS
                    - len(used - set(range(1, MAX_SEARCHES + 1))),
                }
            ),
            max_llm_calls=MAX_MODEL_CALLS,
            first_event_timeout_s=TASK_SECONDS,
            between_event_timeout_s=TASK_SECONDS,
            total_timeout_s=TASK_SECONDS,
        )
    except Exception as error:
        cause = error
        while cause is not None and not isinstance(cause, (ResearchSliceComplete, TimeoutError)):
            cause = cause.__cause__
        if cause is None and not isinstance(error, TimeoutError):
            raise
        await checkpoint()
        return {"status": "paused", "pkm_written": False, "restart_required": True}
    await require_access()
    if assessment is None:
        return {"status": "unavailable", "pkm_written": False}
    result = (
        WorldModelReport.model_validate(turn.structured_output)
        .validate_receipts(
            assessment,
            attempts,
            set(receipts),
        )
        .model_dump()
    )
    evidence = {key: result.pop(key) for key in ("identity", "coverage", "gaps")}
    for section in result["sections"]:
        for fact in section["facts"]:
            fact["sources"] = [receipts[source["ref"]] for source in fact["sources"]]
    report = ProfileReport.model_validate(result)
    return {
        "status": "offered",
        "pkm_written": False,
        "report": report.model_dump(),
        "search_suggestions": suggestions,
        "grounded_answers": [
            {
                "answer": row["answer"],
                "sources": [receipts[ref] for ref in row["source_refs"]],
                "search_suggestions": row.get("search_suggestions", []),
            }
            for row in attempts.values()
            if row.get("observed") and row.get("answer")
        ],
        "research": {
            **evidence,
            "checked_topics": [
                row["topic"] for row in evidence["coverage"] if row["status"] != "not_attempted"
            ],
            "searches_used": len(used & set(range(1, MAX_SEARCHES + 1))),
            "candidates": [row.model_dump() for row in assessment.candidates],
            "source_use": "google_grounded_display_only",
            "provider": "vertex_google_search",
        },
    }
