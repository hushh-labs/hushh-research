"""One's ephemeral, public-profile task. No history, PKM or action tools."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Generic, Literal, Self, TypeVar
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_SEARCH_ATTEMPTS = 2
MAX_LLM_CALLS = 5
EVENT_TIMEOUT_SECONDS = 90
TASK_TIMEOUT_SECONDS = 160
MAX_DISCOVERY_ATTEMPTS = 1
MAX_STORED_COMBINATIONS = 7  # Validate legacy encrypted budget metadata during migration.
logger = logging.getLogger(__name__)


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


class ProfileSourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    ref: str = Field(pattern=r"^s[1-9][0-9]*$", max_length=16)


SourceT = TypeVar("SourceT", default=ProfileSource)


class ProfileFact(BaseModel, Generic[SourceT]):
    model_config = ConfigDict(extra="forbid")
    statement: str = Field(min_length=1, max_length=600)
    confidence: Literal["supported", "uncertain", "conflicting"]
    sources: list[SourceT] = Field(min_length=1, max_length=3)


class ProfileSection(BaseModel, Generic[SourceT]):
    model_config = ConfigDict(extra="forbid")
    kind: Literal[
        "business",
        "career",
        "education",
        "personal",
        "projects",
        "publications",
        "achievements",
        "community",
        "interests",
        "preferences",
        "dislikes",
        "style",
        "food",
        "travel",
        "entertainment",
        "shopping",
        "communication",
        "digital_presence",
        "public_records",
        "security",
    ]
    facts: list[ProfileFact[SourceT]] = Field(min_length=1, max_length=8)


class ProfileReport(BaseModel, Generic[SourceT]):
    model_config = ConfigDict(extra="forbid")
    match_status: Literal["matched", "uncertain", "no_match"]
    name: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=500)
    sections: list[ProfileSection[SourceT]] = Field(max_length=20)

    @model_validator(mode="after")
    def coherent_report(self) -> Self:
        if len({section.kind for section in self.sections}) != len(self.sections):
            raise ValueError("Duplicate sections")
        if (self.match_status == "no_match") != (len(self.sections) == 0):
            raise ValueError("A report needs findings or an explicit no-match result")
        return self


def profile_research_policy_fingerprint() -> str:
    """Bind cached drafts to the active authored research and evidence contract."""
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    task = next(child for child in _ONE_MANIFEST.subagents if child.id == "one_profile_research")
    search = next(child for child in _ONE_MANIFEST.subagents if child.id == "google_search")
    policy = {
        "receipt_policy": "exact-grounding-refs-sequential-v2",
        "instruction": task.system_instruction,
        "search_name": search.name,
        "search_description": search.description,
        "search_instruction": search.system_instruction,
        "model": task.model.model_dump(mode="json"),
        "resolved_model": resolve_fleet_model_name(task.model.name),
        "max_output_tokens": task.performance.max_output_tokens,
        "report_schema": ProfileReport.model_json_schema(),
        "research_schema": ProfileReport[ProfileSourceRef].model_json_schema(),
        "max_search_attempts": MAX_SEARCH_ATTEMPTS,
        "max_llm_calls": MAX_LLM_CALLS,
        "event_timeout_seconds": EVENT_TIMEOUT_SECONDS,
        "task_timeout_seconds": TASK_TIMEOUT_SECONDS,
        "identity_policy": "all-available-verified-owner-identifiers-single-search",
        "discovery_attempts": MAX_DISCOVERY_ATTEMPTS,
        "contact_disclosure": "full-verified-owner-request-no-scoring-v4",
    }
    return hashlib.sha256(
        json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def require_public_identity(
    identity: dict[str, str | None], contacts: dict[str, str | None]
) -> None:
    """Reject a name packet that embeds a withheld contact; never rewrite the name."""
    packet = json.dumps(identity, ensure_ascii=False).casefold()
    email = str(contacts.get("email") or "").casefold()
    phone = "".join(char for char in str(contacts.get("phone_number") or "") if char.isdigit())
    if (email and email in packet) or (
        len(phone) >= 7 and phone in "".join(char for char in packet if char.isdigit())
    ):
        raise ValueError("Public identity packet contains a withheld contact")


def exact_identity_query(identity: dict[str, str | None]) -> str:
    """Quote exact owner fields; no domains, aliases, phone masks or guessed name."""
    limits = {"full_name": 160, "email": 320, "phone_number": 64}
    if not identity or any(key not in limits for key in identity):
        raise ValueError("Unknown identity query field")
    values = []
    for key, maximum in limits.items():
        if key not in identity:
            continue
        value = identity[key]
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > maximum
            or any(ord(char) < 32 for char in value)
        ):
            raise ValueError("Missing or invalid exact identity query field")
        values.append(json.dumps(value, ensure_ascii=False))
    return " ".join(values)


async def run_profile_research(
    *,
    identity: dict[str, str | None],
    user_id: str,
    consent_token: str,
    require_access: Callable[[], Awaitable[None]],
    search_limit: int = MAX_SEARCH_ATTEMPTS,
    timeout_seconds: float = TASK_TIMEOUT_SECONDS,
    claim_call: Callable[[], None] | None = None,
    include_evidence: bool = False,
    research_focus: str = "broad",
    exact_query: str | None = None,
) -> dict[str, Any]:
    """Compose One's authored task with its existing Search child and shared runner."""
    from google.adk.agents import LlmAgent
    from google.adk.tools.agent_tool import AgentTool
    from google.genai import types

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import _ONE_MANIFEST, build_google_search_agent
    from hushh_mcp.one_adk.model_processing import regional_model
    from hushh_mcp.runtime_providers.gemini_config import (
        build_generate_content_config,
        resolve_fleet_model_name,
        thinking_config_for,
    )

    if not 1 <= search_limit <= MAX_SEARCH_ATTEMPTS or timeout_seconds <= 0:
        raise ValueError("Invalid research budget")
    task = next(child for child in _ONE_MANIFEST.subagents if child.id == "one_profile_research")
    model_name = resolve_fleet_model_name(task.model.name)
    model = regional_model(model_name)
    generation = build_generate_content_config(
        types,
        model_name,
        max_output_tokens=task.performance.max_output_tokens,
        thinking_config=thinking_config_for(model_name, task.model.thinking_level, types),
    )
    source_refs: dict[str, str] = {}
    exposed_refs: set[str] = set()
    source_receipts: dict[str, str] = {}
    suggestions: list[str] = []
    search_observed = False
    attempt_search_observed = False
    search_attempts = 0
    evidence: list[dict[str, Any]] = []

    # Exact discovery preserves all owner identifiers at the Search hop; the
    # narrower raw compatibility task keeps contacts out of that request.
    if exact_query is not None:
        if search_limit != 1 or exact_query != exact_identity_query(identity):
            raise ValueError("Exact search must bind one unchanged owner combination")
        search_identity = dict(identity)
    else:
        # Retain the narrower raw compatibility contract; the default verified
        # composite explicitly binds exact contact queries above.
        email = str(identity.get("email") or "")
        search_identity = {"full_name": identity.get("full_name")}
        domain = identity.get("organization_domain") or (
            email.rsplit("@", 1)[1] if "@" in email else None
        )
        if domain:
            search_identity["organization_domain"] = domain
        require_public_identity(search_identity, identity)

    async def before_model(callback_context: Any, llm_request: Any) -> None:
        await require_access()
        if claim_call is not None:
            claim_call()
        if (
            callback_context.agent_name == "one_profile_research"
            and search_attempts >= search_limit
        ):
            # The fifth call is for the model's report, not another search.
            # Limit the available action before generation; retain before_tool
            # rejection if a provider nevertheless emits a third Search call.
            llm_request.config.tool_config = types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=["finish_task"],
                )
            )

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
            if isinstance(uri, str) and callback_context.agent_name == "google_search":
                if uri not in source_refs:
                    source_refs[uri] = f"s{len(source_refs) + 1}"
                source_receipts[uri] = getattr(web, "title", None) or "Source"
        html = getattr(getattr(metadata, "search_entry_point", None), "rendered_content", None)
        if isinstance(html, str) and html and len(html) <= 40_000 and html not in suggestions:
            suggestions.append(html)

    async def before_tool(tool: Any, args: Any, tool_context: Any) -> None:
        nonlocal attempt_search_observed, search_attempts
        await require_access()
        if tool.name == "google_search":
            if exact_query is not None and args != {"request": exact_query}:
                # Validate rather than overwrite successful model arguments.
                raise ValueError("Search changed the exact owner query")
            if search_attempts >= search_limit:
                raise ValueError("Profile research allows only one Search follow-up")
            search_attempts += 1
            attempt_search_observed = False
            source_receipts.clear()

    async def after_tool(tool: Any, args: Any, tool_context: Any, tool_response: Any) -> Any:
        await require_access()
        if tool.name == "google_search":
            if exact_query is not None and not attempt_search_observed:
                raise ValueError("Search has no grounding execution receipt")
            # The model selects short references, not fragile redirect URLs.
            # Only received provider receipts can be resolved after completion;
            # this transports citations, never authors or repairs a finding.
            sources = [
                {"title": title, "ref": source_refs[url]}
                for url, title in list(source_receipts.items())[:20]
            ]
            exposed_refs.update(source["ref"] for source in sources)
            if include_evidence and attempt_search_observed:
                answer = (
                    tool_response
                    if isinstance(tool_response, str)
                    else json.dumps(tool_response, default=str)
                )
                # Ephemeral evidence for verification only; never a wire field,
                # checkpoint, telemetry value or PKM mutation.
                evidence.append(
                    {
                        "answer": answer[:16_000],
                        "sources": [
                            {**source, "url": url}
                            for source in sources
                            for url in source_receipts
                            if source_refs[url] == source["ref"]
                        ],
                    }
                )
            return {
                "answer": tool_response,
                "search_performed": attempt_search_observed,
                "searches_remaining": search_limit - search_attempts,
                "sources": sources,
            }
        return None

    search = build_google_search_agent(model=model)
    # This bounded task's policy applies to its child only, not all Search users.
    search.generate_content_config = generation
    search.before_model_callback = before_model
    search.after_model_callback = after_model
    agent = LlmAgent(
        name="one_profile_research",
        model=model,
        generate_content_config=generation,
        mode="task",
        instruction=task.system_instruction,
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[AgentTool(agent=search, propagate_grounding_metadata=True)],
        output_schema=ProfileReport[ProfileSourceRef],
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
        message=json.dumps(
            {
                "identity": search_identity,
                "exact_query": exact_query,
                "research_focus": research_focus,
                "search_limit": search_limit,
            },
            ensure_ascii=False,
        ),
        max_llm_calls=min(MAX_LLM_CALLS, 2 * search_limit + 1),
        # Search children do not stream their intermediate events to this
        # caller. Give the bounded job room to finish a real grounded search;
        # these are execution limits, not a browser request deadline.
        first_event_timeout_s=min(EVENT_TIMEOUT_SECONDS, timeout_seconds),
        between_event_timeout_s=min(EVENT_TIMEOUT_SECONDS, timeout_seconds),
        total_timeout_s=timeout_seconds,
    )
    await require_access()
    report = ProfileReport[ProfileSourceRef].model_validate(turn.structured_output)
    if not search_observed or (report.match_status == "no_match" and not attempt_search_observed):
        # A refusal or an offline answer is not evidence that no public match exists.
        raise ValueError("Profile research has no Search execution receipt")
    # Expand only model-selected exact refs. Unknown refs reject the whole
    # draft; no guessed URL, fuzzy matching, or replacement fact is allowed.
    urls_by_ref = {ref: url for url, ref in source_refs.items() if ref in exposed_refs}
    public_report = report.model_dump()
    for section in public_report["sections"]:
        for fact in section["facts"]:
            for source in fact["sources"]:
                ref = source.pop("ref")
                if ref not in urls_by_ref:
                    raise ValueError("Profile source has no Search grounding receipt")
                source["url"] = urls_by_ref[ref]
    # Preserve the existing wire shape and public-link validation.
    public_report = ProfileReport.model_validate(public_report).model_dump()
    result: dict[str, Any] = {"report": public_report, "search_suggestions": suggestions}
    if include_evidence:
        result["evidence"] = evidence
    return result


async def run_profile_discovery(
    *,
    identity: dict[str, str | None],
    user_id: str,
    consent_token: str,
    require_access: Callable[[], Awaitable[None]],
    researcher: Callable[..., Awaitable[dict[str, Any]]] | None = None,
    attempts_used: tuple[int, ...] = (),
    on_attempts_start: Callable[[tuple[int, ...]], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """One grounded owner research request; no assessor, threshold or query retries."""
    if len(set(attempts_used)) != len(attempts_used) or any(
        type(index) is not int or index != 1 for index in attempts_used
    ):
        raise ValueError("Invalid previously charged discovery slot")
    await require_access()
    if attempts_used:
        return {"status": "unavailable", "retry_exhausted": True, "attempts": 1}
    attempted = False
    stage = "admission"
    loop = asyncio.get_running_loop()
    deadline = loop.time() + TASK_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout(TASK_TIMEOUT_SECONDS):
            selected_identity: dict[str, str | None] = {}
            for key in ("full_name", "email", "phone_number"):
                value = identity.get(key)
                if isinstance(value, str) and value.strip():
                    selected_identity[key] = value
            query = exact_identity_query(selected_identity)
            if on_attempts_start is not None:
                await on_attempts_start((1,))
            attempted = True
            stage = "research"
            result = await (researcher or run_profile_research)(
                identity=selected_identity,
                exact_query=query,
                user_id=user_id,
                consent_token=consent_token,
                require_access=require_access,
                search_limit=1,
                research_focus="broad",
                timeout_seconds=deadline - loop.time(),
            )
            await require_access()
            # Preserve the researcher's report, including uncertainty and no-match.
            # Ordinary source/schema/owner validation remains; there is no score gate.
            report = ProfileReport.model_validate(result["report"]).model_dump()
            return {"report": report, "search_suggestions": result["search_suggestions"]}
    except PermissionError:
        raise
    except Exception as error:
        cause = error.__cause__ or error
        origin = "unknown"
        frame = cause.__traceback__
        while frame is not None:
            origin = f"{frame.tb_frame.f_code.co_name}:{frame.tb_lineno}"
            frame = frame.tb_next
        logger.warning(
            "one.profile_discovery_failed stage=%s error_type=%s cause_type=%s cause_origin=%s",
            stage,
            type(error).__name__,
            type(cause).__name__,
            origin,
        )
    await require_access()
    return (
        {"status": "unavailable", "retry_exhausted": True, "attempts": 1}
        if attempted
        else {"status": "unavailable"}
    )
