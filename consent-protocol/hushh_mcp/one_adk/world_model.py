"""Explicit owner research: bounded tools, source receipts, no PKM writes."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.one_adk.profile_research import ProfileReport, ProfileSource, ProfileSourceRef
from hushh_mcp.runtime_settings import pwm_tavily_api_key

MAX_SEARCHES = 32
MAX_MODEL_CALLS = 20
TASK_SECONDS = 240


class IdentityPivot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["owner_linked", "candidate_for_review", "ambiguous", "no_match"]
    reason: str = Field(min_length=1, max_length=600)
    # Deliberately not a probability: there is no calibrated identity dataset yet.
    probability: None = None


class WorldModelReport(ProfileReport[ProfileSourceRef]):
    identity: IdentityPivot
    checked_topics: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(max_length=20)
    gaps: list[Annotated[str, Field(min_length=1, max_length=600)]] = Field(max_length=20)

    @model_validator(mode="after")
    def identity_contract(self):
        expected = {
            "owner_linked": "matched",
            "candidate_for_review": "uncertain",
            "ambiguous": "uncertain",
            "no_match": "no_match",
        }[self.identity.state]
        if self.match_status != expected:
            raise ValueError("Identity and report decisions disagree")
        return self


def manifest():
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST

    return next(
        child for child in _ONE_MANIFEST.subagents if child.id == "one_personal_world_model"
    )


def policy_fingerprint() -> str:
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    task = manifest()
    return hashlib.sha256(
        json.dumps(
            {
                "manifest": task.model_dump(mode="json"),
                "schema": WorldModelReport.model_json_schema(),
                "model": resolve_fleet_model_name(task.model.name),
                "searches": MAX_SEARCHES,
                "calls": MAX_MODEL_CALLS,
                "seconds": TASK_SECONDS,
                "provider": "tavily-basic-v1",
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


async def charge_search_credit() -> bool:
    """Atomic shared free-tier ceiling; no owner identifiers or queries stored."""
    from db.connection import get_pool

    pool = await get_pool()
    return bool(
        await pool.fetchval(
            """
        INSERT INTO pwm_provider_budget (provider, month, credits)
        VALUES ('tavily', date_trunc('month', NOW() AT TIME ZONE 'UTC')::date, 1)
        ON CONFLICT (provider, month) DO UPDATE
        SET credits = pwm_provider_budget.credits + 1
        WHERE pwm_provider_budget.credits < 900
        RETURNING credits
    """,
            timeout=5,
        )
    )


async def run_world_model(
    *, identity, user_id, consent_token, require_access, attempts_used=(), on_attempts_start=None
):
    from google.adk.agents import LlmAgent
    from google.genai import types

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
    from hushh_mcp.runtime_providers.gemini_config import (
        build_generate_content_config,
        resolve_fleet_model_name,
        thinking_config_for,
    )

    api_key = pwm_tavily_api_key()
    if not api_key:
        return {"status": "unavailable", "pkm_written": False}
    task = manifest()
    model_name = resolve_fleet_model_name(task.model.name)
    receipts: dict[str, dict[str, str]] = {}
    searches = set(attempts_used) & set(range(1, 33))
    model_calls = set(attempts_used) & set(range(33, 53))
    lock = asyncio.Lock()
    provider_observed = False

    async def search_public_web(query: str) -> dict:
        """Search public sources. Use verified identifiers or already evidenced anchors only."""
        nonlocal provider_observed
        await require_access()
        if not isinstance(query, str) or not 1 <= len(query) <= 600:
            raise ValueError("Invalid public search query")
        # Serial charging prevents parallel tools claiming the same durable slot.
        async with lock:
            remaining = sorted(set(range(1, MAX_SEARCHES + 1)) - searches)
            if not remaining:
                return {"available": False, "reason": "budget_exhausted", "sources": []}
            index = remaining[0]
            if on_attempts_start is None:
                raise ValueError("Durable search budget is required")
            await on_attempts_start((index,))
            searches.add(index)
            if not await charge_search_credit():
                return {"available": False, "reason": "monthly_limit", "sources": []}
            await require_access()
            # Fixed provider endpoint; no model-selected fetch URLs or credentials in logs.
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                response = await client.post(
                    "https://api.tavily.com/search",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "query": query,
                        "search_depth": "basic",
                        "max_results": 5,
                        "include_answer": False,
                        "include_raw_content": False,
                        "include_usage": True,
                        "auto_parameters": False,
                    },
                )
            await require_access()
            if response.status_code != 200:
                return {"available": False, "reason": "provider_unavailable", "sources": []}
            payload = response.json()
            sources = []
            for row in payload.get("results", [])[:5]:
                try:
                    source = ProfileSource(title=str(row["title"])[:160], url=row["url"])
                except (ValueError, KeyError, TypeError):
                    continue
                ref = f"s{len(receipts) + 1}"
                receipts[ref] = source.model_dump()
                sources.append(
                    {
                        "ref": ref,
                        "title": source.title,
                        "url": source.url,
                        "excerpt": str(row.get("content") or "")[:4000],
                    }
                )
            provider_observed = True
            return {
                "available": True,
                "sources": sources,
                "searches_remaining": MAX_SEARCHES - len(searches),
            }

    async def before_model(callback_context, llm_request):
        await require_access()
        async with lock:
            remaining = sorted(set(range(33, 53)) - model_calls)
            if not remaining or on_attempts_start is None:
                raise ValueError("Model call budget exhausted")
            await on_attempts_start((remaining[0],))
            model_calls.add(remaining[0])

    model = build_managed_regional_gemini_adk_model(model_name)
    agent = LlmAgent(
        name=task.id,
        model=model,
        mode="task",
        instruction=task.system_instruction,
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[search_public_web],
        output_schema=WorldModelReport,
        before_model_callback=before_model,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            max_output_tokens=task.performance.max_output_tokens,
            thinking_config=thinking_config_for(model_name, task.model.thinking_level, types),
        ),
    )
    turn = await run_specialist_adk_turn(
        agent=agent,
        app_name=task.id,
        user_id=user_id,
        consent_token=consent_token,
        message=json.dumps(
            {
                "identity": identity,
                "searches_remaining": MAX_SEARCHES - len(searches),
                "identity_search_limit": 6,
                "requested_by": "verified_owner",
            }
        ),
        max_llm_calls=MAX_MODEL_CALLS,
        first_event_timeout_s=90,
        between_event_timeout_s=90,
        total_timeout_s=TASK_SECONDS,
    )
    await require_access()
    if not provider_observed:
        return {"status": "unavailable", "pkm_written": False}
    result = WorldModelReport.model_validate(turn.structured_output).model_dump()
    evidence = {key: result.pop(key) for key in ("identity", "checked_topics", "gaps")}
    for section in result["sections"]:
        for fact in section["facts"]:
            fact["sources"] = [receipts[source["ref"]] for source in fact["sources"]]
    report = ProfileReport.model_validate(result)
    return {
        "status": "offered",
        "pkm_written": False,
        "report": report.model_dump(),
        "search_suggestions": [],
        "research": {**evidence, "searches_used": len(searches)},
    }
