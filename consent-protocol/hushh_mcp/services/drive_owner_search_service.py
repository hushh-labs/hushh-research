"""Checkpointed Drive REST metadata collection under explicit per-search consent.

The planner runs once in the authenticated route. This service freezes that
plan; background work never invokes a model, reads contents, or grants access.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import re
import time
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_live_reader import MIME_CLAUSES, DriveLiveReader, _open_url
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

PAGE_SIZE = 25
MAX_SLICE_PAGES = 4
SLICE_SECONDS = 90
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
    plan: dict, purpose: dict, timezone: str
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
    now = datetime.now(UTC)
    start = purpose.get("periodStart")
    end = purpose.get("periodEnd")
    if start is None and end is None:
        month = _MONTH_WINDOW.search(purpose.get("purpose", ""))
        if month:
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
    if parsed.file_kind != "any":
        base.append(
            "("
            + MIME_CLAUSES[parsed.file_kind]
            + " or mimeType = 'application/vnd.google-apps.shortcut')"
        )
    if parsed.shared_with_me:
        base.append("sharedWithMe = true")
    if parsed.exact_title:
        subject = f"name = {quote_literal(parsed.exact_title)}"
    elif parsed.terms:
        # OR preserves files whose title or text uses only one of the planner's
        # terms; the owner decides the final set from the complete preview.
        terms = [
            variant
            for term in parsed.terms
            for variant in (
                ("standup", "stand up", "stand-up")
                if term.casefold() in {"standup", "stand-up", "stand up"}
                else (term,)
            )
        ]
        subject = (
            "(" + " or ".join(compile_search_terms([term]) for term in dict.fromkeys(terms)) + ")"
        )
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
            title_days.append(date(*(int(part) for part in match_date.groups())))
        except ValueError:
            continue
    if title_days:
        return any(start <= day <= end for day in title_days)
    for key in ("created_time", "modified_time"):
        value = match.get(key)
        if isinstance(value, str):
            try:
                day = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(zone).date()
            except ValueError:
                continue
            if start <= day <= end:
                return True
    return False


def _matches_requested_kind(kind: str, mime: str) -> bool:
    if kind == "any":
        return True
    if kind == "document":
        return (
            mime in {"application/vnd.google-apps.document", "application/msword"}
            or "wordprocessingml" in mime
        )
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
    def __init__(self, store=None, transport=None):
        self.store = store or DriveOwnerSearchStore()
        self.transport = transport or GoogleDriveRestTransport()

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
    ):
        """Start or resume the owner-approved request's durable metadata search."""
        await require_current()
        query = purpose["purpose"]
        request = self._request(query, timezone)
        existing = await self.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None:
            if existing["status"] not in {"failed", "limited", "stopped"}:
                return existing
            await self.store.clear_terminal_request(user_id=user_id, request_id=request_id)
        queries, period = compile_request_queries(plan, purpose, timezone)
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
                "request_file_kind": plan.get("file_kind", "any"),
                "requested_period": period,
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
                require_current=require_current,
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

    async def _page(self, job):
        checkpoint = copy.deepcopy(job["checkpoint"])
        phase = checkpoint["phase"]
        if phase == "drives":
            args = {"pageSize": PAGE_SIZE}
            if checkpoint["drive_page_token"]:
                args["pageToken"] = checkpoint["drive_page_token"]
            result = await self.transport.read_tool(
                user_id=job["user_id"], tool_name="list_shared_drives", arguments=args
            )
            payload = result.payload
            if result.is_error or result.truncated:
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
        args = {**checkpoint["arguments"], "pageSize": PAGE_SIZE}
        if checkpoint["page_token"]:
            args["pageToken"] = checkpoint["page_token"]
        if phase == "files":
            args["driveId"] = checkpoint["drives"][checkpoint["drive_index"]]
        result = await self.transport.read_tool(
            user_id=job["user_id"], tool_name="search_files", arguments=args
        )
        payload = result.payload
        candidates = payload.get("files")
        incomplete = payload.get("incompleteSearch", False)
        if (
            result.is_error
            or result.truncated
            or payload.get("overLimit") is True
            or type(incomplete) is not bool
            or not isinstance(candidates, list)
            or len(candidates) > PAGE_SIZE
        ):
            raise DriveReadError("provider_response_invalid")
        files = []
        shortcut_targets = {}
        if checkpoint.get("request_origin_id"):
            targets = {
                details["targetId"]
                for candidate in candidates
                if isinstance(candidate, dict)
                if candidate.get("mimeType") == "application/vnd.google-apps.shortcut"
                for details in [candidate.get("shortcutDetails")]
                if isinstance(details, dict)
                and isinstance(details.get("targetId"), str)
                and FILE_ID.fullmatch(details["targetId"])
            }
            semaphore = asyncio.Semaphore(6)

            async def target_metadata(target):
                async with semaphore:
                    try:
                        result = await self.transport.read_tool(
                            user_id=job["user_id"],
                            tool_name="get_file_metadata",
                            arguments={"fileId": target},
                        )
                    except DriveReadError as error:
                        if str(error) != "source_unavailable":
                            raise
                        return target, None
                    return target, result

            shortcut_targets = dict(
                await asyncio.gather(*(target_metadata(target) for target in targets))
            )
        for candidate in candidates:
            match = DriveLiveReader._match(candidate)
            if match is None:
                incomplete = True
                continue
            if (
                checkpoint.get("request_origin_id")
                and match["mime_type"] == "application/vnd.google-apps.folder"
            ):
                continue
            if (
                checkpoint.get("request_origin_id")
                and match["mime_type"] == "application/vnd.google-apps.shortcut"
            ):
                alias = match["name"]
                details = candidate.get("shortcutDetails") if isinstance(candidate, dict) else None
                target = details.get("targetId") if isinstance(details, dict) else None
                target_mime = details.get("targetMimeType") if isinstance(details, dict) else None
                if not isinstance(target, str) or not FILE_ID.fullmatch(target):
                    if _in_requested_period(match, checkpoint.get("requested_period")):
                        files.append(
                            {
                                "id": match["file_id"],
                                "name": alias,
                                "mimeType": match["mime_type"],
                                "modifiedTime": match["modified_time"],
                                "createdTime": match.get("created_time"),
                                "openUrl": match["open_url"],
                                "shareable": False,
                                "unavailableReason": "shortcut_target_unavailable",
                            }
                        )
                    continue
                target_result = shortcut_targets.get(target)
                if target_result is not None and (
                    target_result.is_error
                    or target_result.truncated
                    or not isinstance(target_result.payload, dict)
                ):
                    raise DriveReadError("provider_response_invalid")
                target_file = (
                    target_result.payload.get("file")
                    if target_result and isinstance(target_result.payload, dict)
                    else None
                )
                if target_result is not None and not isinstance(target_file, dict):
                    raise DriveReadError("provider_response_invalid")
                if (
                    target_result is None
                    or target_file.get("id") != target
                    or not isinstance(target_file.get("title"), str)
                    or not target_file["title"]
                    or target_file.get("mimeType")
                    in {
                        "application/vnd.google-apps.shortcut",
                        "application/vnd.google-apps.folder",
                    }
                    or target_mime
                    and target_file.get("mimeType") != target_mime
                ):
                    if _in_requested_period(match, checkpoint.get("requested_period")):
                        files.append(
                            {
                                "id": match["file_id"],
                                "name": alias,
                                "mimeType": match["mime_type"],
                                "modifiedTime": match["modified_time"],
                                "createdTime": match.get("created_time"),
                                "openUrl": match["open_url"],
                                "shareable": False,
                                "unavailableReason": "shortcut_target_unavailable",
                            }
                        )
                    continue
                if not _matches_requested_kind(
                    checkpoint.get("request_file_kind", "any"), target_file["mimeType"]
                ):
                    continue
                match = {
                    **match,
                    "file_id": target,
                    "name": target_file["title"],
                    "mime_type": target_file["mimeType"],
                    "modified_time": target_file.get("modifiedTime") or match["modified_time"],
                    "open_url": _open_url(target, target_file.get("viewUrl")),
                    "shortcut_name": alias,
                }
            day = checkpoint.get("title_date")
            if day and day not in match["name"] and day.replace("-", "/") not in match["name"]:
                continue
            if not (
                _in_requested_period(match, checkpoint.get("requested_period"))
                or match.get("shortcut_name")
                and _in_requested_period(
                    {**match, "name": match["shortcut_name"]}, checkpoint.get("requested_period")
                )
            ):
                continue
            files.append(
                {
                    "id": match["file_id"],
                    "name": match["name"],
                    "mimeType": match["mime_type"],
                    "modifiedTime": match["modified_time"],
                    "createdTime": match.get("created_time"),
                    **(
                        {"shortcutName": match["shortcut_name"]}
                        if match.get("shortcut_name")
                        else {}
                    ),
                    "openUrl": match["open_url"],
                }
            )
        next_token = _token(payload, checkpoint["page_token"], checkpoint)
        checkpoint["page_token"] = next_token
        done = False
        if not next_token:
            if phase == "user":
                _phase(checkpoint, "drives")
            elif checkpoint["drive_index"] + 1 < len(checkpoint["drives"]):
                checkpoint["drive_index"] += 1
                _phase(checkpoint, "files")
            elif checkpoint["drive_page_token"]:
                _phase(checkpoint, "drives")
            else:
                done = _advance_query(checkpoint)
        return checkpoint, files, incomplete, done

    @drive_operation(job_key="job_id")
    async def run_one(
        self,
        *,
        user_id,
        job_id,
        max_pages=MAX_SLICE_PAGES,
        deadline_seconds=SLICE_SECONDS,
        require_current=None,
    ):
        if (
            type(max_pages) is not int
            or not 1 <= max_pages <= MAX_SLICE_PAGES
            or not 1 <= deadline_seconds <= SLICE_SECONDS
        ):
            raise ValueError("invalid search slice bounds")
        job = await self.store.claim(user_id=user_id, job_id=job_id)
        if job is None:
            return "not_claimed"
        started = time.monotonic()
        pages = 0
        found = 0
        outcome = "failed"

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
                    phase = phase if phase in {"user", "drives", "files"} else "unknown"
                    page_outcome = "failed"
                    page_count = 0
                    try:
                        checkpoint, files, incomplete, done = await self._page(job)
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
                    if result["status"] != "running":
                        return finish(result["status"])
            return finish(await self.store.release(job))
        except TimeoutError:
            return finish(
                await self.store.release(job, error="provider_unavailable", retryable=True)
            )
        except DriveReadError as error:
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
