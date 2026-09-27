"""Checkpointed Drive REST metadata collection under explicit per-search consent.

The planner runs once in the authenticated route. This service freezes that
plan; background work never invokes a model, reads contents, or grants access.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import time
from datetime import UTC, datetime

from hushh_mcp.services.drive_live_reader import MIME_CLAUSES, DriveLiveReader
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
