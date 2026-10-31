"""One's bounded task suggestions over explicitly approved owner summaries.

No tools, source reads, conversation storage, task writes or action execution.
Source references prove grounding in the supplied summaries, not provider truth.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool

from hushh_mcp.runtime_settings import one_todo_suggestions_enabled

CapabilityId = Literal[
    "messages", "finance", "wallet", "location", "ria", "gmail", "calendar", "pkm", "consent"
]


class TaskSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ref: str = Field(pattern=r"^s[0-9]{1,4}$")
    capability: CapabilityId
    summary: str = Field(min_length=1, max_length=240)
    already_pending: StrictBool = False


class TaskSuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    allow_model_processing: StrictBool
    sources: list[TaskSource] = Field(min_length=1, max_length=100)


class TaskSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_ref: str
    title: str = Field(min_length=1, max_length=160)
    reason: str = Field(min_length=1, max_length=240)


class TaskSuggestions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[TaskSuggestion] = Field(default_factory=list, max_length=12)


async def run_todo_gene(*, prompt: str, user_id: str, consent_token: str) -> object:
    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/one/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "one_todo_suggestions")
    if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
        raise ValueError("invalid task suggestion boundary")
    result = await run_single_turn(
        build_single_turn_agent(gene, output_schema=TaskSuggestions),
        prompt_parts=prompt,
        user_id=user_id,
        consent_token=consent_token,
        timeout_seconds=25,
    )
    return result.model_dump() if isinstance(result, BaseModel) else result


async def suggest_tasks(
    request: TaskSuggestionRequest,
    *,
    user_id: str,
    consent_token: str,
    require_access: Callable[[], Awaitable[None]],
    runner: Callable[..., Awaitable[object]] = run_todo_gene,
) -> TaskSuggestions:
    if not one_todo_suggestions_enabled():
        raise RuntimeError("Task suggestions are disabled")
    if not request.allow_model_processing:
        raise PermissionError("Task summary processing was not approved")
    refs = {source.ref for source in request.sources}
    if len(refs) != len(request.sources):
        raise ValueError("duplicate task source reference")
    await require_access()
    response = TaskSuggestions.model_validate(
        await runner(
            prompt=json.dumps(
                {"owner_supplied_summaries": [s.model_dump() for s in request.sources]}
            ),
            user_id=user_id,
            consent_token=consent_token,
        )
    )
    selected = [item.source_ref for item in response.items]
    if len(set(selected)) != len(selected) or any(ref not in refs for ref in selected):
        raise ValueError("unoffered task source reference")
    await require_access()
    if not one_todo_suggestions_enabled():
        raise RuntimeError("Task suggestions are disabled")
    return response
