"""Checkpointed Drive REST metadata collection under explicit per-search consent.

The planner runs once in the authenticated route. This service freezes that
plan; background work never invokes a model, reads contents, or grants access.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_live_reader import MIME_CLAUSES, DriveLiveReader, _open_url
from hushh_mcp.services.drive_long_range_listing import _term_pattern
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_sharing_contract import request_requires_explicit_dates
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import FILE_ID, RESOURCE_KEY, DriveReadError
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

PAGE_SIZE = 25
FILE_LIST_PAGE_SIZE = 100
MAX_SLICE_PAGES = 4
SLICE_SECONDS = 90
MAX_REQUEST_FILE_PAGES = 1000
MAX_REQUEST_FOLDERS = 1000
MAX_CHECKPOINT_BYTES = 96 * 1024
FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
DOCUMENT_MIMES = frozenset(
    {
        "application/vnd.google-apps.document",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.oasis.opendocument.text",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/rtf",
        "application/rtf",
    }
)
logger = drive_logger("drive_owner_search")
_MONTH_WINDOW = re.compile(
    r"\b(?:last|past)\s+(?P<count>\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?\b",
    re.I,
)
_MONTH_WORDS = {
    word: index
    for index, word in enumerate(
        (
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
        ),
        1,
    )
}
_TITLE_DATE = re.compile(r"(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)")
_TITLE_TIME = re.compile(
    r"[ T](?P<hour>\d{1,2}):(?P<minute>\d{2})\s*"
    r"(?P<zone>IST|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?)\b",
    re.I,
)
_YESTERDAY = re.compile(r"\byesterday(?:['’]?s)?\b", re.I)
_NOTE_TITLE = re.compile(r"\b(?:notes?|minutes)\b", re.I)
_TERM_COORDINATOR = re.compile(r"(?:,|and|or|&|,\s*(?:and|or|&))", re.I)


def _coordinated_alternatives(terms: list[str], purpose: str) -> bool:
    """Use OR only when the requester explicitly lists separate subjects."""
    if not 2 <= len(terms) <= 3:
        return False
    matches = []
    for term in terms:
        match = _term_pattern(term.casefold()).search(purpose)
        if match is None:
            return False
        matches.append(match)
    ordered = sorted(matches, key=lambda match: match.start())
    return all(
        _TERM_COORDINATOR.fullmatch(purpose[left.end() : right.start()].strip())
        for left, right in zip(ordered[:-1], ordered[1:], strict=True)
    )


def _request_kind_clause(kind: str) -> str | None:
    if kind == "any":
        return None
    if kind == "document":
        return "(" + " or ".join(f"mimeType = '{mime}'" for mime in sorted(DOCUMENT_MIMES)) + ")"
    return MIME_CLAUSES[kind]


def _request_discovery_clause(kind: str) -> str | None:
    clause = _request_kind_clause(kind)
    return (
        f"({clause} or mimeType = '{SHORTCUT_MIME}' or mimeType = '{FOLDER_MIME}')"
        if clause
        else None
    )


def _subject_matches(checkpoint: dict, title: str) -> bool:
    exact = checkpoint.get("request_exact_title")
    if exact:
        return title == exact
    # A generic "notes" folder is not evidence of the requested meeting topic.
    terms = [
        term
        for term in checkpoint.get("request_subject_terms", [])
        if term.casefold() not in {"note", "notes", "document", "documents", "file", "files"}
    ]
    return any(
        _term_pattern(
            "standup" if term.casefold() in {"standup", "stand up", "stand-up"} else term.casefold()
        ).search(title)
        for term in terms
    )


def _trusted_subject_matches(checkpoint: dict, match: dict) -> bool:
    """Require title evidence before granting access without owner review."""
    # A shortcut alias can describe a different file. Its target is what Drive
    # grants, so only the target's own title can authorize automatic sharing.
    title = match["name"]
    exact = checkpoint.get("request_exact_title")
    if exact:
        return exact == title
    terms = [
        term
        for term in checkpoint.get("request_subject_terms", [])
        if term.casefold() not in {"note", "notes", "document", "documents", "file", "files"}
    ]
    if not terms:
        return True
    matches = [
        bool(
            _term_pattern(
                "standup"
                if term.casefold() in {"standup", "stand up", "stand-up"}
                else term.casefold()
            ).search(title)
        )
        for term in terms
    ]
    request_text = checkpoint.get("request", {}).get("query", "")
    return any(matches) if _coordinated_alternatives(terms, request_text) else all(matches)


def _note_candidate(checkpoint: dict, match: dict, *, folder_scoped: bool) -> bool:
    if checkpoint.get("authority_mode") == "trusted_auto" and not _trusted_subject_matches(
        checkpoint, match
    ):
        return False
    if not checkpoint.get("request_notes"):
        return True
    # The compilation lane uses these same title checks: a topical folder
    # does not turn an agenda, recording, or budget into a requested note.
    from hushh_mcp.services.drive_content_compilation import _GEMINI_NOTE_TITLE, _NON_NOTE_TITLE

    name = match["name"]
    alias = match.get("shortcut_name", "")
    if checkpoint.get("authority_mode") == "trusted_auto":
        # Google Drive fullText may match an incidental mention inside a
        # generic document. Automatic grants need positive title evidence;
        # an owner-reviewed search can still show the broader candidates.
        return not (_NON_NOTE_TITLE.search(name) or _NON_NOTE_TITLE.search(alias)) and bool(
            _NOTE_TITLE.search(name)
        )
    return not (_NON_NOTE_TITLE.search(name) or _NON_NOTE_TITLE.search(alias)) and (
        not folder_scoped
        or bool(_GEMINI_NOTE_TITLE.search(name) or _GEMINI_NOTE_TITLE.search(alias))
        or _subject_matches(checkpoint, name)
        or _subject_matches(checkpoint, alias)
    )


def _shareability(source: dict) -> dict:
    """Carry Drive's owner-specific permission fact into the frozen review.

    An omitted capability is not permission to share. The sharing worker
    rechecks an affirmative capability against current Drive state.
    """
    capabilities = source.get("capabilities")
    encryption = source.get("clientEncryptionDetails")
    if encryption is not None and (
        not isinstance(encryption, dict) or encryption.get("encryptionState") != "unencrypted"
    ):
        return {"shareable": False, "unavailableReason": "source_not_shareable"}
    if isinstance(capabilities, dict) and capabilities.get("canShare") is True:
        return {"shareable": True}
    if isinstance(capabilities, dict) and capabilities.get("canShare") is False:
        return {"shareable": False, "unavailableReason": "source_not_shareable"}
    return {"shareable": False, "unavailableReason": "shareability_unverified"}


def _counter(checkpoint: dict, key: str, amount: int = 1) -> None:
    counts = checkpoint.setdefault("coverage_counts", {})
    counts[key] = counts.get(key, 0) + amount


def _queue_folder(checkpoint: dict, match: dict, candidate: dict, *, drive_id=None) -> bool:
    identity = match["file_id"]
    digest = hashlib.sha256(identity.encode()).hexdigest()
    seen = checkpoint.setdefault("folder_digests", [])
    if digest in seen:
        return True
    if len(seen) >= MAX_REQUEST_FOLDERS:
        return False
    entry = {"id": identity}
    source_drive = candidate.get("driveId") or drive_id
    if source_drive:
        if not isinstance(source_drive, str) or not FILE_ID.fullmatch(source_drive):
            raise DriveReadError("provider_response_invalid")
        entry["driveId"] = source_drive
    key = candidate.get("resourceKey")
    if key:
        if not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key):
            raise DriveReadError("provider_response_invalid")
        entry["resourceKey"] = key
    queue = checkpoint.setdefault("folder_queue", [])
    queue.append(entry)
    seen.append(digest)
    if len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8")) > MAX_CHECKPOINT_BYTES:
        queue.pop()
        seen.pop()
        return False
    _counter(checkpoint, "matchingFoldersDiscovered")
    return True


def compile_queries(plan: dict, timezone: str) -> list[dict]:
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
    from hushh_mcp.services.google_drive_rest_transport import compile_search_terms, quote_literal

    try:
        parsed = LiveSearchPlan.model_validate(plan)
        if parsed.mode != "find":
            raise ValueError()
        terms = []
        if parsed.exact_title:
            if not parsed.exact_title.strip():
                raise ValueError()
            terms.append(f"name = {quote_literal(parsed.exact_title)}")
        elif parsed.terms:
            terms.append(compile_search_terms(parsed.terms))
        base = []
        if parsed.file_kind != "any":
            base.append(MIME_CLAUSES[parsed.file_kind])
        if parsed.shared_with_me:
            base.append("sharedWithMe = true")
        untimed = list(base)
        now = datetime.now(UTC)
        bounds = parsed.time_bounds(now_utc=now, timezone=timezone)
        if bounds:
            base.append(
                f"({parsed.file_time_field} >= {quote_literal(bounds[0])} and {parsed.file_time_field} < {quote_literal(bounds[1])})"
            )

        def compiled(clauses, **extra):
            query = " and ".join(clauses) or "trashed = false"
            if not 1 <= len(query) <= 1800:
                raise ValueError()
            return {
                "arguments": {"query": query, "orderBy": f"{parsed.file_time_field} desc"},
                **extra,
            }

        queries = [compiled([*terms, *base])]
        # Same title-date exception as the foreground reader: matching meeting
        # dates in a name can fall outside the file activity timezone/window.
        if bounds:
            for day in parsed.title_dates(now_utc=now, timezone=timezone):
                token = day.replace("-", "/")
                queries.append(
                    compiled([*terms, *untimed, compile_search_terms([token])], title_date=day)
                )
        return queries
    except (ValueError, TypeError, KeyError):
        raise DriveReadError("invalid_argument") from None


def compile_plan(plan: dict, timezone: str) -> dict:
    return compile_queries(plan, timezone)[0]["arguments"]


def compile_request_queries(
    plan: dict, purpose: dict, timezone: str, *, requested_at: datetime | None = None
) -> tuple[list[dict], dict | None]:
    """Broaden a requested file set before the owner reviews it.

    A Drive modified-time query would omit a meeting note with a matching
    title date or creation date. Search the subject without that cut, then
    apply the inclusive period against metadata in each worker page.
    """
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
    from hushh_mcp.services.google_drive_rest_transport import compile_search_terms, quote_literal

    parsed = LiveSearchPlan.model_validate(plan)
    if parsed.mode != "find":
        raise DriveReadError("invalid_argument")
    now = requested_at if requested_at is not None else datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise DriveReadError("invalid_argument")
    now = now.astimezone(UTC)
    start = purpose.get("periodStart")
    end = purpose.get("periodEnd")
    # Old queued requests can predate the create-time check. Never let a
    # relative day/week request fall through to an unbounded search.
    if request_requires_explicit_dates(purpose.get("purpose", "")) and (not start or not end):
        raise DriveReadError("date_range_required")
    if start is None and end is None:
        request_text = purpose.get("purpose", "")
        month = _MONTH_WINDOW.search(request_text)
        if _YESTERDAY.search(request_text):
            requested_day = now.astimezone(ZoneInfo(timezone)).date() - timedelta(days=1)
            start = end = requested_day.isoformat()
        elif month:
            months = _MONTH_WORDS.get(month["count"].lower()) or int(month["count"])
            if not 1 <= months <= 12:
                raise DriveReadError("invalid_argument")
            today = now.astimezone(ZoneInfo(timezone)).date()
            month_index = today.year * 12 + today.month - 1 - months
            year, month_number = divmod(month_index, 12)
            month_number += 1
            start = date(
                year, month_number, min(today.day, monthrange(year, month_number)[1])
            ).isoformat()
            end = today.isoformat()
        elif parsed.time_intent == "file_activity":
            bounds = parsed.time_bounds(now_utc=now, timezone=timezone)
            if bounds:
                start = (
                    datetime.fromisoformat(bounds[0].replace("Z", "+00:00"))
                    .astimezone(ZoneInfo(timezone))
                    .date()
                    .isoformat()
                )
                end = (
                    (
                        datetime.fromisoformat(bounds[1].replace("Z", "+00:00"))
                        - timedelta(microseconds=1)
                    )
                    .astimezone(ZoneInfo(timezone))
                    .date()
                    .isoformat()
                )
    period = {"start": start, "end": end, "timezone": timezone} if start and end else None
    base = []
    kind_clause = _request_discovery_clause(parsed.file_kind)
    if kind_clause:
        base.append(kind_clause)
    if parsed.shared_with_me:
        base.append("sharedWithMe = true")
    if parsed.exact_title:
        subject = f"name = {quote_literal(parsed.exact_title)}"
    elif parsed.terms:
        # Keep full-text evidence from Drive while requiring every distinct
        # subject term the planner selected. Standup spellings are one term.
        groups = [
            "("
            + " or ".join(
                compile_search_terms([variant])
                for variant in (
                    ("standup", "stand up", "stand-up")
                    if term.casefold() in {"standup", "stand-up", "stand up"}
                    else (term,)
                )
            )
            + ")"
            for term in parsed.terms
        ]
        # Separate categories such as "contracts and invoices" are a union:
        # no single file needs both words. Otherwise, preserve the planner's
        # all-terms-match contract for one described subject.
        joiner = (
            " or "
            if _coordinated_alternatives(parsed.terms, purpose.get("purpose", ""))
            else " and "
        )
        subject = "(" + joiner.join(groups) + ")"
    else:
        subject = None
    clauses = [*([subject] if subject else []), *base]
    if not clauses:
        # A broad date-only request still has a Drive boundary. The period is
        # filtered after every provider page, not by one mutable timestamp.
        if period is None:
            raise DriveReadError("narrow_selection_required")
        clauses = ["trashed = false"]
    query = " and ".join(clauses)
    if len(query) > 1800:
        raise DriveReadError("invalid_argument")
    return [{"arguments": {"query": query, "orderBy": "createdTime desc"}}], period


def _in_requested_period(match: dict, period: dict | None) -> bool:
    if period is None:
        return True
    start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
    zone = ZoneInfo(period["timezone"])
    title_days = []
    for match_date in _TITLE_DATE.finditer(match["name"]):
        try:
            year, month, day = (int(part) for part in match_date.groups())
            title_day = date(year, month, day)
            title_time = _TITLE_TIME.match(match["name"], match_date.end())
            if title_time:
                title_zone = title_time["zone"].upper()
                if title_zone == "IST":
                    source_zone = ZoneInfo("Asia/Kolkata")
                elif title_zone in {"UTC", "GMT"}:
                    source_zone = UTC
                else:
                    offset = title_zone[3:]
                    sign = 1 if offset[0] == "+" else -1
                    clock = offset[1:]
                    if ":" in clock:
                        hour_text, minute_text = clock.split(":", 1)
                    else:
                        hour_text, minute_text = (
                            (clock[:-2], clock[-2:]) if len(clock) > 2 else (clock, "0")
                        )
                    hours, minutes = int(hour_text), int(minute_text)
                    if hours > 23 or minutes > 59:
                        continue
                    source_zone = timezone(sign * timedelta(hours=hours, minutes=minutes))
                title_day = (
                    datetime(
                        year,
                        month,
                        day,
                        int(title_time["hour"]),
                        int(title_time["minute"]),
                        tzinfo=source_zone,
                    )
                    .astimezone(zone)
                    .date()
                )
            title_days.append(title_day)
        except ValueError:
            continue
    if title_days:
        return any(start <= day <= end for day in title_days)
    for key in ("created_time", "modified_time"):
        value = match.get(key)
        if isinstance(value, str):
            try:
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None or timestamp.utcoffset() is None:
                    continue
                day = timestamp.astimezone(zone).date()
            except ValueError:
                continue
            if start <= day <= end:
                return True
    return False


def _matches_requested_kind(kind: str, mime: str) -> bool:
    if kind == "any":
        return True
    if kind == "document":
        return mime in DOCUMENT_MIMES
    if kind == "spreadsheet":
        return (
            mime == "application/vnd.google-apps.spreadsheet"
            or "spreadsheetml" in mime
            or mime == "text/csv"
        )
    if kind == "presentation":
        return mime == "application/vnd.google-apps.presentation" or "presentationml" in mime
    if kind == "pdf":
        return mime == "application/pdf"
    return mime.startswith(kind + "/")


def _token(payload, current, checkpoint):
    token = payload.get("nextPageToken")
    if token is not None and (not isinstance(token, str) or len(token) > 1024):
        raise DriveReadError("provider_response_invalid")
    if token:
        digest = hashlib.sha256(token.encode()).hexdigest()
        seen = checkpoint.setdefault("seen_tokens", [])
        if token == current or digest in seen or len(seen) >= 1000:
            raise DriveReadError("provider_response_invalid")
        seen.append(digest)
    return token or None


def _phase(checkpoint, name):
    checkpoint["phase"] = name
    checkpoint["page_token"] = None
    checkpoint["seen_tokens"] = []


def _advance_query(checkpoint):
    queries = checkpoint.get("queries", [])
    index = checkpoint.get("query_index", 0) + 1
    if index >= len(queries):
        if checkpoint.get("request_origin_id") and checkpoint.get("folder_queue"):
            _phase(checkpoint, "folder_files")
            return False
        return True
    query = queries[index]
    checkpoint.update(
        query_index=index,
        arguments=query["arguments"],
        title_date=query.get("title_date"),
        drive_page_token=None,
        drives=[],
        drive_index=0,
        drive_tokens=[],
    )
    _phase(checkpoint, "user")
    return False


class DriveOwnerSearchService:
    def __init__(self, store=None, transport=None, sharing=None):
        self.store = store or DriveOwnerSearchStore()
        self.transport = transport or GoogleDriveRestTransport()
        self.sharing = sharing

    @staticmethod
    def _request(query, timezone):
        if (
            not isinstance(query, str)
            or not query.strip()
            or len(query) > 2048
            or len(query.encode("utf-8")) > 2048
            or not isinstance(timezone, str)
            or not 1 <= len(timezone) <= 64
        ):
            raise DriveReadError("invalid_argument")
        return {"query": query, "timezone": timezone}

    async def existing(self, *, user_id, client_request_id, query, require_current, timezone="UTC"):
        await require_current()
        result = await self.store.existing(
            user_id=user_id,
            client_request_id=client_request_id,
            request=self._request(query, timezone),
        )
        await require_current()
        return result

    async def create(
        self,
        *,
        user_id,
        client_request_id,
        query,
        plan,
        background_consent,
        require_current,
        timezone="UTC",
    ):
        await require_current()
        if background_consent is not True:
            raise DriveReadError("confirmation_required")
        request = self._request(query, timezone)
        existing = await self.existing(
            user_id=user_id,
            client_request_id=client_request_id,
            query=query,
            timezone=timezone,
            require_current=require_current,
        )
        if existing is not None:
            return existing
        queries = compile_queries(plan, timezone)
        state, created = await self.store.create(
            user_id=user_id,
            client_request_id=client_request_id,
            request=request,
            confirmed=True,
            checkpoint={
                "request": request,
                "arguments": queries[0]["arguments"],
                "queries": queries,
                "query_index": 0,
                "phase": "user",
                "page_token": None,
                "drive_page_token": None,
                "drives": [],
                "drive_index": 0,
                "seen_tokens": [],
                "drive_tokens": [],
            },
        )
        if created:
            await self.run_one(
                user_id=user_id,
                job_id=state["jobId"],
                max_pages=1,
                deadline_seconds=15,
                initial_page_size=PAGE_SIZE,
                require_current=require_current,
            )
        await wake_drive_work("suggestions")
        return await self.status(
            user_id=user_id, job_id=state["jobId"], require_current=require_current
        )

    async def create_for_request(
        self,
        *,
        user_id,
        request_id,
        request_revision,
        purpose,
        plan,
        require_current,
        timezone="UTC",
        authority_mode="owner",
        requested_at: datetime | None = None,
        after_page=None,
    ):
        """Start or resume the owner-approved request's durable metadata search."""
        if authority_mode not in {"owner", "trusted_auto"}:
            raise DriveReadError("invalid_argument")
        if not (purpose.get("periodStart") and purpose.get("periodEnd")):
            raise DriveReadError("date_range_required")
        await require_current()
        query = purpose["purpose"]
        request = self._request(query, timezone)
        await self.store.clear_legacy_completed_request(user_id=user_id, request_id=request_id)
        existing = await self.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None:
            if existing["status"] not in {"failed", "limited", "stopped"}:
                return existing
            await self.store.clear_terminal_request(user_id=user_id, request_id=request_id)
        queries, period = compile_request_queries(
            plan, purpose, timezone, requested_at=requested_at
        )
        state, created = await self.store.create(
            user_id=user_id,
            client_request_id=request_id,
            request=request,
            confirmed=True,
            checkpoint={
                "request": request,
                "arguments": queries[0]["arguments"],
                "queries": queries,
                "query_index": 0,
                "request_origin_id": request_id,
                "request_revision": request_revision,
                "authority_mode": authority_mode,
                "request_shareability_version": 1,
                "request_file_kind": plan.get("file_kind", "any"),
                "request_subject_terms": plan.get("terms", []),
                "request_exact_title": plan.get("exact_title"),
                "request_notes": bool(re.search(r"\b(?:notes?|minutes)\b", query, re.I)),
                "request_explicit_dates": bool(
                    purpose.get("periodStart") and purpose.get("periodEnd")
                ),
                "requested_period": period,
                "coverage_manifest": {
                    "corpora": ["user", "member_shared_drives"],
                    "fileKind": plan.get("file_kind", "any"),
                    "requestedPeriod": period,
                    "dateBasis": "title_date_then_created_or_modified",
                    "contentPeriodVerified": False,
                    "folderDiscovery": "matching_topic_folders_and_descendants",
                },
                "coverage_counts": {},
                "folder_queue": [],
                "folder_digests": [],
                "phase": "user",
                "page_token": None,
                "drive_page_token": None,
                "drives": [],
                "drive_index": 0,
                "seen_tokens": [],
                "drive_tokens": [],
            },
        )
        await self.store.align_request_expiry(user_id=user_id, request_id=request_id)
        if created:
            await self.run_one(
                user_id=user_id,
                job_id=state["jobId"],
                max_pages=1,
                deadline_seconds=15,
                initial_page_size=PAGE_SIZE,
                require_current=require_current,
                **({"after_page": after_page} if after_page is not None else {}),
            )
        await wake_drive_work("suggestions")
        return await self.status(
            user_id=user_id, job_id=state["jobId"], require_current=require_current
        )

    async def list(self, *, user_id, require_current):
        await require_current()
        result = await self.store.list(user_id=user_id)
        await require_current()
        return result

    async def status(self, *, user_id, job_id, require_current):
        await require_current()
        result = await self.store.status(user_id=user_id, job_id=job_id)
        await require_current()
        return result

    async def results(self, *, user_id, job_id, require_current, cursor=None, limit=25):
        await require_current()
        result = await self.store.results(
            user_id=user_id, job_id=job_id, cursor=cursor, limit=limit
        )
        await require_current()
        return result

    @drive_operation(job_key="job_id")
    async def resolve_selection(self, *, user_id, job_id, position, require_current):
        """Use a saved ID as a lead, then verify that exact file in live Drive.

        A background result does not prove current existence or authorize a
        content read or share. Rechecking the saved row after provider I/O also
        fences a disconnect, account switch, expiry, or account erasure.
        """
        started = time.perf_counter()
        status = "failed"
        try:
            await require_current()
            saved = await self.store.reference(user_id=user_id, job_id=job_id, position=position)
            file_id = saved.get("id") if isinstance(saved, dict) else None
            if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                raise DriveReadError("provider_response_invalid")
            result = await self.transport.read_tool(
                user_id=user_id,
                tool_name="get_file_metadata",
                arguments={"fileId": file_id},
            )
            if result.is_error or result.truncated or not isinstance(result.payload, dict):
                raise DriveReadError("provider_response_invalid")
            current = result.payload.get("file")
            if (
                not isinstance(current, dict)
                or current.get("id") != file_id
                or not isinstance(current.get("title"), str)
                or not current["title"]
                or current["title"] != saved.get("name")
            ):
                raise DriveReadError("source_changed")
            await require_current()
            again = await self.store.reference(user_id=user_id, job_id=job_id, position=position)
            if again != saved:
                raise DriveReadError("source_changed")
            await require_current()
            status = "verified"
            return {
                "id": file_id,
                "name": current["title"],
                "mimeType": current.get("mimeType")
                if isinstance(current.get("mimeType"), str)
                else "",
                "modifiedTime": current.get("modifiedTime"),
                "openUrl": _open_url(file_id, current.get("viewUrl")),
            }
        finally:
            logger.info(
                "drive_search.selection status=%s elapsed_ms=%.2f",
                status,
                (time.perf_counter() - started) * 1000,
            )

    @drive_operation(job_key="job_id")
    async def read_selection_content(
        self, *, user_id, job_id, position, file, require_current
    ) -> dict:
        """Optional exact-ID read after a live selection check, with a fresh fence.

        A failed export keeps the verified metadata usable. A revoked owner or
        changed Drive generation never does. No content enters a search job.
        """
        started = time.perf_counter()
        outcome = "unavailable"
        try:
            await require_current()
            saved = await self.store.reference(user_id=user_id, job_id=job_id, position=position)
            if saved.get("id") != file.get("id") or saved.get("name") != file.get("name"):
                raise DriveReadError("source_changed")
            try:
                result = await asyncio.wait_for(
                    self.transport.read_tool(
                        user_id=user_id,
                        tool_name="read_file_content",
                        arguments={"fileId": file["id"]},
                    ),
                    timeout=18,
                )
            except Exception:  # noqa: BLE001 - optional read errors never erase verified metadata
                result = None
            # Even when the optional read failed, revoked access must not leak
            # a previously verified filename or link into the answer.
            await require_current()
            again = await self.store.reference(user_id=user_id, job_id=job_id, position=position)
            if again != saved:
                raise DriveReadError("source_changed")
            if result is None or result.is_error or not isinstance(result.payload, dict):
                return {"status": "unavailable"}
            payload = result.payload
            body = payload.get("fileContent")
            if not isinstance(body, str) or not body.strip():
                return {"status": "unsupported"}
            outcome = "ok"
            return {
                "status": "ok",
                "text": body[:12000],
                "truncated": bool(
                    result.truncated or payload.get("contentTruncated") or len(body) > 12000
                ),
            }
        finally:
            logger.info(
                "drive_search.selection_content status=%s elapsed_ms=%.2f",
                outcome,
                (time.perf_counter() - started) * 1000,
            )

    async def stop(self, *, user_id, job_id, require_current):
        await require_current()
        result = await self.store.stop(user_id=user_id, job_id=job_id)
        await require_current()
        return result

    async def _request_candidates(self, job, checkpoint, candidates, *, folder_scoped, drive_id):
        targets = {}
        for candidate in candidates:
            if not isinstance(candidate, dict) or candidate.get("mimeType") != SHORTCUT_MIME:
                continue
            details = candidate.get("shortcutDetails")
            target = details.get("targetId") if isinstance(details, dict) else None
            key = details.get("targetResourceKey") if isinstance(details, dict) else None
            if isinstance(target, str) and FILE_ID.fullmatch(target):
                if key is not None and (
                    not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key)
                ):
                    raise DriveReadError("provider_response_invalid")
                # Prefer the available target key when duplicate aliases point
                # to one original. It remains encrypted with the result.
                targets[target] = key or targets.get(target)
        semaphore = asyncio.Semaphore(6)

        async def target_metadata(target, key):
            async with semaphore:
                try:
                    result = await self.transport.read_tool(
                        user_id=job["user_id"],
                        tool_name="get_file_metadata",
                        arguments={"fileId": target, **({"resourceKey": key} if key else {})},
                    )
                except DriveReadError as error:
                    if str(error) != "source_unavailable":
                        raise
                    return target, None
                if result.is_error or result.truncated or not isinstance(result.payload, dict):
                    raise DriveReadError("provider_response_invalid")
                current = result.payload.get("file")
                match = DriveLiveReader._match(current)
                if match is None or match["file_id"] != target:
                    raise DriveReadError("provider_response_invalid")
                return target, current

        target_files = dict(
            await asyncio.gather(*(target_metadata(target, key) for target, key in targets.items()))
        )
        files = []
        incomplete = False
        kind = checkpoint.get("request_file_kind", "any")
        period = checkpoint.get("requested_period")

        def period_matches(match):
            if checkpoint.get("authority_mode") == "trusted_auto":
                return _in_requested_period(match, period)
            return _in_requested_period(match, period) or (
                match.get("shortcut_name")
                and _in_requested_period({**match, "name": match["shortcut_name"]}, period)
            )

        for candidate in candidates:
            match = DriveLiveReader._match(candidate)
            if match is None:
                incomplete = True
                _counter(checkpoint, "invalidMetadataCount")
                continue
            source = candidate
            source_drive = drive_id
            key = candidate.get("resourceKey")
            if key is not None and (not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key)):
                raise DriveReadError("provider_response_invalid")
            if match["mime_type"] == SHORTCUT_MIME:
                alias = match["name"]
                details = candidate.get("shortcutDetails") or {}
                if not isinstance(details, dict):
                    raise DriveReadError("provider_response_invalid")
                target = details.get("targetId")
                source = target_files.get(target)
                if source is None:
                    _counter(checkpoint, "unavailableShortcutCount")
                    if details.get("targetMimeType") == FOLDER_MIME:
                        # An unavailable folder can hide matching descendants;
                        # it cannot establish an exhausted result set.
                        incomplete = True
                        _counter(checkpoint, "unavailableFolderCount")
                        continue
                    target_kind = details.get("targetMimeType")
                    if target_kind and not _matches_requested_kind(kind, target_kind):
                        _counter(checkpoint, "excludedByKindCount")
                        continue
                    if not _note_candidate(checkpoint, match, folder_scoped=folder_scoped):
                        _counter(checkpoint, "excludedByNoteTypeCount")
                        continue
                    if not period_matches(match):
                        _counter(checkpoint, "excludedByDateCount")
                        continue
                    files.append(
                        {
                            "id": match["file_id"],
                            "name": alias,
                            "mimeType": SHORTCUT_MIME,
                            "modifiedTime": match["modified_time"],
                            "createdTime": match["created_time"],
                            "openUrl": match["open_url"],
                            "shareable": False,
                            "unavailableReason": "shortcut_target_unavailable",
                        }
                    )
                    continue
                match = DriveLiveReader._match(source)
                match["shortcut_name"] = alias
                key = source.get("resourceKey") or targets.get(target)
                if key is not None and (
                    not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key)
                ):
                    raise DriveReadError("provider_response_invalid")
                # A shortcut's targetMimeType is a snapshot, not live facts.
                # Use the target's verified MIME and timestamps instead.
                source_drive = None
                _counter(checkpoint, "resolvedShortcutCount")
            if match["mime_type"] == FOLDER_MIME:
                if (
                    folder_scoped
                    or _subject_matches(checkpoint, match["name"])
                    or (
                        match.get("shortcut_name")
                        and _subject_matches(checkpoint, match["shortcut_name"])
                    )
                ):
                    if not _queue_folder(
                        checkpoint,
                        match,
                        {**source, **({"resourceKey": key} if key else {})},
                        drive_id=source_drive,
                    ):
                        incomplete = True
                        checkpoint.setdefault("coverage_counts", {})["workLimitReached"] = True
                else:
                    _counter(checkpoint, "excludedFolderTopicCount")
                continue
            if not _matches_requested_kind(kind, match["mime_type"]):
                _counter(checkpoint, "excludedByKindCount")
                continue
            if not _note_candidate(checkpoint, match, folder_scoped=folder_scoped):
                _counter(checkpoint, "excludedByNoteTypeCount")
                continue
            if (
                folder_scoped
                and not checkpoint.get("request_notes")
                and not _subject_matches(checkpoint, match["name"])
                and not _subject_matches(checkpoint, match.get("shortcut_name", ""))
            ):
                # A topical parent is discovery evidence, not evidence that
                # every descendant is a requested file. Direct fullText
                # results remain available even when the title is generic.
                _counter(checkpoint, "excludedByTopicCount")
                continue
            if not period_matches(match):
                _counter(checkpoint, "excludedByDateCount")
                continue
            files.append(
                {
                    "id": match["file_id"],
                    "name": match["name"],
                    "mimeType": match["mime_type"],
                    "modifiedTime": match["modified_time"],
                    "createdTime": match["created_time"],
                    **(
                        {"shortcutName": match["shortcut_name"]}
                        if match.get("shortcut_name")
                        else {}
                    ),
                    **({"resourceKey": key} if key else {}),
                    "openUrl": match["open_url"],
                    **_shareability(source),
                }
            )
        return files, incomplete

    async def _page(self, job, *, page_size_override=None):
        checkpoint = copy.deepcopy(job["checkpoint"])
        if (
            checkpoint.get("request_origin_id")
            and checkpoint.get("request_explicit_dates") is not True
        ):
            if self.sharing is None:
                from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                self.sharing = DriveSharingStore(db=self.store.db)
            context = await self.sharing.request_bulk_context(
                user_id=job["user_id"], request_id=checkpoint["request_origin_id"]
            )
            purpose = context["purpose"]
            if not (purpose.get("periodStart") and purpose.get("periodEnd")):
                raise DriveReadError("date_range_required")
            period = checkpoint.get("requested_period")
            if not isinstance(period, dict) or (
                period.get("start") != purpose["periodStart"]
                or period.get("end") != purpose["periodEnd"]
            ):
                raise DriveReadError("request_changed")
            # Persist the proof with the next page so legacy dated jobs can
            # continue without repeating this encrypted request read.
            checkpoint["request_explicit_dates"] = True
        listing_read = getattr(self.transport, "read_owner_search_page", None)
        if listing_read is None:
            # Older injected transports implement the same listing call shape
            # through the original read_tool seam.
            listing_read = self.transport.read_tool
        phase = checkpoint["phase"]
        if phase == "drives":
            args = {"pageSize": PAGE_SIZE}
            if checkpoint["drive_page_token"]:
                args["pageToken"] = checkpoint["drive_page_token"]
            result = await listing_read(
                user_id=job["user_id"], tool_name="list_shared_drives", arguments=args
            )
            payload = result.payload
            if result.is_error or result.truncated or not isinstance(payload, dict):
                raise DriveReadError("provider_response_invalid")
            drives = payload.get("drives")
            if (
                not isinstance(drives, list)
                or len(drives) > PAGE_SIZE
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("id"), str)
                    or not FILE_ID.fullmatch(item["id"])
                    for item in drives
                )
            ):
                raise DriveReadError("provider_response_invalid")
            # Drive-list tokens have their own cycle guard across each file scan.
            token_state = {"seen_tokens": checkpoint["drive_tokens"]}
            next_token = _token(payload, checkpoint["drive_page_token"], token_state)
            checkpoint["drive_page_token"] = next_token
            checkpoint["drives"] = list(dict.fromkeys(item["id"] for item in drives))
            checkpoint["drive_index"] = 0
            if drives:
                _phase(checkpoint, "files")
            done = _advance_query(checkpoint) if not drives and not next_token else False
            return checkpoint, [], False, done
        file_page_size = (
            PAGE_SIZE
            if checkpoint.get("file_page_size") == PAGE_SIZE or page_size_override == PAGE_SIZE
            else FILE_LIST_PAGE_SIZE
        )
        args = {**checkpoint["arguments"], "pageSize": file_page_size}
        if phase == "folder_files":
            folder = checkpoint["folder_queue"][0]
            clause = _request_discovery_clause(checkpoint.get("request_file_kind", "any"))
            args = {
                "folderId": folder["id"],
                "query": clause or "trashed = false",
                "orderBy": "createdTime desc",
                "pageSize": file_page_size,
                **({"driveId": folder["driveId"]} if folder.get("driveId") else {}),
                **({"resourceKey": folder["resourceKey"]} if folder.get("resourceKey") else {}),
            }
        if checkpoint["page_token"]:
            args["pageToken"] = checkpoint["page_token"]
        if phase == "files":
            args["driveId"] = checkpoint["drives"][checkpoint["drive_index"]]
        try:
            result = await listing_read(
                user_id=job["user_id"], tool_name="search_files", arguments=args
            )
        except DriveReadError as error:
            if str(error) != "file_too_large" or file_page_size == PAGE_SIZE:
                raise
            # A 100-row response can exceed the unchanged 256 KiB metadata
            # ceiling when titles or URLs are long. Retry the same token with
            # 25 rows and persist that size with the next successful page.
            file_page_size = PAGE_SIZE
            checkpoint["file_page_size"] = PAGE_SIZE
            args["pageSize"] = PAGE_SIZE
            result = await listing_read(
                user_id=job["user_id"], tool_name="search_files", arguments=args
            )
        payload = result.payload
        if not isinstance(payload, dict):
            raise DriveReadError("provider_response_invalid")
        candidates = payload.get("files")
        incomplete = payload.get("incompleteSearch", False)
        if (
            result.is_error
            or result.truncated
            or payload.get("overLimit") is True
            or type(incomplete) is not bool
            or not isinstance(candidates, list)
            or len(candidates) > file_page_size
        ):
            raise DriveReadError("provider_response_invalid")
        if (
            file_page_size > PAGE_SIZE
            and sum(
                item.get("mimeType") == SHORTCUT_MIME
                for item in candidates
                if isinstance(item, dict)
            )
            > 8
        ):
            # Avoid making a 90-second slice resolve an unbounded fanout of
            # shortcut targets (six concurrent metadata reads at a time).
            # No rows or cursor from the large page have been committed.
            large_page_incomplete = incomplete
            checkpoint["file_page_size"] = PAGE_SIZE
            args["pageSize"] = PAGE_SIZE
            result = await listing_read(
                user_id=job["user_id"], tool_name="search_files", arguments=args
            )
            payload = result.payload
            candidates = payload.get("files") if isinstance(payload, dict) else None
            incomplete = (
                payload.get("incompleteSearch", False) if isinstance(payload, dict) else None
            )
            if (
                result.is_error
                or result.truncated
                or not isinstance(payload, dict)
                or payload.get("overLimit") is True
                or type(incomplete) is not bool
                or not isinstance(candidates, list)
                or len(candidates) > PAGE_SIZE
            ):
                raise DriveReadError("provider_response_invalid")
            incomplete = incomplete or large_page_incomplete
        if checkpoint.get("request_origin_id"):
            _counter(checkpoint, "providerRowsScanned", len(candidates))
            _counter(checkpoint, "providerFilePages")
            files, candidate_incomplete = await self._request_candidates(
                job,
                checkpoint,
                candidates,
                folder_scoped=phase == "folder_files",
                drive_id=args.get("driveId"),
            )
            incomplete = incomplete or candidate_incomplete
        else:
            files = []
            for candidate in candidates:
                match = DriveLiveReader._match(candidate)
                if match is None:
                    incomplete = True
                    continue
                day = checkpoint.get("title_date")
                if day and day not in match["name"] and day.replace("-", "/") not in match["name"]:
                    continue
                files.append(
                    {
                        "id": match["file_id"],
                        "name": match["name"],
                        "mimeType": match["mime_type"],
                        "modifiedTime": match["modified_time"],
                        "createdTime": match.get("created_time"),
                        "openUrl": match["open_url"],
                    }
                )
        next_token = _token(payload, checkpoint["page_token"], checkpoint)
        checkpoint["page_token"] = next_token
        done = False
        if not next_token:
            if phase == "user":
                _phase(checkpoint, "drives")
            elif phase == "folder_files":
                checkpoint["folder_queue"].pop(0)
                _counter(checkpoint, "matchingFoldersExhausted")
                if checkpoint["folder_queue"]:
                    _phase(checkpoint, "folder_files")
                else:
                    done = True
            elif checkpoint["drive_index"] + 1 < len(checkpoint["drives"]):
                checkpoint["drive_index"] += 1
                _phase(checkpoint, "files")
            elif checkpoint["drive_page_token"]:
                _phase(checkpoint, "drives")
            else:
                done = _advance_query(checkpoint)
        if checkpoint.get("request_origin_id") and (
            checkpoint["coverage_counts"].get("providerFilePages", 0) >= MAX_REQUEST_FILE_PAGES
            and not done
            or len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8"))
            > MAX_CHECKPOINT_BYTES
        ):
            checkpoint["coverage_counts"]["workLimitReached"] = True
            incomplete, done = True, True
        return checkpoint, files, incomplete, done

    @drive_operation(job_key="job_id")
    async def run_one(
        self,
        *,
        user_id,
        job_id,
        max_pages=MAX_SLICE_PAGES,
        deadline_seconds=SLICE_SECONDS,
        initial_page_size=None,
        require_current=None,
        after_page=None,
    ):
        if (
            type(max_pages) is not int
            or not 1 <= max_pages <= MAX_SLICE_PAGES
            or not 1 <= deadline_seconds <= SLICE_SECONDS
            or initial_page_size is not None
            and (type(initial_page_size) is not int or initial_page_size != PAGE_SIZE)
        ):
            raise ValueError("invalid search slice bounds")
        job = await self.store.claim(user_id=user_id, job_id=job_id)
        if job is None:
            return "not_claimed"
        started = time.monotonic()
        pages = 0
        found = 0
        outcome = "failed"
        handing_off = False

        def finish(status):
            nonlocal outcome
            outcome = (
                status
                if status
                in {"queued", "running", "completed", "stopped", "failed", "limited", "superseded"}
                else "failed"
            )
            return status

        try:
            async with asyncio.timeout(deadline_seconds):
                for _ in range(max_pages):
                    if require_current:
                        await require_current()
                    await self.store.require_current(job)
                    page_started = time.monotonic()
                    phase = job["checkpoint"].get("phase")
                    phase = (
                        phase if phase in {"user", "drives", "files", "folder_files"} else "unknown"
                    )
                    page_outcome = "failed"
                    page_count = 0
                    try:
                        checkpoint, files, incomplete, done = await self._page(
                            job,
                            **(
                                {"page_size_override": initial_page_size}
                                if pages == 0 and initial_page_size is not None
                                else {}
                            ),
                        )
                        page_outcome = "received"
                        page_count = len(files)
                    finally:
                        logger.info(
                            "drive_search.page phase=%s status=%s files=%d elapsed_ms=%.2f",
                            phase,
                            page_outcome,
                            page_count,
                            (time.monotonic() - page_started) * 1000,
                        )
                    if require_current:
                        await require_current()
                    result = await self.store.commit_page(
                        job, checkpoint=checkpoint, files=files, incomplete=incomplete, done=done
                    )
                    job["checkpoint"] = checkpoint
                    pages += 1
                    found = result["matched"]
                    if after_page is not None and result["status"] in {"running", "completed"}:
                        # commit_page has returned: no DB lock spans this
                        # orchestration. Freeze/queue the committed matches
                        # before another provider read can consume the slice.
                        # Even an empty final page must flush/resume a batch.
                        try:
                            handing_off = True
                            await after_page(user_id=user_id, job_id=job_id)
                            handing_off = False
                        except Exception:  # noqa: BLE001 - durable pages remain resumable
                            logger.warning("drive_search.page_handoff status=deferred")
                            state = (
                                result["status"]
                                if result["status"] != "running"
                                else await self.store.release(job)
                            )
                            await wake_drive_work("suggestions")
                            return finish(state)
                    if result["status"] != "running":
                        return finish(result["status"])
            return finish(await self.store.release(job))
        except TimeoutError:
            if handing_off:
                # An orchestration deadline is not a failed provider page.
                # The checkpoint is durable; resume that same frozen batch.
                state = await self.store.release(job)
                await wake_drive_work("suggestions")
                return finish(state)
            return finish(
                await self.store.release(job, error="provider_unavailable", retryable=True)
            )
        except DriveReadError as error:
            if str(error) == "background_preparation_required":
                # The owner can re-enable background Drive access without
                # losing an already committed search checkpoint or batches.
                if require_current:
                    try:
                        await require_current()
                    except DriveReadError:
                        pass
                return finish(await self.store.pause_for_background(job))
            if str(error) == "search_superseded":
                await self.store.release(job, error="connection_changed")
                return finish("superseded")
            return finish(
                await self.store.release(
                    job,
                    error=str(error),
                    retryable=str(error) == "provider_unavailable" and error.retryable,
                )
            )
        except DriveOAuthError as error:
            code = (
                "provider_unavailable"
                if str(error) in {"provider_unavailable", "refresh_in_progress"}
                else "connection_changed"
            )
            return finish(
                await self.store.release(job, error=code, retryable=code == "provider_unavailable")
            )
        except PermissionError:
            await self.store.release(job, error="connection_changed")
            raise
        except asyncio.CancelledError:
            # Graceful shutdown releases; a process crash is recovered by lease expiry.
            await asyncio.shield(self.store.release(job))
            raise
        except Exception:
            await self.store.release(job, error="provider_unavailable", retryable=True)
            raise
        finally:
            logger.info(
                "drive_search.slice status=%s pages=%d matched=%d elapsed_ms=%.2f",
                outcome,
                pages,
                found,
                (time.monotonic() - started) * 1000,
            )
