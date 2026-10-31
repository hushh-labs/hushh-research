"""Vertex-native PWM research, separate from HTTP, UI and approved knowledge."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.one_adk.profile_research import ProfileFact, ProfileSource, ProfileSourceRef
from hushh_mcp.one_adk.research_context import (
    OwnerDecisions,
    OwnerResearchContext,
    approved_lead_inputs,
    confirmed_leads,
    public_profile_leads,
)
from hushh_mcp.one_adk.world_model_confidence import evidence_rating
from hushh_mcp.one_adk.world_model_contracts import (
    MAX_WORLD_MODEL_FACTS,
    TOPICS,
    CoverageCoherenceError,
    CoverageRepair,
    FindingBatch,
    IdentityAssessment,
    QueryPlan,
    WorldModelReport,
    validated_facts_from_work,
)

POLICY = load_pwm_policy()
MAX_SEARCHES = POLICY["search_invocations"]
MAX_MODEL_CALLS = POLICY["model_calls"]
TASK_SECONDS = POLICY["slice_seconds"]


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
    if POLICY["provider"] in {"azure_openai_web_search", "azure_openai_tavily"}:
        from hushh_mcp.one_adk.world_model_azure import azure_execution_contract

        # A provider switch changes the owner-bound research generation. Keep
        # this fingerprint separate from Vertex's existing checkpoint lineage.
        material = {
            "manifest": task.model_dump(mode="json"),
            "schema": WorldModelReport.model_json_schema(),
            "assessment": IdentityAssessment.model_json_schema(),
            "research_context": OwnerResearchContext.model_json_schema(),
            "query_plan": QueryPlan.model_json_schema(),
            "searches": MAX_SEARCHES,
            "calls": MAX_MODEL_CALLS,
            "policy": POLICY,
            "provider": POLICY["provider"],
            "gate": "evidence-chain-v2",
            "azure_execution": azure_execution_contract(),
        }
        return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()
    return hashlib.sha256(
        json.dumps(
            {
                "manifest": task.model_dump(mode="json"),
                "schema": WorldModelReport.model_json_schema(),
                "assessment": IdentityAssessment.model_json_schema(),
                "research_context": OwnerResearchContext.model_json_schema(),
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
    owner_public_profiles=None,
    owner_research_context=None,
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
    research_leads = confirmed_leads(owner_research_context)
    public_profiles = public_profile_leads(owner_public_profiles)

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
            from hushh_mcp.one_adk.world_model_completion import force_native_completion

            force_native_completion(llm_request)

    async def search_public_web(plan_json: str) -> dict:
        """Run a QueryPlan JSON against native Google Search with exact owner inputs."""
        await require_access()
        if time.monotonic() > deadline - 70:
            raise ResearchSliceComplete()
        if len(model_slots - used) < 3:
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
            **approved_lead_inputs(public_profiles, research_leads),
            "exact_owner_fields": {field: identity[field] for field in sorted(plan.seed_fields)},
            "evidenced_anchors": [anchors[ref].model_dump() for ref in sorted(plan.anchor_ids)],
            "research_question": plan.question,
        }
        query_key = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        matching = [
            (key, row)
            for key, row in attempts.items()
            if isinstance(row, dict) and row.get("query_key") == query_key
        ]
        # A provider failure after the paid search started may leave only a
        # started receipt. Resume that exact slot; completed queries stay
        # deduplicated, and no new search charge is made for the retry.
        resumable = [
            int(key)
            for key, row in matching
            if str(key).isdigit()
            and int(key) in used
            and row.get("state") == "started"
            and row.get("observed") is False
            and not row.get("answer")
            and not row.get("source_refs")
        ]
        if matching and len(resumable) != len(matching):
            return {"available": False, "reason": "duplicate_query"}
        if len(resumable) > 1:
            raise ValueError("Repeated started search receipt")
        if not resumable and not set(range(1, MAX_SEARCHES + 1)) - used:
            return {
                "available": False,
                "reason": "budget_exhausted",
                "action": "finish_with_received_evidence",
            }
        index = resumable[0] if resumable else await charge(range(1, MAX_SEARCHES + 1))
        observed = False
        received = []
        attempts[str(index)] = {
            "plan": plan.model_dump(),
            "query_key": query_key,
            "observed": False,
            "answer": "",
            "source_refs": [],
            "state": "started",
            # Wall-clock start time: the last activity moves when a search begins.
            "at": time.time(),
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
                at=time.time(),
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
        # Wall-clock completion time lets progress report the last activity.
        attempts[str(index)].update(
            observed=observed,
            answer=result.final_text,
            source_refs=received,
            state="received" if observed else "unavailable",
            at=time.time(),
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

    async def record_findings(batch_json: str) -> dict:
        """Checkpoint up to eight cited findings from one observed search.

        Supply FindingBatch JSON with the accepted candidate, exact attempt_id,
        one planned topic and received source refs. These provisional facts
        remain read-only until the final report passes every evidence gate.
        """
        await require_access()
        if assessment is None:
            raise ValueError("Assess identity before recording findings")
        batch = FindingBatch.model_validate_json(batch_json).validate_receipts(
            assessment, attempts, set(receipts)
        )
        existing = validated_facts_from_work(history)
        if len(existing) + len(batch.facts) > MAX_WORLD_MODEL_FACTS:
            raise ValueError("Provisional finding limit reached")
        history.setdefault("finding_batches", []).append(batch.model_dump())
        await checkpoint()
        return {"accepted": True, "validated_facts": len(validated_facts_from_work(history))}

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
        tools=[search_public_web, assess_identity, record_findings],
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
                    "finding_batch_schema": FindingBatch.model_json_schema(),
                    "finding_checkpoint_instruction": (
                        "After an observed search and accepted identity assessment, "
                        "call record_findings for each material group of cited findings "
                        "before continuing research. Use the selected candidate, "
                        "the actual attempt ID, one planned topic and only source "
                        "refs received by that attempt. Checkpoints are read-only "
                        "provisional work; include them in the final report unless "
                        "later evidence requires a correction."
                    ),
                    "topics": TOPICS,
                    "owner_decisions": decisions,
                    "owner_confirmed_research_leads": research_leads,
                    "owner_selected_public_profiles": public_profiles,
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
    from hushh_mcp.one_adk.world_model_completion import validated_native_report

    report = validated_native_report(turn)
    try:
        report.validate_receipts(assessment, attempts, set(receipts))
    except CoverageCoherenceError as error:
        # The model's topic judgment is invalid, so one paid model call may
        # repair coverage only. Host code never invents a no-findings claim.
        if not model_slots - used:
            return {"status": "unavailable", "pkm_written": False, "research_exhausted": True}
        if time.monotonic() > deadline - 40:
            await checkpoint()
            return {"status": "paused", "pkm_written": False, "restart_required": True}
        repair_agent = LlmAgent(
            name="one_personal_world_model_coverage_repair",
            model=model,
            mode="task",
            instruction=(
                "Repair only the twenty coverage rows and gaps in the supplied report. "
                "Use the recorded search plans and observations for attempt IDs. "
                "A topic with no recorded attempt is not_attempted. A topic with "
                "findings in the report must be findings, and its evidence must "
                "pass the recorded-receipt gate. Never claim checked_no_findings "
                "from a failed or unobserved search. If an observed search has "
                "no report finding but the supplied evidence does not establish "
                "absence, say unavailable. Do not invent facts or searches."
            ),
            include_contents="none",
            tools=[],
            output_schema=CoverageRepair,
            before_model_callback=before_model,
            generate_content_config=generation,
        )
        repair_turn = await run_specialist_adk_turn(
            agent=repair_agent,
            app_name=repair_agent.name,
            user_id=user_id,
            consent_token=consent_token,
            message=json.dumps(
                {
                    "failure": str(error),
                    "original_coverage": [row.model_dump() for row in report.coverage],
                    "original_gaps": report.gaps,
                    "selected_candidate_id": assessment.identity.selected_candidate_id,
                    "identity_state": assessment.identity.state,
                    "section_topics": [section.kind for section in report.sections],
                    "attempts": [
                        {
                            "id": key,
                            "candidate_id": row["plan"]["candidate_id"],
                            "topics": row["plan"]["topics"],
                            "observed": row["observed"],
                            "answer_excerpt": row.get("answer", "")[:1500],
                        }
                        for key, row in sorted(attempts.items(), key=lambda item: int(item[0]))
                    ],
                }
            ),
            max_llm_calls=1,
            first_event_timeout_s=min(75, max(1, deadline - time.monotonic() - 5)),
            between_event_timeout_s=75,
            total_timeout_s=min(80, max(1, deadline - time.monotonic() - 5)),
        )
        repair = CoverageRepair.model_validate(repair_turn.structured_output)
        report = report.model_copy(update={"coverage": repair.coverage, "gaps": repair.gaps})
        report.validate_receipts(assessment, attempts, set(receipts))
    result = report.model_dump()
    evidence = {key: result.pop(key) for key in ("identity", "coverage", "gaps")}
    for section in result["sections"]:
        for fact in section["facts"]:
            fact.update(
                evidence_rating(
                    fact=ProfileFact[ProfileSourceRef].model_validate(fact),
                    topic=section["kind"],
                    identity_state=assessment.identity.state,
                    receipts=receipts,
                )
            )
            fact["sources"] = [receipts[source["ref"]] for source in fact["sources"]]
    return {
        "status": "offered",
        "pkm_written": False,
        "report": result,
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
