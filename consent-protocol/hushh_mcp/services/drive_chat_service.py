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

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services.drive_document_retrieval import DriveDocumentReader
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_suggestion_service import (
    interpret_live_search,
    plan_live_search,
)
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = logging.getLogger("drive_chat_service")


class DocumentAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, max_length=5000)
    source_refs: list[str] = Field(default_factory=list, max_length=8)


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
        agent, prompt_parts=prompt, user_id=user_id, consent_token=consent_token, timeout_seconds=20
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def result(conversation_id, answer, status, *, sources=(), truncated=False, metadata_only=False):
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
        },
    }


def _found_files(
    matches: list[dict],
    *,
    truncated: bool,
    unreadable: bool = False,
    time_window: str = "",
    date_field: str = "modified_time",
    timezone: str = "UTC",
) -> str:
    """Render safe owner-only opening actions from validated provider IDs."""
    lines = [
        "I found these Drive files. I couldn't read their contents here, but you can open them:"
        if unreadable
        else "I found these Drive files:"
    ]
    if time_window:
        lines.append(time_window)
    for index, match in enumerate(matches[:10], 1):
        title = re.sub(r"\s+", " ", match["name"]).strip()[:180]
        title = re.sub(r"([\\`*_{}\[\]()#+.!>|~-])", r"\\\1", title)
        modified = match.get(date_field) or match.get("modified_time")
        date = _local_date(modified, timezone)
        kind = (
            "folder"
            if match["mime_type"] == "application/vnd.google-apps.folder"
            else ("video" if match["mime_type"].startswith("video/") else "file")
        )
        detail = " · ".join(item for item in (kind, date) if item)
        lines.append(f"{index}. {title} · {detail} — [Open in Drive]({match['open_url']})")
    if truncated or len(matches) > 10:
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


def _metadata_sources(matches: list[dict]) -> list[dict]:
    return [
        {"source_ref": item["source_ref"], "label": "Document", "kind": "metadata", "page": None}
        for item in matches[:10]
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
    share_files=(),
):
    """Presentation-free turn result; each caller decides what its reader may see."""
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
        "share_files": list(share_files),
    }


def _files_outcome(
    matches, found, *, unreadable, time_window, date_field="modified_time", timezone="UTC"
):
    return _outcome(
        "ok",
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
        share_files=[_share_file(item) for item in matches[:10]],
    )


_EXPLICIT_FILE_REFERENCE = re.compile(
    r"\b(?:(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s+"
    r"(?:one|file|document|result|recording))\b|"
    r"^\s*(?:please\s+)?(?:read|summarize|open)\s+(?:it|this|that)"
    r"(?:\s+(?:one|file|document|pdf))?[.!?]?\s*$",
    re.IGNORECASE,
)


class DriveChatService:
    def __init__(
        self,
        *,
        reader_factory=None,
        interpreter=interpret,
        oauth=None,
        search_planner=interpret_live_search,
    ):
        self.reader_factory = reader_factory
        self.interpreter = interpreter
        self.oauth = oauth
        self.search_planner = search_planner

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
        text = (
            outcome["answer"]
            if outcome["files"] is None
            else _found_files(
                outcome["files"],
                truncated=outcome["found_truncated"],
                unreadable=outcome["unreadable"],
                time_window=outcome["time_window"],
                date_field=outcome["date_field"],
                timezone=outcome["timezone"],
            )
        )
        return result(
            conversation_id,
            text,
            outcome["status"],
            sources=outcome["sources"],
            truncated=outcome["truncated"],
            metadata_only=outcome["metadata_only"],
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
        try:
            async with asyncio.timeout(160):
                live = False
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
                if live:
                    stage = "search_plan"
                    await require_access()
                    now_utc = datetime.now(datetime_timezone.utc)
                    try:
                        owner_timezone = ZoneInfo(timezone or "UTC").key
                    except (ValueError, ZoneInfoNotFoundError):
                        owner_timezone = "UTC"
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
                        if len(matches) != 1:
                            return _outcome(
                                "input_required",
                                "I couldn't identify that exact file in the current Drive results. Please give me its title or a more specific date.",
                            )
                    if not matches:
                        return _outcome(
                            "input_required",
                            "I couldn't find a matching Drive file. Try a more specific filename or period.",
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
                        )
                await require_access()
                stage = "read_file_content"
                retrieved = (
                    await reader.read_matches(matches=matches, truncated=found["truncated"])
                    if live
                    else await reader.search(query=query)
                )
                content = retrieved["untrusted_external_content"]
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
                            {"user_request": message, "retrieved_documents": retrieved},
                            ensure_ascii=False,
                        ),
                        user_id=user_id,
                        consent_token=consent_token,
                    )
                )
                stage = "source_fence"
                await reader.require_current()
                known = {item["source_ref"]: item for item in content}
                if not answer.source_refs or set(answer.source_refs) - known.keys():
                    raise ValueError("invalid document citations")
                sources = [
                    {
                        "source_ref": ref,
                        "label": "Document",
                        "kind": "document",
                        "page": known[ref]["page"],
                    }
                    for ref in dict.fromkeys(answer.source_refs)
                ]
                text = answer.answer
                if retrieved["truncated"]:
                    text += (
                        "\n\nThis answer uses bounded excerpts; some document content was omitted."
                    )
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
            if code in {"reconnect_required", "needs_reauth"}:
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
            if code in {"source_changed", "connection_changed", "source_unavailable"}:
                return _outcome(
                    "source_changed",
                    "Drive access or the file changed. Try again.",
                )
        except Exception as error:
            # Only the stage and exception type are safe operational evidence.
            logger.warning("drive_chat.read_failed stage=%s type=%s", stage, type(error).__name__)
        return _outcome(
            "unavailable",
            "Drive document reading is temporarily unavailable. Please try again.",
        )
