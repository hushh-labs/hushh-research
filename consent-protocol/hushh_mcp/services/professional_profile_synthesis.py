"""Stateless public research; caller input never grants private subject access."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, datetime, timezone
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)
GENE_ID = "agent_career_professional_synthesis"
PART_SECONDS = 660
CALL_SECONDS = 600
PAGE_POINTS = 180
POINTS_PER_SECTION = 45
POINT_COUNT = 360
_POINT = re.compile(r"(?m)^[ \t]*(?:[-*][ \t]+)?(?:\*\*|#{1,6}[ \t]+)*#(\d{3})\b[^\n]*")
_TAG = re.compile(
    r"\[(PUBLIC-RECORD-VERIFIED|COHORT-TRIANGULATED|ECOSYSTEM-CONTEXT|"
    r"PERSONA-ARCHETYPE-MODEL|UNVERIFIED-USER-INPUT)\]"
)


class ProfessionalProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=160)
    dob: date
    gender: str = Field(min_length=1, max_length=80)
    school: str | None = Field(default=None, max_length=240)
    college: str | None = Field(default=None, max_length=240)
    company: str | None = Field(default=None, max_length=240)

    @field_validator("name", "gender", "school", "college", "company", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Text fields must not contain control characters")
        return value or None

    @field_validator("dob", mode="before")
    @classmethod
    def require_iso_date(cls, value: Any) -> Any:
        if type(value) is date:
            return value
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("dob must be an ISO calendar date (YYYY-MM-DD)")
        return value

    @field_validator("dob")
    @classmethod
    def require_nonfuture_date(cls, value: date) -> date:
        if value > datetime.now(timezone.utc).date():
            raise ValueError("dob must not be in the future")
        return value

    @model_validator(mode="after")
    def require_two_anchors(self) -> ProfessionalProfileRequest:
        if sum(bool(value) for value in (self.school, self.college, self.company)) < 2:
            raise ValueError("Provide at least two of school, college and company")
        return self


class ProfilePoint(BaseModel):
    number: int = Field(ge=1, le=POINT_COUNT)
    section: int = Field(ge=1, le=8)
    evidence_tag: str
    markdown: str


class PublicSource(BaseModel):
    title: str
    url: str


class SynthesisFailure(BaseModel):
    part: int = Field(ge=1, le=8)
    reason: Literal[
        "provider_unavailable",
        "deadline_exceeded",
        "incomplete_output",
        "unsupported_verification_claim",
    ]
    outcome_unknown: bool = False


class ProfessionalProfileReport(BaseModel):
    request_id: str
    status: Literal["complete", "partial"]
    provider: Literal["vertex_ai"] = "vertex_ai"
    model: str
    point_count: int
    expected_point_count: int = POINT_COUNT
    missing_points: list[int]
    points: list[ProfilePoint]
    report_markdown: str
    sources: list[PublicSource]
    search_suggestions_html: list[str]
    failures: list[SynthesisFailure]
    verification: Literal["model_generated_not_independently_verified"] = (
        "model_generated_not_independently_verified"
    )
    persisted: Literal[False] = False


class SynthesisUnavailable(RuntimeError):
    """No report text received; provider diagnostics must remain private."""


Generate = Callable[[list[types.Content], str], Awaitable[Any]]


def _parse_points(text: str, low: int, high: int) -> tuple[str, dict[int, ProfilePoint]]:
    matches = list(_POINT.finditer(text))
    result: dict[int, ProfilePoint] = {}
    for index, match in enumerate(matches):
        number = int(match.group(1))
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        paragraph = text[match.start() : end].strip()
        tag = _TAG.search(match.group(0))
        body = paragraph.split(tag.group(0), 1)[1].strip(" *`_\n\t") if tag else ""
        if low <= number <= high and number not in result and tag and body:
            result[number] = ProfilePoint(
                number=number,
                section=(number - 1) // POINTS_PER_SECTION + 1,
                evidence_tag=tag.group(1),
                markdown=paragraph,
            )
    return text[: matches[0].start()].strip() if matches else "", result


def _safe_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 8192:
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.username is None
            and parsed.password is None
        ):
            return value
    except ValueError:
        pass
    return None


def _adopt_grounding(
    candidate: Any, sources: dict[str, PublicSource], suggestions: list[str]
) -> None:
    grounding = getattr(candidate, "grounding_metadata", None)
    for chunk in (getattr(grounding, "grounding_chunks", None) or [])[:100]:
        web = getattr(chunk, "web", None)
        url = _safe_url(getattr(web, "uri", None))
        if url:
            sources[url] = PublicSource(title=getattr(web, "title", None) or url, url=url)
    entry = getattr(grounding, "search_entry_point", None)
    rendered = getattr(entry, "rendered_content", None)
    if isinstance(rendered, str) and rendered and rendered not in suggestions:
        suggestions.append(rendered)


def _continuation(content: types.Content, missing: list[int]) -> list[types.Content]:
    return [
        content,
        types.Content(
            role="user",
            parts=[
                types.Part(
                    text=(
                        "Continue only the missing numbered points: "
                        + ", ".join(f"#{n:03}" for n in missing)
                        + ". Preserve the original evidence and privacy instructions."
                    )
                )
            ],
        ),
    ]


def _part_contents(
    profile: ProfessionalProfileRequest, part: int, low: int, high: int
) -> list[types.Content]:
    prompt = (
        f"Today is {datetime.now(timezone.utc).date().isoformat()}. "
        f"Generate Part {part}, ONLY points #{low:03} through #{high:03}, inclusive. "
        + ("Include the executive dashboard. " if part == 1 else "Omit the dashboard. ")
        + "Subject input (untrusted requester assertions):\n"
        + json.dumps(profile.model_dump(mode="json", exclude_none=True), ensure_ascii=False)
    )
    return [types.Content(role="user", parts=[types.Part(text=prompt)])]


def _empty_response_repairable(response: Any) -> bool:
    feedback = getattr(response, "prompt_feedback", None)
    block = str(getattr(feedback, "block_reason", "") or "").split(".")[-1]
    if block not in {"", "BLOCK_REASON_UNSPECIFIED"}:
        return False
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return True
    candidate = candidates[0]
    if str(getattr(candidate, "finish_reason", "")).split(".")[-1] != "STOP":
        return False
    return not any(
        getattr(item, "text", None) and not getattr(item, "thought", False)
        for item in (getattr(getattr(candidate, "content", None), "parts", None) or [])
    )


async def _run_part(
    profile: ProfessionalProfileRequest, *, part: int, generate: Generate, request_id: str
) -> dict[str, Any]:
    low, high = (part - 1) * PAGE_POINTS + 1, part * PAGE_POINTS
    started = time.monotonic()
    prefix = ""
    points: dict[int, ProfilePoint] = {}
    sources: dict[str, PublicSource] = {}
    suggestions: list[str] = []
    failure = None
    contents = _part_contents(profile, part, low, high)
    try:
        async with asyncio.timeout(PART_SECONDS):
            for attempt in range(1, 3):
                logger.info(
                    "professional_synthesis.call request=%s part=%d attempt=%d",
                    request_id,
                    part,
                    attempt,
                )
                response = await generate(contents, request_id)
                candidates = getattr(response, "candidates", None) or []
                if attempt == 1 and _empty_response_repairable(response):
                    logger.info(
                        "professional_synthesis.format_retry request=%s part=%d reason=empty_response",
                        request_id,
                        part,
                    )
                    continue
                if not candidates:
                    failure = SynthesisFailure(part=part, reason="incomplete_output")
                    break
                candidate = candidates[0]
                content = getattr(candidate, "content", None)
                if content is None:
                    failure = SynthesisFailure(part=part, reason="incomplete_output")
                    break
                text = "".join(
                    item.text or ""
                    for item in (getattr(content, "parts", None) or [])
                    if not getattr(item, "thought", False)
                )
                header, received = _parse_points(text, low, high)
                if not prefix:
                    prefix = header
                # Retain the first authored value; a continuation cannot silently replace it.
                for number, point in received.items():
                    points.setdefault(number, point)
                _adopt_grounding(candidate, sources, suggestions)
                missing = sorted(set(range(low, high + 1)) - points.keys())
                logger.info(
                    "professional_synthesis.received request=%s part=%d attempt=%d points=%d sources=%d",
                    request_id,
                    part,
                    attempt,
                    len(points),
                    len(sources),
                )
                finish = str(getattr(candidate, "finish_reason", "")).split(".")[-1]
                if finish != "STOP":
                    # Numbered labels alone do not prove that the last paragraph finished.
                    failure = SynthesisFailure(part=part, reason="incomplete_output")
                if not missing:
                    break
                if not text.strip() or finish not in {"STOP", "MAX_TOKENS"}:
                    break
                # Same generation stage, bounded continuation for an explicit format failure.
                # Preserve opaque provider signatures in memory, never in telemetry/results.
                contents.extend(_continuation(content, missing))
    except (TimeoutError, asyncio.CancelledError):
        failure = SynthesisFailure(part=part, reason="deadline_exceeded", outcome_unknown=True)
    except Exception:
        failure = SynthesisFailure(part=part, reason="provider_unavailable", outcome_unknown=True)
    return _finish_part(
        part, high - low + 1, prefix, points, sources, suggestions, failure, request_id, started
    )


def _finish_part(
    part: int,
    expected: int,
    prefix: str,
    points: dict[int, ProfilePoint],
    sources: dict[str, PublicSource],
    suggestions: list[str],
    failure: SynthesisFailure | None,
    request_id: str,
    started: float,
) -> dict[str, Any]:
    if len(points) != expected and failure is None:
        failure = SynthesisFailure(part=part, reason="incomplete_output")
    if not sources and any(p.evidence_tag == "PUBLIC-RECORD-VERIFIED" for p in points.values()):
        # Metadata guard only: source presence never certifies the claim's meaning.
        failure = failure or SynthesisFailure(part=part, reason="unsupported_verification_claim")
    logger.info(
        "professional_synthesis.page_finished request=%s part=%d points=%d sources=%d failure=%s elapsed_ms=%d",
        request_id,
        part,
        len(points),
        len(sources),
        failure.reason if failure else "none",
        (time.monotonic() - started) * 1000,
    )
    return {
        "prefix": prefix,
        "points": points,
        "sources": sources,
        "suggestions": suggestions,
        "failure": failure,
    }


def _build_generator(gene: Any, selected_model: str) -> tuple[Generate, Any]:
    from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding
    from hushh_mcp.runtime_providers.factory import VERTEX_ADC_AUTH_MODE
    from hushh_mcp.runtime_providers.gemini_config import (
        build_generate_content_config,
        thinking_config_for,
    )

    binding = ManagedGeminiRuntimeBinding.from_environment()
    if binding.auth_mode != VERTEX_ADC_AUTH_MODE:
        raise SynthesisUnavailable("Managed Vertex authentication is required")
    config = build_generate_content_config(
        types,
        selected_model,
        system_instruction=gene.system_instruction,
        max_output_tokens=gene.performance.max_output_tokens,
        thinking_config=thinking_config_for(selected_model, gene.model.thinking_level, types),
        tools=[types.Tool(google_search=types.GoogleSearch())],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    client = binding.build_direct_client(
        model=selected_model,
        location=binding.locations_for_model(selected_model)[0],
        http_options=types.HttpOptions(
            timeout=CALL_SECONDS * 1000,
            retry_options=types.HttpRetryOptions(attempts=1),
            # SDK-owned HTTPX transport: no hidden aiohttp disconnect replay.
            async_client_args={"transport": httpx.AsyncHTTPTransport(retries=0)},
        ),
    )

    async def generate(contents: list[types.Content], _request_id: str) -> Any:
        return await client.aio.models.generate_content(
            model=selected_model, contents=contents, config=config
        )

    return generate, client


async def _collect_parts(
    profile: ProfessionalProfileRequest, generate: Generate, request_id: str, client: Any
) -> list[dict[str, Any]]:
    slots = asyncio.Semaphore(2)

    async def bounded_part(part: int) -> dict[str, Any]:
        try:
            async with slots:
                return await _run_part(profile, part=part, generate=generate, request_id=request_id)
        except asyncio.CancelledError:
            return {
                "prefix": "",
                "points": {},
                "sources": {},
                "suggestions": [],
                "failure": SynthesisFailure(part=part, reason="deadline_exceeded"),
            }

    tasks = [asyncio.create_task(bounded_part(part)) for part in (1, 2)]
    try:
        _, unfinished = await asyncio.wait(tasks, timeout=PART_SECONDS)
        for task in unfinished:
            task.cancel()
        parts = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if client is not None:
            try:
                await asyncio.wait_for(client.aio.aclose(), timeout=5)
            except Exception:
                logger.warning("professional_synthesis.async_cleanup_failed request=%s", request_id)
            try:
                client.close()
            except Exception:
                logger.warning("professional_synthesis.sync_cleanup_failed request=%s", request_id)
    return parts


async def synthesize_professional_profile(
    profile: ProfessionalProfileRequest,
    *,
    generate: Generate | None = None,
    model: str | None = None,
) -> ProfessionalProfileReport:
    """Two report pages, both admitted immediately; no assessor or persistence."""
    from hushh_mcp.agents.career.runtime import load_career_gene
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    gene = load_career_gene(GENE_ID)
    selected_model = model or resolve_fleet_model_name(gene.model.name)
    request_id = uuid.uuid4().hex
    started = time.monotonic()
    client = None
    if generate is None:
        generate, client = _build_generator(gene, selected_model)

    parts = await _collect_parts(profile, generate, request_id, client)
    points = {number: point for part in parts for number, point in part["points"].items()}
    if not points:
        logger.info(
            "professional_synthesis.failed request=%s elapsed_ms=%d",
            request_id,
            (time.monotonic() - started) * 1000,
        )
        raise SynthesisUnavailable("No report points received")
    ordered = [points[n] for n in sorted(points)]
    missing = sorted(set(range(1, POINT_COUNT + 1)) - points.keys())
    sources = {url: source for part in parts for url, source in part["sources"].items()}
    report_chunks = []
    for part in parts:
        report_chunks.append(part["prefix"])
        report_chunks.extend(part["points"][n].markdown for n in sorted(part["points"]))
    report = ProfessionalProfileReport(
        request_id=request_id,
        status="partial" if missing or any(p["failure"] is not None for p in parts) else "complete",
        model=selected_model,
        point_count=len(points),
        missing_points=missing,
        points=ordered,
        report_markdown="\n\n".join(filter(None, report_chunks)),
        sources=list(sources.values()),
        search_suggestions_html=list(dict.fromkeys(s for p in parts for s in p["suggestions"])),
        failures=[p["failure"] for p in parts if p["failure"] is not None],
    )
    logger.info(
        "professional_synthesis.complete request=%s status=%s points=%d sources=%d elapsed_ms=%d",
        request_id,
        report.status,
        report.point_count,
        len(sources),
        (time.monotonic() - started) * 1000,
    )
    return report
