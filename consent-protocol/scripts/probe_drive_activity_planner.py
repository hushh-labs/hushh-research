"""Bounded synthetic qualification of the authored v2 planner; no Drive I/O.

Invoked by the existing UAT candidate readiness job under its real workload
identity. This exercises generated plans, not hand-authored expected answers.
It establishes neither Google UI parity nor production-corpus recall.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Callable
from functools import partial
from typing import Literal


class ActivityPlannerContractError(AssertionError):
    """A generated plan failed an authored, synthetic semantic requirement."""


def _probe_event(case, stage, result, **metrics):
    print(
        json.dumps(
            {
                "schema": "drive.activity_planner.probe.v1",
                "case": case,
                "stage": stage,
                "result": result,
                **metrics,
            },
            sort_keys=True,
        ),
        flush=True,
    )


def _planner_prompt(purpose):
    return json.dumps(
        {
            "document_request": {
                "purpose": purpose,
                "periodStart": "2026-06-02",
                "periodEnd": "2026-10-02",
            },
            "semantic_plan_version": 2,
            "transaction_search": True,
            "current_time_utc": "2026-10-29T00:00:00Z",
            "user_timezone": "Asia/Kolkata",
        }
    )


def _require(case, condition, reason, leg=None):
    if not condition:
        detail = {"leg": leg} if leg else {}
        _probe_event(case, "grade", "failed", reason=reason, **detail)
        raise ActivityPlannerContractError(reason)


def _core_entity_leg(clause):
    """Name a clause's nearest miss; None only when one entity meets every requirement.

    The reason stays one stable code; the leg says which requirement every
    candidate entity missed, so variance can be traced to its cause.
    """
    entities = [p for p in clause.predicates if p.kind == "entity"]
    if not entities:
        return "entity_missing"
    core = [p for p in entities if set(p.value.casefold().split()) == {"cedar", "vale"}]
    if not core:
        return "tokens_mismatch"
    tokens = [p for p in core if p.match == "token"]
    if not tokens:
        return "match_not_token"
    if not any(p.sparse_fallback_any_token for p in tokens):
        return "fallback_missing"
    return None


def grade_plan(plan, case):
    from hushh_mcp.services.drive_request_discovery import compile_discovery_queries

    require = partial(_require, case)
    require(
        plan is not None and plan.version == 2 and plan.status == "ready",
        "activity_planner_invalid_plan",
    )
    predicates = [p for clause in plan.clauses for p in clause.predicates]
    if case == "ordinary":
        require(plan.date_basis == "activity_union", "activity_date_basis_missing")
        require(len(plan.clauses) >= 2, "concept_alternative_clauses_missing")
        concepts = {
            p.value.casefold()
            for p in predicates
            if not p.negated and p.kind in {"semantic", "content"}
        }
        require(len(concepts) >= 2, "distinct_executable_concepts_missing")
        for clause in plan.clauses:
            require(
                any(p.kind in {"semantic", "content"} and not p.negated for p in clause.predicates),
                "clause_concept_missing",
            )
            leg = _core_entity_leg(clause)
            require(leg is None, "clause_core_entity_or_sparse_fallback_missing", leg)
        require(
            not any("consist" in p.value.casefold().split() for p in predicates),
            "conversational_glue_became_keyword",
        )
        require(not any(p.kind == "title" for p in predicates), "concept_restricted_to_title")
    else:
        require(plan.date_basis == "created", "explicit_creation_date_basis_lost")
        for clause in plan.clauses:
            require(
                any(
                    p.kind == "title" and p.match == "exact" and p.value == "Research Charter.pdf"
                    for p in clause.predicates
                ),
                "explicit_exact_filename_lost",
            )
            require(
                any(p.negated and "draft" in p.value.casefold() for p in clause.predicates),
                "explicit_exclusion_lost",
            )
        require(
            not any(p.sparse_fallback_any_token for p in predicates),
            "explicit_constraint_relaxed_by_fallback",
        )
    queries = compile_discovery_queries(
        plan, period_start="2026-06-02", period_end="2026-10-02", timezone="Asia/Kolkata"
    )
    require(len(queries) == (2 if case == "ordinary" else 1), "compiled_query_count_mismatch")
    require(
        ("createdTime >=" in queries[0]["arguments"]["query"]) == (case != "ordinary"),
        "compiled_date_routing_mismatch",
    )
    return queries


async def probe_drive_activity_planner(
    provider: Literal["azure_openai", "vertex"] = "azure_openai",
    *,
    case_ids: list[str] | None = None,
    token_supplier: Callable[[], str] | None = None,
):
    """Run the manifest's planner cases; the defaults are the UAT exam's behaviour.

    Only the trusted pre-merge exam passes `case_ids` (its affected cases) and
    `token_supplier` (its probe-only identity on the same deployment and grader).
    """
    from hushh_mcp.runtime_providers.managed_text import build_managed_text_model
    from hushh_mcp.services.drive_suggestion_service import (
        interpret_semantic_live_search,
        plan_semantic_live_search,
    )

    async def synthetic_authority():
        return None  # Authored fictional text only; no owner state or tools.

    from scripts.readiness_exam_manifest import load_manifest, planner_cases

    update: dict[str, object] = {"allow_fallback": False}
    if token_supplier is not None:
        update["token_supplier"] = token_supplier
    model = build_managed_text_model(
        scope="drive_document_requests", require_current=synthetic_authority, provider=provider
    ).model_copy(update=update)
    rows = []
    # The readiness exam manifest is the single source of these case inputs.
    for case, purpose in planner_cases(load_manifest(), case_ids):
        started = time.monotonic()
        _probe_event(case, "planner", "started")
        try:
            async with asyncio.timeout(90):
                result = await plan_semantic_live_search(
                    partial(interpret_semantic_live_search, model=model),
                    prompt=_planner_prompt(purpose),
                    user_id="synthetic-activity-planner-readiness",
                )
        except Exception:
            _probe_event(
                case,
                "planner",
                "failed",
                reason="planner_execution_failed",
                elapsed_ms=round((time.monotonic() - started) * 1000),
            )
            raise
        _probe_event(
            case, "planner", "completed", elapsed_ms=round((time.monotonic() - started) * 1000)
        )
        queries = grade_plan(result.semantic_query, case)
        rows.append(
            {
                "case": case,
                "passed": True,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "query_count": len(queries),
                "plan_digest": hashlib.sha256(
                    result.semantic_query.model_dump_json().encode()
                ).hexdigest(),
                "query_digests": [
                    hashlib.sha256(q["arguments"]["query"].encode()).hexdigest() for q in queries
                ],
            }
        )
        _probe_event(case, "grade", "passed", **{k: v for k, v in rows[-1].items() if k != "case"})
    return {
        "schema": "drive.activity_planner.probe.v1",
        "passed": True,
        "provider": provider,
        "cases": rows,
        "drive_calls": 0,
        "per_item_model_calls": 0,
    }
