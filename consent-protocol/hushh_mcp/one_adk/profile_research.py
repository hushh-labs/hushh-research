"""One's ephemeral, public-profile task. No history, PKM or action tools."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ProfileSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    url: str = Field(min_length=1, max_length=2048)

    @field_validator("url")
    @classmethod
    def public_link(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("A source must be an HTTPS link without credentials")
        return value


class ProfileFact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    statement: str = Field(min_length=1, max_length=600)
    confidence: Literal["supported", "uncertain", "conflicting"]
    sources: list[ProfileSource] = Field(min_length=1, max_length=3)


class ProfileSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["business", "career", "education", "personal"]
    facts: list[ProfileFact] = Field(min_length=1, max_length=8)


class ProfileReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_status: Literal["matched", "uncertain", "no_match"]
    name: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=500)
    sections: list[ProfileSection] = Field(max_length=4)

    @model_validator(mode="after")
    def coherent_report(self) -> ProfileReport:
        if len({section.kind for section in self.sections}) != len(self.sections):
            raise ValueError("Duplicate sections")
        if (self.match_status == "no_match") != (len(self.sections) == 0):
            raise ValueError("A report needs findings or an explicit no-match result")
        return self


async def run_profile_research(
    *,
    identity: dict[str, str | None],
    user_id: str,
    consent_token: str,
    require_access: Callable[[], Awaitable[None]],
) -> dict[str, Any]:
    """Compose One's authored task with its existing Search child and shared runner."""
    from google.adk.agents import LlmAgent
    from google.adk.tools.agent_tool import AgentTool

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST, build_google_search_agent
    from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    task = next(child for child in _ONE_MANIFEST.subagents if child.id == "one_profile_research")
    model = build_managed_regional_gemini_adk_model(resolve_fleet_model_name(task.model.name))
    grounded_urls: set[str] = set()
    source_receipts: dict[str, str] = {}
    suggestions: list[str] = []
    search_observed = False
    attempt_search_observed = False
    search_attempts = 0

    async def before_model(callback_context: Any, llm_request: Any) -> None:
        await require_access()

    async def after_model(callback_context: Any, llm_response: Any) -> None:
        nonlocal search_observed, attempt_search_observed
        await require_access()
        if callback_context.agent_name == "one_profile_research":
            parts = getattr(getattr(llm_response, "content", None), "parts", None) or []
            if sum(bool(getattr(part, "function_call", None)) for part in parts) > 1:
                # ADK dispatches parallel calls concurrently. Keep each Search
                # receipt bound to its own attempt, including task completion.
                raise ValueError("Profile research tools must run sequentially")
        metadata = getattr(llm_response, "grounding_metadata", None)
        if getattr(metadata, "web_search_queries", None) or getattr(
            metadata, "grounding_chunks", None
        ):
            search_observed = True
            if callback_context.agent_name == "google_search":
                attempt_search_observed = True
        for chunk in getattr(metadata, "grounding_chunks", None) or []:
            web = getattr(chunk, "web", None)
            uri = getattr(web, "uri", None)
            if isinstance(uri, str):
                grounded_urls.add(uri)
                if callback_context.agent_name == "google_search":
                    source_receipts[uri] = getattr(web, "title", None) or "Source"
        html = getattr(getattr(metadata, "search_entry_point", None), "rendered_content", None)
        if isinstance(html, str) and html and len(html) <= 40_000 and html not in suggestions:
            suggestions.append(html)

    async def before_tool(tool: Any, args: Any, tool_context: Any) -> None:
        nonlocal attempt_search_observed, search_attempts
        await require_access()
        if tool.name == "google_search":
            if search_attempts >= 2:
                raise ValueError("Profile research allows only one Search follow-up")
            search_attempts += 1
            attempt_search_observed = False
            source_receipts.clear()

    async def after_tool(tool: Any, args: Any, tool_context: Any, tool_response: Any) -> Any:
        await require_access()
        if tool.name == "google_search":
            # Child prose does not reliably expose grounding redirect URLs.
            # Make the provider's exact receipts visible to the task; this is
            # transport metadata, not host-authored findings or a second search.
            return {
                "answer": tool_response,
                "search_performed": attempt_search_observed,
                "sources": [
                    {"title": title, "url": url}
                    for url, title in list(source_receipts.items())[:20]
                ],
            }
        return None

    search = build_google_search_agent(model=model)
    search.before_model_callback = before_model
    search.after_model_callback = after_model
    agent = LlmAgent(
        name="one_profile_research",
        model=model,
        mode="task",
        instruction=task.system_instruction,
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[AgentTool(agent=search, propagate_grounding_metadata=True)],
        output_schema=ProfileReport,
        before_model_callback=before_model,
        after_model_callback=after_model,
        before_tool_callback=before_tool,
        after_tool_callback=after_tool,
    )
    turn = await run_specialist_adk_turn(
        agent=agent,
        app_name="one_profile_research",
        user_id=user_id,
        consent_token=consent_token,
        message=json.dumps({"identity": identity}, ensure_ascii=False),
        max_llm_calls=5,
        first_event_timeout_s=25,
        between_event_timeout_s=25,
        total_timeout_s=30,
    )
    await require_access()
    report = ProfileReport.model_validate(turn.structured_output)
    if not search_observed or (report.match_status == "no_match" and not attempt_search_observed):
        # A refusal or an offline answer is not evidence that no public match exists.
        raise ValueError("Profile research has no Search execution receipt")
    # A plausible URL invented by the model is not a source receipt. Refuse
    # the entire draft rather than presenting or rewriting unsupported claims.
    for section in report.sections:
        for fact in section.facts:
            if any(source.url not in grounded_urls for source in fact.sources):
                raise ValueError("Profile source has no Search grounding receipt")
    return {"report": report.model_dump(), "search_suggestions": suggestions}
