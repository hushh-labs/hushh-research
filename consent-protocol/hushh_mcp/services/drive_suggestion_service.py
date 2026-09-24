"""No-tools suggestion stage fenced by a durable, narrowly consented job.

The background runner is NOT an A2A caller and has no Vault Owner token. Its
information authority is the current preparation lease and exact per-document
processing consent, rechecked before every read/model call and publication.
"""

import asyncio
import json
import logging
import re
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services.drive_document_retrieval import (
    DriveDocumentReader,
    DriveSuggestionRetrievalStore,
)
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    LiveReviewedSource,
    ReviewedSource,
)
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = logging.getLogger(__name__)


MAX_SOURCE_REFS = 8


def _bounded_source_refs(value: list[str]) -> list[str]:
    if not 1 <= len(value) <= MAX_SOURCE_REFS:
        raise ValueError("source_refs must hold 1 to 8 refs")
    return value


# Vertex rejects this response schema (400 INVALID_ARGUMENT, measured
# 2026-09-25) when both nested lists also bound their source_refs arrays: the
# item limits multiply past its schema limit. The bound is enforced here, after
# the model answers, instead of inside the schema the model is given.
class SuggestedFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    document_ref: str = Field(min_length=36, max_length=36)
    source_refs: list[str]

    @field_validator("source_refs")
    @classmethod
    def _refs(cls, value: list[str]) -> list[str]:
        return _bounded_source_refs(value)


class DocumentSuggestions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    files: list[SuggestedFile] = Field(max_length=8)
    coverage_summary: str = Field(min_length=1, max_length=2000)
    gaps: list[str] = Field(max_length=24)
    coverage_status: Literal["complete", "partial", "unknown"]
    covered_periods: list["CoveredPeriod"] = Field(default_factory=list, max_length=24)


class CoveredPeriod(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    period_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    period_end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_refs: list[str]

    @field_validator("source_refs")
    @classmethod
    def _refs(cls, value: list[str]) -> list[str]:
        return _bounded_source_refs(value)


def period_covered(
    purpose: dict, periods: list[CoveredPeriod], known: dict, ids: list[str]
) -> bool:
    start_text, end_text = purpose.get("periodStart"), purpose.get("periodEnd")
    if not start_text or not end_text:
        return True
    try:
        start, end = (
            date.fromisoformat(start_text).toordinal(),
            date.fromisoformat(end_text).toordinal(),
        )
        spans = []
        for item in periods:
            if any(
                ref not in known or known[ref]["document_ref"] not in ids
                for ref in item.source_refs
            ):
                return False
            left = date.fromisoformat(item.period_start).toordinal()
            right = date.fromisoformat(item.period_end).toordinal()
            if right < left:
                return False
            spans.append((left, right))
    except ValueError:
        return False
    cursor = start
    for left, right in sorted(spans):
        if left > cursor:
            return False
        cursor = max(cursor, right + 1)
        if cursor > end:
            return True
    return False


_FILE_NOUN = re.compile(
    r"\b(?:files?|documents?|pdfs?|spreadsheets?|sheets?|slides?|presentations?)\b",
    re.IGNORECASE,
)
_FILE_ACTIVITY = re.compile(
    r"\b(?:recent(?:ly)?|latest|today|yesterday|modified|created|uploaded|updated|changed|added)\b"
    r"|\b(?:last|past)\s+(?:the\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"few|a\s+few)\s+(?:days?|weeks?|hours?)\b",
    re.IGNORECASE,
)
_EXPLICIT_METADATA_VERB = re.compile(
    r"\b(?:modified|created|uploaded|updated|changed|added)\b", re.IGNORECASE
)
_CONTENT_COVERAGE_CUE = re.compile(
    r"\b(?:cover(?:ing|ed|s)?|coverage|statements?|invoices?|transactions?|records?|reports?)\b"
    r"|\bfor\s+(?:the\s+)?(?:last|past|period)\b",
    re.IGNORECASE,
)


def explicitly_requests_file_activity(purpose: str) -> bool:
    """Require clear file-recency wording before a complete, auto-trustable review."""
    return bool(
        _FILE_NOUN.search(purpose)
        and _FILE_ACTIVITY.search(purpose)
        and (not _CONTENT_COVERAGE_CUE.search(purpose) or _EXPLICIT_METADATA_VERB.search(purpose))
    )


MAX_DATE_RANGE_DAYS = 366
# Start of the metadata window for files the owner picked by hand.
OWNER_SELECTION_START = "1970-01-01T00:00:00Z"


def _zone(timezone: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _utc_text(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


class LiveSearchPlan(BaseModel):
    """What to look for, in the Drive MCP's own terms; the reader compiles it.

    Every field is bounded and typed: the planner never writes query syntax.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    terms: list[str] = Field(default_factory=list, max_length=3)
    # Omitted intent may discover metadata, but must never trigger a content read.
    mode: Literal["find", "read"] = "find"
    exact_title: str | None = Field(default=None, max_length=1024)
    relative_days: int | None = Field(default=None, ge=1, le=31)
    file_time_field: Literal["modifiedTime", "createdTime"] = "modifiedTime"
    time_intent: Literal["file_activity", "document_coverage"] = "document_coverage"
    # A file type is a mimeType clause, never a title or full-text word.
    file_kind: Literal[
        "any", "document", "spreadsheet", "presentation", "pdf", "image", "video", "audio", "folder"
    ] = "any"
    # Calendar days in the owner's timezone, inclusive ("24th September").
    date_from: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    date_to: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    shared_with_me: bool = False
    sort: Literal["relevance", "recent"] = "relevance"

    @model_validator(mode="after")
    def require_search_boundary(self):
        dated = self.date_from is not None or self.date_to is not None
        if not (
            self.terms
            or self.relative_days is not None
            or dated
            or self.file_kind != "any"
            or self.shared_with_me
            or self.sort == "recent"
        ):
            raise ValueError("search terms, a file type, a date range or a recent listing required")
        if (self.relative_days is not None or dated) and self.time_intent != "file_activity":
            raise ValueError("a file date range requires explicit file activity intent")
        if self.relative_days is not None and dated:
            raise ValueError("use either relative days or calendar dates")
        if dated:
            # Explicit ranges are checked as written; only an open "since" is bounded later.
            start = date.fromisoformat(self.date_from or self.date_to or "")
            end = date.fromisoformat(self.date_to or self.date_from or "")
            if self.date_to is not None and (
                end < start or (end - start).days >= MAX_DATE_RANGE_DAYS
            ):
                raise ValueError("the calendar date range is invalid")
        return self

    def title_dates(self, now_utc: datetime, timezone: str = "UTC") -> list[str]:
        """Calendar days (at most 3) that a meeting title may carry, e.g. 2026/09/24."""
        if self.date_from is None and self.date_to is None:
            return []
        start, end = self._dates(now_utc.astimezone(_zone(timezone)).date())
        span = (end - start).days + 1
        if span > 3:
            return []
        return [(start + timedelta(days=offset)).isoformat() for offset in range(span)]

    def _dates(self, today: date) -> tuple[date, date]:
        """date_from alone means "since then, through today"; date_to alone is that day."""
        if self.date_from is None:
            end = date.fromisoformat(self.date_to or "")
            return end, end
        start = date.fromisoformat(self.date_from)
        end = date.fromisoformat(self.date_to) if self.date_to is not None else today
        # A long "since" is bounded; the reply states the window actually searched.
        return max(start, end - timedelta(days=MAX_DATE_RANGE_DAYS - 1)), end

    def time_bounds(self, now_utc: datetime, timezone: str = "UTC") -> tuple[str, str] | None:
        if now_utc.tzinfo is None or now_utc.utcoffset() is None:
            raise ValueError("current search time must include a timezone")
        if self.relative_days is not None:
            end = now_utc.astimezone(UTC)
            start = end - timedelta(days=self.relative_days)
            return _utc_text(start), _utc_text(end)
        if self.date_from is None and self.date_to is None:
            return None
        zone = _zone(timezone)
        first, last = self._dates(now_utc.astimezone(zone).date())
        start = datetime.combine(first, time.min, tzinfo=zone)
        end = datetime.combine(last + timedelta(days=1), time.min, tzinfo=zone)
        return _utc_text(start), _utc_text(end)


async def interpret_live_search(*, prompt, user_id):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_live_search")
    agent = build_single_turn_agent(
        gene,
        output_schema=LiveSearchPlan,
    )
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=20,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


async def interpret_suggestions(*, prompt, user_id):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_suggestions")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid suggestion interpreter")
    agent = build_single_turn_agent(
        gene,
        output_schema=DocumentSuggestions,
    )
    # Empty context grants no tool capability. Never mint/persist an owner
    # session to emulate an online user. The caller owns durable job fences.
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=20,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


class DriveSuggestionService:
    def __init__(
        self,
        *,
        oauth=None,
        store=None,
        interpreter=interpret_suggestions,
        search_planner=interpret_live_search,
        reader_factory=None,
        require_owner=None,
    ):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveSuggestionStore(db=self.oauth.lifecycle.db)
        self.interpreter = interpreter
        self.search_planner = search_planner
        self.reader_factory = reader_factory
        self.require_owner = require_owner

    async def _require_current(self, job):
        if self.require_owner is not None:
            await self.require_owner()
        await self.store.require_preparation_current(job)

    def _reader(self, job):
        async def require_access():
            await self._require_current(job)

        if self.reader_factory:
            return self.reader_factory(user_id=job["user_id"], require_access=require_access)
        if job.get("live"):
            return DriveLiveReader(
                user_id=job["user_id"], require_access=require_access, oauth=self.oauth
            )
        return DriveDocumentReader(
            user_id=job["user_id"],
            require_access=require_access,
            oauth=self.oauth,
            store=DriveSuggestionRetrievalStore(db=self.store.db, cipher=self.store.cipher),
        )

    async def run_one(self, *, user_id, request_id, owner_selected=None):
        """Prepare one review. owner_selected: files A chose from B's answered
        question; they are bound by metadata only, with no planner, model or read.
        """
        if self.require_owner is not None:
            await self.require_owner()
        if owner_selected is not None and self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        job = await self.store.claim_preparation(
            user_id=user_id,
            request_id=request_id,
            **({"foreground": True} if self.require_owner is not None else {}),
            **({"owner_selected": True} if owner_selected is not None else {}),
        )
        if job is None:
            return "not_claimed"
        stage = "reader"
        try:
            async with asyncio.timeout(160):
                reader = self._reader(job)
                query = job["purpose"]["purpose"]
                if len(query.encode()) > 2048:
                    raise DriveSharingError("narrow_selection_required")
                metadata_recency = False
                if owner_selected is not None:
                    if not job.get("live"):
                        raise DriveSharingError("sharing_unavailable")
                    await self._require_current(job)
                    stage = "bind_owner_selection"
                    # Metadata-only binding needs a window; any current file is in it.
                    retrieved = await reader.bind_matches(
                        matches=owner_selected,
                        truncated=False,
                        time_field="modifiedTime",
                        start_time=OWNER_SELECTION_START,
                        end_time=_utc_text(
                            (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
                        ),
                    )
                elif job.get("live"):
                    await self._require_current(job)
                    stage = "search_plan"
                    requested_at = job.get("requested_at")
                    if requested_at is None:
                        # Compatibility for test doubles created before the
                        # request timestamp was included in the preparation job.
                        now_utc = datetime.now(UTC)
                    elif (
                        isinstance(requested_at, datetime)
                        and requested_at.tzinfo is not None
                        and requested_at.utcoffset() is not None
                    ):
                        now_utc = requested_at.astimezone(UTC)
                    else:
                        raise ValueError("invalid request timestamp")
                    plan = LiveSearchPlan.model_validate(
                        await self.search_planner(
                            prompt=json.dumps(
                                {
                                    "document_request": job["purpose"],
                                    "current_time_utc": now_utc.isoformat(timespec="seconds"),
                                },
                                ensure_ascii=False,
                            ),
                            user_id=user_id,
                        )
                    )
                    await self._require_current(job)
                    requested_period = bool(
                        job["purpose"].get("periodStart") or job["purpose"].get("periodEnd")
                    )
                    # The request card may include dates for a request about
                    # file activity. The typed plan distinguishes that from
                    # dates the document's contents must cover.
                    file_recency = (
                        (
                            plan.relative_days is not None
                            or plan.date_from is not None
                            or plan.date_to is not None
                        )
                        and plan.mode == "find"
                        and plan.time_intent == "file_activity"
                    )
                    if requested_period and not file_recency and not plan.terms:
                        raise DriveReadError("narrow_selection_required")
                    bounds = (
                        plan.time_bounds(now_utc) if file_recency or not requested_period else None
                    )
                    search_args = {
                        "query": plan.terms,
                        "file_kind": plan.file_kind,
                        "shared_with_me": plan.shared_with_me,
                        # "latest" is the planner's sort, as in the chat lane.
                        "recent": plan.sort == "recent",
                    }
                    if bounds is not None:
                        search_args.update(
                            time_field=plan.file_time_field,
                            start_time=bounds[0],
                            end_time=bounds[1],
                        )
                    metadata_recency = file_recency and bounds is not None
                    if metadata_recency:
                        stage = "find_files"
                        found = await reader.find(**search_args)
                        if plan.exact_title:
                            matches = [
                                item
                                for item in found["matches"]
                                if item["name"].casefold() == plan.exact_title.casefold()
                            ]
                            found = {
                                **found,
                                "matches": matches,
                                "truncated": found["truncated"] or len(matches) > 1,
                            }
                        stage = "bind_files"
                        retrieved = await reader.bind_matches(
                            matches=found["matches"],
                            truncated=found["truncated"],
                            time_field=plan.file_time_field,
                            start_time=bounds[0],
                            end_time=bounds[1],
                        )
                    else:
                        # Same two steps as the chat lane: a typed metadata
                        # search (kind, sharedWithMe, window), then reads of
                        # exactly the files it found.
                        stage = "search_files"
                        found = await reader.find(**search_args)
                        stage = "read_file_content"
                        retrieved = await reader.read_matches(
                            matches=found["matches"], truncated=found["truncated"]
                        )
                else:
                    stage = "search_files"
                    retrieved = await reader.search(query=query)
                if not retrieved["untrusted_external_content"]:
                    await self.store.fail_preparation(
                        job,
                        code="no_ready_files",
                        retryable=owner_selected is None and await self.store.indexing_pending(job),
                    )
                    return "no_ready_files"
                await reader.require_current()
                await self._require_current(job)
                if owner_selected is not None:
                    # A's own explicit choice, not a model or host judgement.
                    bound = retrieved["untrusted_external_content"]
                    answer = DocumentSuggestions(
                        files=[
                            SuggestedFile(
                                document_ref=item["document_ref"],
                                source_refs=[item["source_ref"]],
                            )
                            for item in bound
                        ],
                        coverage_summary=f"{len(bound)} files you chose to share.",
                        gaps=(
                            ["Some chosen files changed or can no longer be shared."]
                            if retrieved["truncated"]
                            else []
                        ),
                        coverage_status="unknown",
                    )
                elif metadata_recency:
                    # This request is about when files changed, not dates inside
                    # their contents. Every candidate came from the bounded Drive
                    # date query and was verified again by bind_matches.
                    bounded = retrieved["untrusted_external_content"]
                    explicit_file_activity = explicitly_requests_file_activity(query)
                    complete = not retrieved["truncated"] and explicit_file_activity
                    gaps = []
                    if retrieved["truncated"]:
                        gaps.append("Additional matching files may exist.")
                    if not explicit_file_activity:
                        gaps.append("Confirm which recent files the requester meant.")
                    answer = DocumentSuggestions(
                        files=[
                            SuggestedFile(
                                document_ref=item["document_ref"],
                                source_refs=[item["source_ref"]],
                            )
                            for item in bounded
                        ],
                        coverage_summary=(
                            f"Found {len(bounded)} files with "
                            f"{plan.file_time_field} from {bounds[0]} to {bounds[1]}."
                        ),
                        gaps=gaps,
                        coverage_status="complete" if complete else "partial",
                    )
                else:
                    stage = "interpret"
                    answer = DocumentSuggestions.model_validate(
                        await self.interpreter(
                            prompt=json.dumps(
                                {
                                    "document_request": job["purpose"],
                                    "retrieved_documents": retrieved,
                                },
                                ensure_ascii=False,
                            ),
                            user_id=user_id,
                        )
                    )
                payload = answer.model_dump(mode="json")
                if len(json.dumps(payload, ensure_ascii=False).encode()) > 12 * 1024:
                    raise ValueError("suggestions exceed budget")
                known = {
                    item["source_ref"]: item for item in retrieved["untrusted_external_content"]
                }
                ids = [item.document_ref for item in answer.files]
                if len(ids) != len(set(ids)) or (
                    answer.coverage_status == "complete" and (retrieved["truncated"] or not ids)
                ):
                    raise ValueError("unsupported coverage")
                for item in answer.files:
                    if len(item.source_refs) != len(set(item.source_refs)) or any(
                        ref not in known or known[ref]["document_ref"] != item.document_ref
                        for ref in item.source_refs
                    ):
                        raise ValueError("invented suggestion reference")
                if (
                    answer.coverage_status == "complete"
                    and not metadata_recency
                    and owner_selected is None
                    and not period_covered(job["purpose"], answer.covered_periods, known, ids)
                ):
                    raise ValueError("unsupported coverage")
                await reader.require_current()
                await self._require_current(job)
                observed = {
                    str(row["document_id"]): (
                        LiveReviewedSource if row.get("_live") else ReviewedSource
                    ).model_validate(self.store._source_terms(row))
                    for row in reader._rows
                }
                if set(ids) - observed.keys():
                    raise ValueError("unobserved suggestion source")
                stage = "publish_review"
                await self.store.prepare_review(
                    user_id=user_id,
                    generation=job["generation"],
                    request_id=request_id,
                    expected_revision=job["revision"],
                    document_ids=ids,
                    observed_sources=[observed[identifier] for identifier in ids],
                    coverage={
                        **payload,
                        "truncated": retrieved["truncated"],
                        "semanticStage": "completed",
                    },
                    preparation_lease_id=job["lease_id"],
                    read_sources=list(observed.values()),
                    live_sources=reader._rows if job.get("live") else None,
                    **({"foreground": True} if self.require_owner is not None else {}),
                )
                await wake_drive_work("sharing")
                return "review_ready"
        except Exception as error:
            code = str(error) if isinstance(error, DriveReadError) else "preparation_unavailable"
            if isinstance(error, DriveReadError):
                logger.warning("drive_suggestion.prepare_failed stage=%s code=%s", stage, code)
            else:
                logger.warning(
                    "drive_suggestion.prepare_failed stage=%s type=%s",
                    stage,
                    type(error).__name__,
                )
            await self.store.fail_preparation(
                job,
                code=code,
                # A's hand-picked selection is never re-run by the background worker.
                retryable=owner_selected is None
                and (not isinstance(error, DriveReadError) or error.retryable),
            )
            return "unavailable"
