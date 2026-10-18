"""Request-time content check for files Google's own search cannot read.

Gear 2 (Drive ``fullText``) misses big files, long or scanned PDFs, images,
files changed in the last day, files with non-Latin titles and files reached
only through a shared folder. For those candidates this check downloads the
file through the existing fenced Drive read (the owner, grant and
connection-generation fence wraps every call), scans it with ClamAV, reads it
in a disposable parser child, and gets back only which concepts the text
holds and which dates its opening lines name. The text is dropped inside the
child; this process never sees it, so nothing readable is stored or logged.

The result is discovery evidence for the owner's "possible matches" list
(D3). It never authorises an automatic share and never widens one.

Work is bounded per request (files, bytes) and per slice (wall clock, files,
OCR pages), and resumes from a small checkpoint the caller keeps inside its
encrypted search checkpoint. No model is called. See
``drive_content_check_port`` for the contract and the kill switches.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import unicodedata
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from hushh_mcp.services.drive_content_check_port import (
    CHECKPOINT_VERSION,
    DEFAULT_BUDGET,
    FINAL_STATUSES,
    REASON_FRESH,
    REASON_IMAGE,
    REASON_NON_LATIN_TITLE,
    REASON_OVER_INDEX_SIZE,
    REASON_PDF_LIKELY_LONG,
    REASON_SHARED_FOLDER_ONLY,
    STATUS_CHECKED,
    STATUS_DEFERRED,
    STATUS_TOO_LARGE,
    STATUS_UNAVAILABLE,
    STATUS_UNREADABLE,
    STATUS_UNSAFE,
    ContentCheckBudget,
    ContentCheckOutcome,
    ContentFileResult,
    content_check_enabled,
)
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.drive_title_dates import period_decision
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import (
    FILE_ID,
    LIVE_COLLECTION_CONTENT_LIMIT,
    DriveReadError,
)

logger = drive_logger("drive_request_content_check")

MB = 1000 * 1000  # Google states its index limits in MB; the smaller unit reads more.
DOC_MIME = "application/vnd.google-apps.document"
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
SLIDES_MIME = "application/vnd.google-apps.presentation"
PDF_MIME = "application/pdf"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/jpg"})
# What the fenced read can download (or export) and the child can read.
READABLE_MIMES = frozenset(
    {
        PDF_MIME,
        DOCX_MIME,
        XLSX_MIME,
        "text/plain",
        "text/markdown",
        "text/csv",
        DOC_MIME,
        SHEET_MIME,
        SLIDES_MIME,
        *IMAGE_MIMES,
    }
)
GOOGLE_NATIVE = frozenset({DOC_MIME, SHEET_MIME, SLIDES_MIME})
# Drive's content index limits (Gemini Enterprise connector page, IDX): most
# types over 10 MB, XLSX over 20 MB and PDFs over 30 MB are not searchable.
DRIVE_INDEX_SIZE_LIMITS = {PDF_MIME: 30 * MB, XLSX_MIME: 20 * MB}
DRIVE_INDEX_DEFAULT_LIMIT = 10 * MB
# Size from which a PDF is likely past the 80 pages Drive's OCR covers.
PDF_LIKELY_LONG_BYTES = 8 * MB
MAX_GROUPS = 24
MAX_SPELLINGS = 160
MAX_SPELLING_CHARS = 200
MAX_CANDIDATES = 2000
_TRANSIENT = frozenset(
    {
        "provider_unavailable",
        "source_changed",
        "processing_timeout",
        "scanner_unavailable",
        "processor_unavailable",
    }
)
_HALT = frozenset({"reconnect_required", "connection_changed", "connector_unavailable"})
_UNREADABLE = frozenset(
    {"encrypted_document", "invalid_document", "no_extractable_text", "unsupported_format"}
)
_SAFE_CODES = frozenset(
    {
        *_TRANSIENT,
        *_UNREADABLE,
        "file_too_large",
        "source_unavailable",
        "unsafe_document",
        "budget",
    }
)


class ContentReader(Protocol):
    async def read(
        self,
        *,
        owner_id: str,
        file_id: str,
        connection_generation: int,
        max_file_bytes: int,
    ) -> dict:
        """``{"tooLarge": size}`` or ``{"mimeType": str, "content": bytes}``."""
        ...


def _latin(character: str) -> bool:
    return character.isascii() or unicodedata.name(character, "").startswith("LATIN")


def non_latin_title(name: object) -> bool:
    return isinstance(name, str) and any(
        character.isalpha() and not _latin(character) for character in name
    )


def _size(row: dict) -> int | None:
    value = row.get("size")
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and value.isdigit() and len(value) <= 20:
        return int(value)
    return None


def _timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def drive_blind_reasons(row: dict, *, now: datetime, fresh_hours: int = 24) -> tuple[str, ...]:
    """Why Drive's own content search likely cannot see this file, if it cannot."""
    mime = row.get("mimeType")
    reasons = []
    size = _size(row)
    if size is not None and mime not in GOOGLE_NATIVE:
        # A Google editor file's size is storage bytes, not text length.
        if size > DRIVE_INDEX_SIZE_LIMITS.get(mime, DRIVE_INDEX_DEFAULT_LIMIT):
            reasons.append(REASON_OVER_INDEX_SIZE)
        elif mime == PDF_MIME and size >= PDF_LIKELY_LONG_BYTES:
            reasons.append(REASON_PDF_LIKELY_LONG)
    if mime in IMAGE_MIMES:
        reasons.append(REASON_IMAGE)
    changed = _timestamp(row.get("modifiedTime")) or _timestamp(row.get("createdTime"))
    if changed is not None and now - changed <= timedelta(hours=fresh_hours):
        reasons.append(REASON_FRESH)
    if non_latin_title(row.get("name")):
        reasons.append(REASON_NON_LATIN_TITLE)
    if row.get("source") == "walk":
        reasons.append(REASON_SHARED_FOLDER_ONLY)
    return tuple(reasons)


def select_drive_blind(
    candidates: Sequence[dict], *, now: datetime, fresh_hours: int = 24
) -> tuple[list[tuple[dict, tuple[str, ...]]], int]:
    """Drive-blind, readable candidates, newest first; and the unreadable count."""
    seen: set[str] = set()
    chosen: list[tuple[dict, tuple[str, ...]]] = []
    unsupported = 0
    for row in list(candidates)[:MAX_CANDIDATES]:
        file_id = row.get("id") if isinstance(row, dict) else None
        if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id) or file_id in seen:
            continue
        seen.add(file_id)
        reasons = drive_blind_reasons(row, now=now, fresh_hours=fresh_hours)
        if not reasons:
            continue
        if row.get("mimeType") not in READABLE_MIMES or row.get("trashed") is True:
            unsupported += 1
            continue
        chosen.append((row, reasons))
    chosen.sort(key=lambda item: item[0]["id"])
    chosen.sort(key=lambda item: item[0].get("modifiedTime") or "", reverse=True)
    return chosen, unsupported


def _groups(concepts: Sequence[Sequence[str]]) -> list[list[str]]:
    groups = [
        list(dict.fromkeys(item for item in concept if isinstance(item, str) and item.strip()))
        for concept in concepts
    ]
    if (
        len(groups) > MAX_GROUPS
        or any(not group for group in groups)
        or sum(len(group) for group in groups) > MAX_SPELLINGS
        or any(len(item) > MAX_SPELLING_CHARS for group in groups for item in group)
    ):
        raise DriveReadError("invalid_argument")
    return groups


def _requirements(value: Sequence[Sequence[int]] | None, groups: int) -> list[list[int]]:
    if value is None:
        return [list(range(groups))] if groups else []
    requirements = [sorted(set(item)) for item in value]
    if not requirements or any(
        not requirement
        or any(type(index) is not int or not 0 <= index < groups for index in requirement)
        for requirement in requirements
    ):
        raise DriveReadError("invalid_argument")
    return requirements


def _signature(groups, requirements, period, generation, precedence) -> str:
    material = json.dumps(
        [CHECKPOINT_VERSION, groups, requirements, period, generation, precedence],
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode()).hexdigest()


def _result_from_checkpoint(value: object, groups: list[list[str]]) -> ContentFileResult | None:
    try:
        matched = tuple(int(index) for index in value["matched"])
        if any(not 0 <= index < len(groups) for index in matched):
            return None
        status = value["status"]
        if status not in FINAL_STATUSES or not FILE_ID.fullmatch(value["id"]):
            return None
        return ContentFileResult(
            file_id=value["id"],
            status=status,
            reasons=tuple(str(reason) for reason in value["reasons"]),
            matched=matched,
            matched_concepts=tuple(groups[index][0] for index in matched),
            requirement_met=value["requirementMet"] is True,
            date_found=value.get("dateFound"),
            date_basis=value.get("dateBasis"),
            in_period=value.get("inPeriod"),
            pages_read=int(value.get("pagesRead") or 0),
            total_pages=value.get("totalPages"),
            ocr_pages=int(value.get("ocrPages") or 0),
            complete=value.get("complete") is True,
            error_code=value.get("errorCode"),
        )
    except (KeyError, TypeError, ValueError):
        return None


class FencedContentReader:
    """Downloads through the live REST transport's owner/grant/generation fence.

    Metadata is read before and after the bytes (the same version must hold),
    and the fenced metadata read refuses trashed, non-downloadable,
    client-side-encrypted and (by default) Gen-AI-restricted files. Bytes
    stay in memory and go only to the scanner and the parser child.
    """

    def __init__(
        self,
        *,
        oauth: Any = None,
        adapter: Any = None,
        writer: Any = None,
        respect_genai_opt_out: bool = True,
    ):
        self._transport = None
        self._parts = {"oauth": oauth, "adapter": adapter, "writer": writer}
        self._respect_genai_opt_out = respect_genai_opt_out

    def _content_transport(self):
        if self._transport is None:
            from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

            class _ContentTransport(GoogleDriveRestTransport):
                async def _content_check_read(self, arguments: dict, token: str) -> dict:
                    file_id = arguments.get("fileId")
                    limit = arguments.get("maxBytes")
                    genai = arguments.get("requireGenAi")
                    if (
                        set(arguments) != {"fileId", "maxBytes", "requireGenAi"}
                        or not isinstance(file_id, str)
                        or not FILE_ID.fullmatch(file_id)
                        or type(limit) is not int
                        or not 1 <= limit <= LIVE_COLLECTION_CONTENT_LIMIT
                        or type(genai) is not bool
                    ):
                        raise DriveReadError("invalid_argument")
                    flags = {"require_app_authorized": False, "require_genai_eligibility": genai}
                    before = await self.adapter.get_metadata(
                        file_id=file_id, access_token=token, **flags
                    )
                    if before.size is not None and before.size > limit:
                        return {"tooLarge": before.size}
                    mime, content = await self.adapter.read_live_bytes(
                        file_id=file_id,
                        mime_type=before.mime_type,
                        access_token=token,
                        max_bytes=LIVE_COLLECTION_CONTENT_LIMIT,
                    )
                    if len(content) > limit:
                        return {"tooLarge": len(content)}
                    after = await self.adapter.get_metadata(
                        file_id=file_id, access_token=token, **flags
                    )
                    if after != before:
                        raise DriveReadError("source_changed", retryable=True)
                    return {"mimeType": mime, "content": content}

            # The base transport's own owner, grant and generation checks
            # (``_fenced``) wrap this one extra read; none are re-implemented.
            self._transport = _ContentTransport(**self._parts)
        return self._transport

    async def read(
        self,
        *,
        owner_id: str,
        file_id: str,
        connection_generation: int,
        max_file_bytes: int,
    ) -> dict:
        transport = self._content_transport()
        result = await transport._fenced(
            owner_id,
            "content_check_read",
            {
                "fileId": file_id,
                "maxBytes": max_file_bytes,
                "requireGenAi": self._respect_genai_opt_out,
            },
            {"content_check_read": "_content_check_read"},
            8192,
            expected_generation=connection_generation,
        )
        return result.payload


class RequestContentCheck:
    """The real content check; see ``drive_content_check_port.ContentCheck``."""

    enabled = True

    def __init__(
        self,
        *,
        reader: ContentReader | None = None,
        processor: Any = None,
        enabled: Callable[[], bool] = content_check_enabled,
    ):
        self._reader = reader
        self._processor = processor
        self._enabled = enabled

    def _the_reader(self) -> ContentReader:
        if self._reader is None:
            self._reader = FencedContentReader()
        return self._reader

    def _the_processor(self):
        if self._processor is None:
            from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor

            self._processor = LocalDocumentProcessor()
        return self._processor

    async def check_files(
        self,
        *,
        owner_id: str,
        candidates: Sequence[dict],
        concepts: Sequence[Sequence[str]],
        period: dict | None,
        connection_generation: int,
        require_current: Callable[[], Awaitable[object]],
        requirements: Sequence[Sequence[int]] | None = None,
        checkpoint: dict | None = None,
        precedence: bool = True,
        budget: ContentCheckBudget = DEFAULT_BUDGET,
        now: datetime | None = None,
    ) -> ContentCheckOutcome:
        # Re-checked on every call: an operator flag flip or a drain kill
        # switch stops the check before any Drive call, even mid-request.
        if not self._enabled():
            return ContentCheckOutcome("disabled", checkpoint=checkpoint)
        budget.validate()
        if not isinstance(owner_id, str) or not owner_id or type(connection_generation) is not int:
            raise DriveReadError("invalid_argument")
        groups = _groups(concepts)
        if not groups:
            return ContentCheckOutcome("not_needed", checkpoint=checkpoint)
        required = _requirements(requirements, len(groups))
        try:
            # A malformed period fails here, before any download, not mid-slice.
            period_decision({"name": ""}, period)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise DriveReadError("invalid_argument") from None
        signature = _signature(groups, required, period, connection_generation, precedence)
        state = (
            checkpoint
            if isinstance(checkpoint, dict)
            and checkpoint.get("version") == CHECKPOINT_VERSION
            and checkpoint.get("signature") == signature
            else {}
        )
        results: dict[str, ContentFileResult] = {}
        for value in state.get("results", ()):
            result = _result_from_checkpoint(value, groups)
            if result is not None:
                results[result.file_id] = result
        attempts: dict[str, int] = {
            key: value
            for key, value in (state.get("attempts") or {}).items()
            if isinstance(key, str) and type(value) is int and 0 < value <= budget.max_attempts
        }
        used = {
            "files": max(0, int(state.get("files") or 0)),
            "bytes": max(0, int(state.get("bytes") or 0)),
        }
        moment = now or datetime.now(UTC)
        selected, unsupported = select_drive_blind(
            candidates, now=moment, fresh_hours=budget.fresh_hours
        )
        queue = [(row, reasons) for row, reasons in selected if row["id"] not in results]
        # Files a slice already tried (a transient failure, or OCR the slice
        # could not afford) go first, so each one gets its fair retry.
        queue.sort(key=lambda item: 0 if attempts.get(item[0]["id"]) else 1)
        counts: Counter = Counter()
        slice_ocr = [budget.max_ocr_pages_per_slice]
        started = time.monotonic()
        soft_deadline = started + budget.slice_seconds / 2
        halted = [False]
        semaphore = asyncio.Semaphore(budget.concurrency)
        processor = self._the_processor()
        reader = self._the_reader()
        taken = [0]
        in_flight: dict[str, tuple[dict, tuple[str, ...]]] = {}

        async def fenced() -> None:
            try:
                await require_current()
            except BaseException:
                halted[0] = True
                raise

        def finish(row, reasons, status, *, code=None, leaf=None) -> None:
            file_id = row["id"]
            in_flight.pop(file_id, None)
            if status == STATUS_DEFERRED:
                attempts[file_id] = attempts.get(file_id, 0) + 1
                if attempts[file_id] < budget.max_attempts:
                    counts["deferred"] += 1
                    return
                status = STATUS_UNAVAILABLE
            attempts.pop(file_id, None)
            counts[status] += 1
            if leaf is None:
                results[file_id] = ContentFileResult(
                    file_id=file_id,
                    status=status,
                    reasons=reasons,
                    error_code=code if code in _SAFE_CODES else None,
                )
                return
            matched = leaf["matched"]
            decision = period_decision(
                {
                    "name": "",
                    "created_time": row.get("createdTime"),
                    "modified_time": row.get("modifiedTime"),
                },
                period,
                precedence=precedence,
                raw=leaf["dates"],
            )
            content_dated = decision.basis == "title"
            met = any(all(index in matched for index in requirement) for requirement in required)
            if met:
                counts["requirement_met"] += 1
            results[file_id] = ContentFileResult(
                file_id=file_id,
                status=STATUS_CHECKED,
                reasons=reasons,
                matched=tuple(matched),
                matched_concepts=tuple(groups[index][0] for index in matched),
                requirement_met=met,
                date_found=decision.listing_day if content_dated else None,
                date_basis="content" if content_dated else decision.basis,
                in_period=decision.in_period,
                pages_read=leaf["pages_read"],
                total_pages=leaf["total_pages"],
                ocr_pages=leaf["ocr_pages"],
                complete=leaf["complete"],
            )

        async def one(row: dict, reasons: tuple[str, ...]) -> None:
            async with semaphore:
                if halted[0] or time.monotonic() > soft_deadline:
                    return
                if (
                    used["files"] >= budget.max_files
                    or used["bytes"] >= budget.max_bytes
                    or taken[0] >= budget.max_files_per_slice
                ):
                    return
                # Reserve this file's OCR pages before it starts, so files
                # running side by side never spend more than the slice allows;
                # what the child does not use is refunded when it ends. An
                # image is one OCR page, a PDF may need the per-file maximum.
                mime_hint = row.get("mimeType")
                wanted = min(
                    budget.max_ocr_pages_per_slice,
                    min(1, budget.max_ocr_pages)
                    if mime_hint in IMAGE_MIMES
                    else budget.max_ocr_pages
                    if mime_hint == PDF_MIME
                    else 0,
                )
                ocr_pages = max(0, min(wanted, slice_ocr[0]))
                if ocr_pages < wanted and (mime_hint in IMAGE_MIMES or attempts.get(row["id"])):
                    # OCR is an image's only reader, and a retry is read with
                    # its full OCR allowance: with this slice's OCR spent,
                    # leave it pending, unread, for the next slice.
                    return
                slice_ocr[0] -= ocr_pages
                consumed = [0]
                try:
                    await read_one(row, reasons, ocr_pages, wanted, consumed)
                finally:
                    slice_ocr[0] += ocr_pages - consumed[0]

        async def read_one(row, reasons, ocr_pages: int, wanted: int, consumed: list) -> None:
            """Download, scan and read one file; ``consumed`` gets the OCR pages it used."""
            used["files"] += 1
            taken[0] += 1
            file_id = row["id"]
            in_flight[file_id] = (row, reasons)
            limit = min(budget.max_file_bytes, budget.max_bytes - used["bytes"])
            await fenced()
            try:
                payload = await reader.read(
                    owner_id=owner_id,
                    file_id=file_id,
                    connection_generation=connection_generation,
                    max_file_bytes=limit,
                )
            except DriveOAuthError:
                # The grant is gone or changed: nothing more may be read.
                halted[0] = True
                raise
            except DriveReadError as error:
                code = str(error)
                if code in _HALT:
                    halted[0] = True
                    raise
                if code == "file_too_large":
                    finish(row, reasons, STATUS_TOO_LARGE, code=code)
                elif code == "unsupported_format":
                    finish(row, reasons, STATUS_UNREADABLE, code=code)
                elif error.retryable or code in _TRANSIENT:
                    finish(row, reasons, STATUS_DEFERRED, code=code)
                else:
                    finish(row, reasons, STATUS_UNAVAILABLE, code=code)
                return
            except Exception:  # noqa: BLE001 - one odd file never fails the search
                finish(row, reasons, STATUS_DEFERRED, code="provider_unavailable")
                return
            # Access revoked during the read: drop the bytes, stop the check.
            await fenced()
            if not isinstance(payload, dict):
                finish(row, reasons, STATUS_UNAVAILABLE, code="provider_response_invalid")
                return
            if "tooLarge" in payload:
                size = payload["tooLarge"]
                if type(size) is int and size > budget.max_file_bytes:
                    finish(row, reasons, STATUS_TOO_LARGE, code="file_too_large")
                else:
                    # Only over what is left of this request's byte budget:
                    # close the byte budget; the file stays unread (pending).
                    in_flight.pop(file_id, None)
                    used["bytes"] = budget.max_bytes
                    counts["budget"] += 1
                return
            content = payload.get("content")
            mime = payload.get("mimeType")
            payload = None
            if not isinstance(content, bytes) or not isinstance(mime, str):
                finish(row, reasons, STATUS_UNAVAILABLE, code="provider_response_invalid")
                return
            used["bytes"] += len(content)
            try:
                leaf = await processor.check_content(
                    content=content,
                    mime_type=mime,
                    concepts=groups,
                    max_text_pages=budget.max_text_pages,
                    max_ocr_pages=ocr_pages,
                )
            except DriveReadError as error:
                code = str(error)
                if code == "unsafe_document":
                    finish(row, reasons, STATUS_UNSAFE, code=code)
                elif code == "file_too_large":
                    finish(row, reasons, STATUS_TOO_LARGE, code=code)
                elif code in _TRANSIENT or error.retryable:
                    finish(row, reasons, STATUS_DEFERRED, code=code)
                else:
                    finish(row, reasons, STATUS_UNREADABLE, code=code)
                return
            except Exception:  # noqa: BLE001 - one odd file never fails the search
                finish(row, reasons, STATUS_DEFERRED, code="processor_unavailable")
                return
            finally:
                # The bytes go no further than the scanner and the child.
                content = None
            consumed[0] = min(ocr_pages, max(0, int(leaf.get("ocr_pages") or 0)))
            matched = leaf["matched"]
            if (
                ocr_pages < wanted
                and int(leaf.get("gaps") or 0) > 0
                and leaf.get("complete") is not True
                and not any(
                    all(index in matched for index in requirement) for requirement in required
                )
            ):
                # Pages went unread only because this slice's OCR ran
                # out: not final. A later slice reads it again, first in
                # line and only with its full allowance, so a retry is
                # never starved; a file whose pages exceed that allowance
                # ends checked but not complete, and the caller reports
                # it as partly read (partial coverage).
                attempts[file_id] = attempts.get(file_id, 0) + 1
                if attempts[file_id] < budget.max_attempts:
                    in_flight.pop(file_id, None)
                    counts["ocr_deferred"] += 1
                    return
            finish(row, reasons, STATUS_CHECKED, leaf=leaf)

        outcome = "ok"
        try:
            async with asyncio.timeout(budget.slice_seconds), asyncio.TaskGroup() as group:
                for row, reasons in queue[: budget.max_files_per_slice]:
                    group.create_task(one(row, reasons))
        except TimeoutError:
            outcome = "deadline"
            # A file cut off by the slice deadline counts as one attempt, so
            # a file that can never finish in a slice stops being retried.
            for row, reasons in list(in_flight.values()):
                finish(row, reasons, STATUS_DEFERRED, code="processing_timeout")
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except BaseExceptionGroup as failure:
            outcome = "fenced"
            raise failure.exceptions[0] from None
        finally:
            pending = sum(1 for row, _ in selected if row["id"] not in results)
            spent = used["files"] >= budget.max_files or used["bytes"] >= budget.max_bytes
            logger.info(
                "drive_content_check.slice outcome=%s candidates=%d selected=%d unsupported=%d "
                "checked=%d requirement_met=%d too_large=%d unreadable=%d unavailable=%d "
                "unsafe=%d deferred=%d ocr_deferred=%d pending=%d budget_spent=%d bytes=%d "
                "duration_ms=%.1f",
                outcome,
                len(candidates),
                len(selected),
                unsupported,
                counts[STATUS_CHECKED],
                counts["requirement_met"],
                counts[STATUS_TOO_LARGE],
                counts[STATUS_UNREADABLE],
                counts[STATUS_UNAVAILABLE],
                counts[STATUS_UNSAFE],
                counts["deferred"],
                counts["ocr_deferred"],
                pending,
                int(spent),
                used["bytes"],
                (time.monotonic() - started) * 1000,
            )
        ordered = [results[row["id"]] for row, _ in selected if row["id"] in results]
        ordered += [
            result
            for file_id, result in results.items()
            if file_id not in {row["id"] for row, _ in selected}
        ]
        status = "complete" if pending == 0 else "budget_exhausted" if spent else "partial"
        reason_counts = Counter(reason for _, reasons in selected for reason in reasons)
        status_counts = Counter(result.status for result in ordered)
        return ContentCheckOutcome(
            status=status,
            results=tuple(ordered),
            checkpoint={
                "version": CHECKPOINT_VERSION,
                "signature": signature,
                "results": [result.as_checkpoint() for result in ordered],
                "attempts": attempts,
                "files": used["files"],
                "bytes": used["bytes"],
            },
            pending=pending,
            counts={
                "selected": len(selected),
                "unsupported": unsupported,
                "pending": pending,
                "possibleMatches": sum(1 for result in ordered if result.possible_match),
                "byReason": dict(reason_counts),
                "byStatus": dict(status_counts),
                "budgetSpent": spent,
            },
        )


__all__ = [
    "DRIVE_INDEX_DEFAULT_LIMIT",
    "DRIVE_INDEX_SIZE_LIMITS",
    "PDF_LIKELY_LONG_BYTES",
    "READABLE_MIMES",
    "FencedContentReader",
    "RequestContentCheck",
    "drive_blind_reasons",
    "non_latin_title",
    "select_drive_blind",
]
