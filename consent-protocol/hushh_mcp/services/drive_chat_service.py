"""Nonpersisting owner-authorized Drive read; the interpreter has no executable tools."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from datetime import timezone as datetime_timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
from hushh_mcp.services.drive_candidate_selection import (
    interpret_candidate_selection,
    select_matches,
)
from hushh_mcp.services.drive_content_compilation import discover_long_range_matches
from hushh_mcp.services.drive_document_retrieval import DriveDocumentReader
from hushh_mcp.services.drive_live_reader import MAX_READS, DriveLiveReader
from hushh_mcp.services.drive_long_range_listing import (
    owner_compile_query,
    parse_long_range_listing,
)
from hushh_mcp.services.drive_suggestion_service import (
    LiveSearchPlan,
    interpret_live_search,
    plan_live_search,
    simple_file_activity_plan,
)
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = logging.getLogger("drive_chat_service")
MAX_OWNER_LIST_DISPLAY = 60


class DocumentAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, max_length=5000)
    source_refs: list[str] = Field(default_factory=list, max_length=8)
    # The honest negative: none of the supplied documents answers the request.
    none_relevant: bool = False

    @model_validator(mode="after")
    def _negative_cites_nothing(self):
        if self.none_relevant and self.source_refs:
            raise ValueError("a none_relevant answer cites no documents")
        return self


async def interpret(*, prompt, user_id, consent_token):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_interpreter")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid document interpreter")
    agent = build_single_turn_agent(
        gene,
        output_schema=DocumentAnswer,
    )
    result = await run_single_turn(
        agent, prompt_parts=prompt, user_id=user_id, consent_token=consent_token, timeout_seconds=45
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def result(
    conversation_id,
    answer,
    status,
    *,
    sources=(),
    truncated=False,
    metadata_only=False,
    owner_compile_available=False,
    owner_compile_query=None,
    owner_compile_window=None,
):
    return {
        "conversationId": conversation_id,
        "response": answer,
        "isComplete": True,
        "structured": {
            "schema_version": "specialist_read.v1",
            "connector": "drive",
            "status": status,
            "sources": list(sources),
            "truncated": truncated,
            "metadata_only": metadata_only,
            "owner_compile_available": owner_compile_available,
            "owner_compile_query": owner_compile_query,
            "owner_compile_window": owner_compile_window,
        },
    }


# Owner-only wording for the reader's allowlisted reasons.
_NOT_READ_LABELS = {
    "encrypted_document": "password-protected",
    "file_too_large": "too large to read",
    "unsupported_format": "this file type can't be read yet",
    "no_extractable_text": "no text I can read, like a scanned page",
    "source_unavailable": "not available to read",
    "invalid_document": "the file looks damaged or isn't saved as plain text",
}


def _safe_title(name: object) -> str:
    """A filename as inert Markdown text: whitespace collapsed, cut, escaped."""
    title = re.sub(r"\s+", " ", str(name or "")).strip()[:180] or "A file"
    return re.sub(r"([\\`*_{}\[\]()#+.!>|~-])", r"\\\1", title)


def _not_read_note(items: list[dict]) -> str:
    """Owner-only: which found files could not be read, and why."""
    count = len(items)
    lines = [f"I couldn't read {count} file{'' if count == 1 else 's'}:"]
    for item in items[:10]:
        label = _NOT_READ_LABELS.get(
            str(item.get("reason")), _NOT_READ_LABELS["source_unavailable"]
        )
        lines.append(f"- {_safe_title(item.get('name'))} ({label})")
    return "\n".join(lines)


def _found_files(
    matches: list[dict],
    *,
    truncated: bool,
    unreadable: bool = False,
    time_window: str = "",
    date_field: str = "modified_time",
    timezone: str = "UTC",
    reasons: dict | None = None,
    limit: int = 10,
    intro: str | None = None,
) -> str:
    """Render safe owner-only opening actions from validated provider IDs.

    ``reasons`` maps a match's source_ref to why it could not be read.
    """
    lines = [
        intro
        or (
            "I found these Drive files. I couldn't read their contents here, but you can open them:"
            if unreadable
            else "I found these Drive files:"
        )
    ]
    if time_window:
        lines.append(time_window)
    for index, match in enumerate(matches[:limit], 1):
        title = _safe_title(match["name"])
        modified = match.get(date_field) or match.get("modified_time")
        date = _local_date(modified, timezone)
        kind = (
            "folder"
            if match["mime_type"] == "application/vnd.google-apps.folder"
            else ("video" if match["mime_type"].startswith("video/") else "file")
        )
        reason = _NOT_READ_LABELS.get(str((reasons or {}).get(match.get("source_ref"))))
        detail = " · ".join(item for item in (kind, date, reason) if item)
        lines.append(f"{index}. {title} · {detail} — [Open in Drive]({match['open_url']})")
    if truncated or len(matches) > limit:
        lines.append("More matches may exist. Ask for a narrower filename or period.")
    return "\n".join(lines)


def _local_date(value: object, timezone: str) -> str | None:
    """The file's calendar day in the owner's timezone, matching the stated window."""
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if moment.tzinfo is None:
            return value[:10]
        return moment.astimezone(ZoneInfo(timezone or "UTC")).date().isoformat()
    except (ValueError, ZoneInfoNotFoundError):
        return value[:10]


def _share_file(item: dict) -> dict:
    """Owner-only identity of a file A was shown; never part of B's answer."""
    return {
        "file_id": item["file_id"],
        "name": item["name"],
        "mime_type": item.get("mime_type") or "",
        "modified_time": item.get("modified_time"),
    }


def _metadata_sources(matches: list[dict], *, limit: int = 10) -> list[dict]:
    return [
        {"source_ref": item["source_ref"], "label": "Document", "kind": "metadata", "page": None}
        for item in matches[:limit]
    ]


def _outcome(
    status,
    answer=None,
    *,
    files=None,
    unreadable=False,
    found_truncated=False,
    time_window="",
    date_field="modified_time",
    timezone="UTC",
    sources=(),
    titles=(),
    truncated=False,
    metadata_only=False,
    selection=None,
    not_read=(),
    share_files=(),
):
    """Presentation-free turn result; each caller decides what its reader may see.

    ``not_read`` holds owner-private unreadable files (name, reason); only the
    owner's own view may name them, and a connection's answer gets a count.

    ``selection`` traces the live selector: ``completed`` with counts, or the
    recorded reason it was not asked (exact title, metadata-only listing).
    """
    return {
        "status": status,
        "answer": answer,
        "files": files,
        "unreadable": unreadable,
        "found_truncated": found_truncated,
        "time_window": time_window,
        "date_field": date_field,
        "timezone": timezone,
        "sources": list(sources),
        "titles": list(titles),
        "truncated": truncated,
        "metadata_only": metadata_only,
        "selection": selection,
        "not_read": list(not_read),
        "share_files": list(share_files),
    }


def _files_outcome(
    matches,
    found,
    *,
    status="ok",
    unreadable,
    time_window,
    date_field="modified_time",
    timezone="UTC",
    selection=None,
    not_read=(),
):
    return _outcome(
        status,
        files=matches,
        unreadable=unreadable,
        found_truncated=found["truncated"],
        time_window=time_window,
        date_field=date_field,
        timezone=timezone,
        sources=_metadata_sources(matches),
        titles=[item["name"] for item in matches[:10]],
        truncated=True if unreadable else found["truncated"] or len(matches) > 10,
        metadata_only=True,
        selection=selection,
        not_read=not_read,
        # Only the first MAX_READS, the titles a connection is shown: A is
        # never offered a file the asker didn't see (folders drop later).
        share_files=[_share_file(item) for item in matches[:MAX_READS]] if status == "ok" else [],
    )


_EXPLICIT_FILE_REFERENCE = re.compile(
    r"\b(?:(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s+"
    r"(?:one|file|document|result|recording))\b|"
    r"^\s*(?:please\s+)?(?:read|summarize|open)\s+(?:it|this|that)"
    r"(?:\s+(?:one|file|document|pdf))?[.!?]?\s*$",
    re.IGNORECASE,
)
_EXACT_TITLE_PRESENCE = re.compile(
    r"\s*[Dd]o\s+you\s+have\s+"
    r"(?P<title>[A-Z][\w-]*(?:\s+[A-Z][\w-]*){1,6})\s+"
    r"(?:document|file|doc)\s*[?.!]?\s*"
)


def simple_exact_title_presence_plan(message: str) -> LiveSearchPlan | None:
    """Recognize a named-file existence question as a metadata-only search.

    The narrow title-case form keeps broader or content questions with the
    typed planner. The Drive result is still checked for an exact title.
    """
    match = _EXACT_TITLE_PRESENCE.fullmatch(message)
    if match is None or len(match["title"]) > 50:
        return None
    title = match["title"]
    return LiveSearchPlan.model_validate({"terms": [title], "mode": "find", "exact_title": title})


class DriveChatService:
    def __init__(
        self,
        *,
        reader_factory=None,
        interpreter=interpret,
        oauth=None,
        search_planner=interpret_live_search,
        candidate_selector=interpret_candidate_selection,
    ):
        self.reader_factory = reader_factory
        self.interpreter = interpreter
        self.oauth = oauth
        self.search_planner = search_planner
        self.candidate_selector = candidate_selector

    async def handle_delegated_turn(
        self,
        *,
        user_id,
        consent_token,
        conversation_id,
        message,
        require_access,
        previous_answer="",
        timezone="UTC",
    ):
        await require_access()
        outcome = await self.run_live_query(
            user_id=user_id,
            consent_token=consent_token,
            query=message,
            require_access=require_access,
            previous_answer=previous_answer,
            timezone=timezone,
        )
        # The owner's own view may name unreadable files; a connection's never does.
        not_read = outcome.get("not_read") or []
        if outcome["files"] is None:
            text = outcome["answer"]
            if not_read and outcome["status"] == "ok":
                text += "\n\n" + _not_read_note(not_read)
        else:
            text = _found_files(
                outcome["files"],
                truncated=outcome["found_truncated"],
                unreadable=outcome["unreadable"],
                time_window=outcome["time_window"],
                date_field=outcome["date_field"],
                timezone=outcome["timezone"],
                reasons={
                    item["source_ref"]: item["reason"]
                    for item in not_read
                    if item.get("source_ref")
                },
            )
            if (outcome.get("selection") or {}).get("stage") == "ambiguous_exact_title":
                text += (
                    "\n\nMore than one file has that title. Choose one before I read its contents."
                )
            elif (outcome.get("selection") or {}).get("stage") == "incomplete_exact_title":
                text += (
                    "\n\nThis search may include more files with that title. "
                    "Choose one before I read its contents."
                )
        listing_selection = outcome.get("selection") or {}
        compile_available = (
            outcome["status"] == "ok"
            and listing_selection.get("stage") == "owner_title_date_listing"
        )
        return result(
            conversation_id,
            text,
            outcome["status"],
            sources=outcome["sources"],
            truncated=outcome["truncated"],
            metadata_only=outcome["metadata_only"],
            owner_compile_available=compile_available,
            owner_compile_query=(
                listing_selection.get("owner_compile_query") if compile_available else None
            ),
            owner_compile_window=(
                listing_selection.get("owner_compile_window") if compile_available else None
            ),
        )

    async def run_live_query(
        self,
        *,
        user_id,
        consent_token,
        query,
        require_access,
        previous_answer="",
        timezone="UTC",
        require_live=False,
    ):
        """One bounded owner-authorized turn: plan, find, read, interpret, fence.

        The owner's chat and an owner-approved question from a connection share
        this path, so both get the same caps, fences and fallbacks.
        """
        message = query
        if not message.strip() or len(message.encode()) > 2048:
            return _outcome(
                "input_required",
                "What would you like to know about your Drive files? Please keep the question brief.",
            )
        stage = "connection"
        live = False
        try:
            async with asyncio.timeout(160):
                if self.reader_factory:
                    reader = self.reader_factory(user_id=user_id, require_access=require_access)
                else:
                    oauth = self.oauth or get_external_connector_oauth_service().drive()
                    _, credential = await oauth.current_credential(user_id=user_id)
                    live = credential.get("profile") == "live"
                    if require_live and not live:
                        # A connection's question needs live search, not selected files.
                        return _outcome(
                            "reconnect_required", "Reconnect Drive in Connectors to continue."
                        )
                    reader = (DriveLiveReader if live else DriveDocumentReader)(
                        user_id=user_id, require_access=require_access, oauth=oauth
                    )
                query = message
                # Pure computation: the interpreter needs it on both paths.
                now_utc = datetime.now(datetime_timezone.utc)
                try:
                    owner_timezone = ZoneInfo(timezone or "UTC").key
                except (ValueError, ZoneInfoNotFoundError):
                    owner_timezone = "UTC"
                # An explicit all-files owner listing is a metadata question.
                # Keep it away from the model selector that can fail after a
                # successful Drive search, and never use it for B's question or
                # an owner-to-recipient sharing review.
                listing = parse_long_range_listing(message) if live and not require_live else None
                if listing is not None:
                    stage = "search_files"
                    await require_access()
                    first_day, last_day = listing.window(now_utc=now_utc, timezone=owner_timezone)
                    found = await discover_long_range_matches(
                        reader=reader,
                        spec=listing,
                        now_utc=now_utc,
                        timezone=owner_timezone,
                        window=(first_day, last_day),
                    )
                    matches = found["matches"]
                    await reader.require_current()
                    if not matches:
                        return _outcome(
                            "input_required",
                            "I couldn't confirm a title-and-date match in this bounded "
                            "Drive search. Try the exact meeting title or a narrower period.",
                        )
                    window = listing.window_description(now_utc=now_utc, timezone=owner_timezone)
                    count = len(matches)
                    opening = (
                        f"I found {count} candidate files by title and date "
                        "in a bounded Drive search."
                    )
                    if listing.requested_count is not None and count < listing.requested_count:
                        opening += f" You asked for {listing.requested_count}."
                    text = (
                        opening
                        + "\n\n"
                        + _found_files(
                            matches,
                            truncated=found["truncated"],
                            time_window=window,
                            date_field="listing_day",
                            timezone=owner_timezone,
                            limit=MAX_OWNER_LIST_DISPLAY,
                            intro="Open these possible matches:",
                        )
                    )
                    return _outcome(
                        "ok",
                        text,
                        sources=_metadata_sources(matches, limit=MAX_OWNER_LIST_DISPLAY),
                        titles=[item["name"] for item in matches[:MAX_OWNER_LIST_DISPLAY]],
                        truncated=found["truncated"] or count > MAX_OWNER_LIST_DISPLAY,
                        metadata_only=True,
                        selection={
                            "stage": "owner_title_date_listing",
                            "candidates": len(found["matches"]),
                            "selected": count,
                            "owner_compile_query": owner_compile_query(listing),
                            "owner_compile_window": {
                                "start_date": first_day.isoformat(),
                                "end_date": last_day.isoformat(),
                                "timezone": owner_timezone,
                            },
                        },
                    )
                selection = None
                if live:
                    stage = "search_plan"
                    await require_access()
                    exact_presence = simple_exact_title_presence_plan(message)
                    plan = exact_presence or simple_file_activity_plan(message)
                    if plan is None:
                        plan = await plan_live_search(
                            self.search_planner,
                            prompt=json.dumps(
                                {
                                    "document_request": {"purpose": message},
                                    "previous_answer": previous_answer[:2000],
                                    "current_time_utc": now_utc.isoformat(),
                                    "user_timezone": owner_timezone,
                                },
                                ensure_ascii=False,
                            ),
                            user_id=user_id,
                        )
                    query = plan.terms
                    if _EXPLICIT_FILE_REFERENCE.search(message) and (
                        not plan.exact_title
                        or plan.exact_title.casefold()
                        not in previous_answer.replace("\\", "").casefold()
                    ):
                        return _outcome(
                            "input_required",
                            "Which file do you mean? Please give me its title.",
                        )
                    stage = "search_files"
                    bounds = plan.time_bounds(now_utc=now_utc, timezone=owner_timezone)
                    search_kwargs = {
                        "query": query,
                        "file_kind": plan.file_kind,
                        "shared_with_me": plan.shared_with_me,
                        "recent": plan.sort == "recent",
                    }
                    if exact_presence is not None:
                        search_kwargs["title_only"] = True
                    date_field = (
                        "created_time" if plan.file_time_field == "createdTime" else "modified_time"
                    )
                    time_window = ""
                    if bounds is not None:
                        search_kwargs.update(
                            time_field=plan.file_time_field,
                            start_time=bounds[0],
                            end_time=bounds[1],
                        )
                        title_dates = plan.title_dates(now_utc=now_utc, timezone=owner_timezone)
                        if title_dates:
                            search_kwargs["title_dates"] = title_dates
                        start_local = datetime.fromisoformat(
                            bounds[0].replace("Z", "+00:00")
                        ).astimezone(ZoneInfo(owner_timezone))
                        end_local = datetime.fromisoformat(
                            bounds[1].replace("Z", "+00:00")
                        ).astimezone(ZoneInfo(owner_timezone))
                        action = "created" if plan.file_time_field == "createdTime" else "modified"
                        time_window = (
                            f"Files {action} from {start_local:%Y-%m-%d %H:%M} through "
                            f"{end_local:%Y-%m-%d %H:%M} ({owner_timezone})."
                        )
                    found = await reader.find(**search_kwargs)
                    matches = found["matches"]
                    if plan.exact_title:
                        matches = [
                            item
                            for item in matches
                            if item["name"].casefold() == plan.exact_title.strip().casefold()
                        ]
                        if not matches:
                            return _outcome(
                                "input_required",
                                "I couldn't identify that exact file in the current Drive results. Please give me its title or a more specific date.",
                            )
                        if found["truncated"]:
                            # The bounded search may have omitted another file
                            # with this exact name. Show found metadata, but
                            # never choose one for a content read.
                            await reader.require_current()
                            return _files_outcome(
                                matches,
                                found,
                                status="ok" if plan.mode == "find" else "input_required",
                                unreadable=False,
                                time_window=time_window,
                                date_field=date_field,
                                timezone=owner_timezone,
                                selection={
                                    "stage": "incomplete_exact_title",
                                    "candidates": len(matches),
                                    "selected": len(matches),
                                },
                            )
                        if len(matches) > 1:
                            # An exact name is not a unique file identity. Show
                            # the owner safe metadata for each match; never read
                            # several private files on an ambiguous read request.
                            await reader.require_current()
                            return _files_outcome(
                                matches,
                                found,
                                status="ok" if plan.mode == "find" else "input_required",
                                unreadable=False,
                                time_window=time_window,
                                date_field=date_field,
                                timezone=owner_timezone,
                                selection={
                                    "stage": "ambiguous_exact_title",
                                    "candidates": len(matches),
                                    "selected": len(matches),
                                },
                            )
                    if not matches:
                        return _outcome(
                            "input_required",
                            "I couldn't find a matching Drive file. Try a more specific filename or period.",
                        )
                    if plan.terms and not plan.exact_title:
                        # Keyword hits are candidates; the tool-less selector
                        # gene judges which are the requested document. A
                        # failure or invented ref fails closed below, never to
                        # the unfiltered list.
                        stage = "select_candidates"
                        await require_access()
                        matches, selection = await select_matches(
                            selector=self.candidate_selector,
                            # Same bounded context the planner saw, so "the
                            # first two" can be resolved; a connection's
                            # question always has none.
                            request={
                                "purpose": message,
                                "previous_answer": previous_answer[:2000],
                            },
                            mode=plan.mode,
                            sort=plan.sort,
                            matches=matches,
                            truncated=found["truncated"],
                            now_utc=now_utc,
                            timezone=owner_timezone,
                            user_id=user_id,
                        )
                        if not matches:
                            await reader.require_current()
                            return _outcome(
                                "input_required",
                                "None of the Drive files I found look like what you asked for. "
                                "Try a more specific file name or period.",
                                selection=selection,
                            )
                        if selection.get("over_limit"):
                            # The selector chose more than can be listed or
                            # read: say more matches may exist.
                            found = {**found, "truncated": True}
                    else:
                        # The skip is recorded, never silent (backend semantic
                        # boundary): an exact title was already resolved, or a
                        # metadata-only listing has no words to judge against.
                        selection = {
                            "stage": "exact_title" if plan.exact_title else "metadata_listing",
                            "candidates": len(matches),
                            "selected": len(matches),
                        }
                        # Enums and counts only: never titles, terms or the request.
                        logger.info(
                            "drive_select.skipped stage=%s mode=%s candidates=%d",
                            selection["stage"],
                            plan.mode,
                            len(matches),
                        )
                    if plan.mode == "find":
                        await reader.require_current()
                        return _files_outcome(
                            matches,
                            found,
                            unreadable=False,
                            time_window=time_window,
                            date_field=date_field,
                            timezone=owner_timezone,
                            selection=selection,
                        )
                await require_access()
                stage = "read_file_content"
                retrieved = (
                    await reader.read_matches(matches=matches, truncated=found["truncated"])
                    if live
                    else await reader.search(query=query)
                )
                content = retrieved["untrusted_external_content"]
                not_read = retrieved.get("unreadable") or []
                if not content:
                    await reader.require_current()
                    if live:
                        return _files_outcome(
                            matches,
                            found,
                            unreadable=True,
                            time_window=time_window,
                            date_field=date_field,
                            timezone=owner_timezone,
                            selection=selection,
                            not_read=not_read,
                        )
                    return _outcome(
                        "input_required",
                        (
                            "I couldn't find a readable match. Try a more specific filename or request."
                            if live
                            else "This connection only covers previously selected files. Reconnect Drive to search your Drive."
                        ),
                    )
                stage = "interpret"
                answer = DocumentAnswer.model_validate(
                    # The interpreter has no tools and receives bounded text.
                    await self.interpreter(
                        prompt=json.dumps(
                            {
                                "user_request": message,
                                # This answer can reach a connection: a local
                                # day, never the owner's timezone, and one
                                # unread total, never names or reasons. The
                                # owner gets those from _not_read_note.
                                "today_local": now_utc.astimezone(ZoneInfo(owner_timezone))
                                .date()
                                .isoformat(),
                                "retrieved_documents": {
                                    "untrusted_external_content": content,
                                    "truncated": retrieved["truncated"],
                                    "not_read": len(not_read),
                                },
                            },
                            ensure_ascii=False,
                        ),
                        user_id=user_id,
                        consent_token=consent_token,
                    )
                )
                stage = "source_fence"
                await reader.require_current()
                known = {item["source_ref"]: item for item in content}
                if set(answer.source_refs) - known.keys() or (
                    not answer.source_refs and not answer.none_relevant
                ):
                    raise ValueError("invalid document citations")
                text = answer.answer
                if retrieved["truncated"]:
                    text += (
                        "\n\nThis answer uses bounded excerpts; some document content was omitted."
                    )
                logger.info(
                    "drive_chat.answered selection=%s read=%d unreadable=%d cited=%d "
                    "none_relevant=%s",
                    (selection or {}).get("stage", "none"),
                    len(content),
                    len(not_read),
                    len(set(answer.source_refs)),
                    answer.none_relevant,
                )
                if answer.none_relevant:
                    # An explicit, cited-nothing negative is an answer, not a failure.
                    return _outcome(
                        "ok",
                        text,
                        truncated=retrieved["truncated"],
                        selection=selection,
                        not_read=not_read,
                    )
                sources = [
                    {
                        "source_ref": ref,
                        "label": "Document",
                        "kind": "document",
                        "page": known[ref]["page"],
                    }
                    for ref in dict.fromkeys(answer.source_refs)
                ]
                # The cited files, so A can share exactly what answered B.
                # Sharing is optional: anything missing means nothing to share,
                # never a failed answer.
                by_document = {row.get("document_id"): row for row in getattr(reader, "_rows", [])}
                by_file = {item.get("file_id"): item for item in matches} if live else {}
                share_files = []
                for ref in dict.fromkeys(answer.source_refs):
                    row = by_document.get(known[ref].get("document_ref"))
                    shown = by_file.get(row.get("file_id")) if row else None
                    if shown and shown.get("file_id") and shown.get("name"):
                        share_files.append(_share_file(shown))
                return _outcome(
                    "ok",
                    text,
                    sources=sources,
                    titles=[known[ref]["name"] for ref in dict.fromkeys(answer.source_refs)],
                    truncated=retrieved["truncated"],
                    selection=selection,
                    not_read=not_read,
                    share_files=share_files,
                )
        except PermissionError:
            raise
        except (DriveReadError, DriveOAuthError) as error:
            code = str(error)
            logger.warning("drive_chat.read_failed stage=%s code=%s", stage, code)
            if code in {"connect_required", "not_connected"}:
                return _outcome(
                    "connect_required",
                    "Connect Drive in Connectors to search and read files.",
                )
            if code in {"reconnect_required", "needs_reauth", "grant_rejected"}:
                return _outcome(
                    "reconnect_required",
                    "Reconnect Drive in Connectors to continue.",
                )
            if code == "narrow_selection_required":
                return _outcome(
                    "input_required",
                    "Ask for a more specific document or period.",
                )
            if code == "invalid_argument":
                return _outcome(
                    "input_required",
                    "Please ask a shorter question about your Drive files.",
                )
            if code == "source_changed" and not live:
                # A selected file is rechecked on a schedule; trying again at
                # once meets the same change until it is synced.
                return _outcome(
                    "source_changed",
                    "A file you selected changed since the private agent last read it. "
                    "Sync it in Connectors, or try again later.",
                )
            if code in {"source_changed", "connection_changed", "source_unavailable"}:
                return _outcome(
                    "source_changed",
                    "Drive access or the file changed. Try again.",
                )
        except SpecialistAdkTurnError:
            logger.warning("drive_chat.model_stage_failed stage=%s", stage)
            message = {
                "search_plan": "I couldn't plan this Drive search. No files were checked. Try a more specific title or date.",
                "select_candidates": "I found Drive candidates, but couldn't verify which files match. Try a more specific title or date.",
                "interpret": "I found Drive files, but couldn't finish an answer from their contents. Try again or ask for filenames only.",
            }.get(stage, "I couldn't finish this Drive request. Please try again.")
            return _outcome(
                "unavailable",
                message,
            )
        except Exception as error:
            # Only the stage and exception type are safe operational evidence.
            logger.warning("drive_chat.read_failed stage=%s type=%s", stage, type(error).__name__)
        return _outcome(
            "unavailable",
            "Drive document reading is temporarily unavailable. Please try again.",
        )
