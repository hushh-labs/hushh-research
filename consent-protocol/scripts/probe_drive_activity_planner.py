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
from functools import partial
from typing import Literal


def grade_plan(plan, case):
    from hushh_mcp.services.drive_request_discovery import compile_discovery_queries

    if plan is None or plan.version != 2 or plan.status != "ready":
        raise ValueError("activity_planner_invalid_plan")
    predicates = [p for clause in plan.clauses for p in clause.predicates]
    if case == "ordinary":
        assert plan.date_basis == "activity_union"
        assert len(plan.clauses) >= 2
        concepts = {
            p.value.casefold()
            for p in predicates
            if not p.negated and p.kind in {"semantic", "content"}
        }
        assert len(concepts) >= 2
        for clause in plan.clauses:
            assert any(
                p.kind in {"semantic", "content"} and not p.negated for p in clause.predicates
            )
            assert any(
                p.kind == "entity"
                and p.match == "token"
                and set(p.value.casefold().split()) == {"cedar", "vale"}
                and p.sparse_fallback_any_token
                for p in clause.predicates
            )
        assert not any("consist" in p.value.casefold().split() for p in predicates)
        assert not any(p.kind == "title" for p in predicates)
    else:
        assert plan.date_basis == "created"
        for clause in plan.clauses:
            assert any(
                p.kind == "title" and p.match == "exact" and p.value == "Research Charter.pdf"
                for p in clause.predicates
            )
            assert any(p.negated and "draft" in p.value.casefold() for p in clause.predicates)
        assert not any(p.sparse_fallback_any_token for p in predicates)
    queries = compile_discovery_queries(
        plan, period_start="2026-06-02", period_end="2026-10-02", timezone="Asia/Kolkata"
    )
    assert len(queries) == (2 if case == "ordinary" else 1)
    assert ("createdTime >=" in queries[0]["arguments"]["query"]) == (case != "ordinary")
    return queries


async def probe_drive_activity_planner(
    provider: Literal["azure_openai", "vertex"] = "azure_openai",
):
    from hushh_mcp.runtime_providers.managed_text import build_managed_text_model
    from hushh_mcp.services.drive_suggestion_service import (
        interpret_semantic_live_search,
        plan_semantic_live_search,
    )

    async def synthetic_authority():
        return None  # Authored fictional text only; no owner state or tools.

    model = build_managed_text_model(
        scope="drive_document_requests", require_current=synthetic_authority, provider=provider
    ).model_copy(update={"allow_fallback": False})
    rows = []
    for case, purpose in (
        ("ordinary", "resume consist Cedar Rowan Vale"),
        (
            "explicit",
            'Filename exactly "Research Charter.pdf", exclude drafts. Created only within the selected period.',
        ),
    ):
        started = time.monotonic()
        async with asyncio.timeout(90):
            result = await plan_semantic_live_search(
                partial(interpret_semantic_live_search, model=model),
                prompt=json.dumps(
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
                ),
                user_id="synthetic-activity-planner-readiness",
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
    return {
        "schema": "drive.activity_planner.probe.v1",
        "passed": True,
        "provider": provider,
        "cases": rows,
        "drive_calls": 0,
        "per_item_model_calls": 0,
    }
