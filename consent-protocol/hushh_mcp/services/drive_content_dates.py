"""No-model date check for name-matched files whose titles carry no date.

A statement named "Account statement.pdf" says its period on page one; a file
downloaded weeks later has a misleading created time. For candidates the
title rule could not date, this reads the file through the existing fenced
``read_file_content`` operation (the same exact-ID read the request flow
already uses), takes dates only from the first lines of text, and decides the
period with the shared title rule. Text is discarded immediately: it is never
stored, returned or logged. Any failure leaves the candidate on its
created/modified decision (the product rule). No model is called.

The caller supplies the authority: run it only where the request flow may
read candidate contents, pass the request's ``require_current`` fence, and
treat the result as evidence for the period rule, never as a share grant.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from hushh_mcp.services.drive_owner_metadata_index import MetadataCandidate
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.drive_title_dates import (
    PeriodDecision,
    RawTitleDates,
    parse_title_dates,
    period_decision,
)
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError

logger = drive_logger("drive_content_dates")

HEADER_CHARS = 2048
HEADER_READINGS = 2
READ_TIMEOUT_SECONDS = 18
DEFAULT_CONCURRENCY = 3
DEFAULT_MAX_FILES = 24
DEFAULT_DEADLINE_SECONDS = 30
CONTENT_DATE_TYPES = frozenset(
    {
        "application/vnd.google-apps.document",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
        "text/markdown",
    }
)


def header_dates(text: str) -> RawTitleDates:
    """Dates on the first dated line of a document's opening text.

    A header ("Statement period: 1 Sep 2026 - 30 Sep 2026", "Sep 2, 2026 |
    Weekly sync") names the document's own date or range; later lines (a due
    date, history, quoted mail) do not, so only the first dated line counts.
    """
    for line in text[:HEADER_CHARS].splitlines():
        readings = parse_title_dates(line)
        if readings:
            return readings[:HEADER_READINGS]
    return ()


def content_period_decision(
    text: str, file: dict, period: dict | None, *, precedence: bool = True
) -> PeriodDecision:
    """Header dates decide like a title date; without one, file times decide."""
    decision = period_decision(
        {
            "name": "",
            "created_time": file.get("createdTime"),
            "modified_time": file.get("modifiedTime"),
        },
        period,
        precedence=precedence,
        raw=header_dates(text),
    )
    if decision.basis == "title":
        return PeriodDecision(decision.in_period, decision.listing_day, "content")
    return decision


async def check_content_dates(
    owner_id: str,
    candidates: Sequence[MetadataCandidate],
    period: dict | None,
    *,
    require_current: Callable[[], Awaitable[object]],
    transport: Any = None,
    read_text: Callable[[str], Awaitable[str | None]] | None = None,
    precedence: bool = True,
    concurrency: int = DEFAULT_CONCURRENCY,
    max_files: int = DEFAULT_MAX_FILES,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
) -> dict[str, PeriodDecision]:
    """Re-decide undated document candidates from their header dates.

    Returns ``{file_id: PeriodDecision}`` only for files actually read; any
    file missing from the result keeps its metadata decision. A fence failure
    from ``require_current`` stops the whole check and propagates.
    """
    if not 1 <= concurrency <= 6 or not 1 <= max_files <= 100:
        raise DriveReadError("invalid_argument")
    chosen = [
        candidate.file
        for candidate in candidates
        if candidate.date_basis != "title"
        and candidate.file.get("mimeType") in CONTENT_DATE_TYPES
        and isinstance(candidate.file.get("id"), str)
        and FILE_ID.fullmatch(candidate.file["id"])
    ][:max_files]
    if read_text is None:
        if transport is None:
            from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

            transport = GoogleDriveRestTransport()

        async def read_text(file_id: str) -> str | None:
            result = await asyncio.wait_for(
                transport.read_tool(
                    user_id=owner_id,
                    tool_name="read_file_content",
                    arguments={"fileId": file_id},
                ),
                timeout=READ_TIMEOUT_SECONDS,
            )
            payload = result.payload if not result.is_error else None
            body = payload.get("fileContent") if isinstance(payload, dict) else None
            return body[:HEADER_CHARS] if isinstance(body, str) else None

    decisions: dict[str, PeriodDecision] = {}
    counts = {"read": 0, "content": 0, "fallback": 0, "failed": 0}
    semaphore = asyncio.Semaphore(concurrency)
    started = time.perf_counter()
    halted = [False]

    async def fenced() -> None:
        try:
            await require_current()
        except BaseException:
            # Tasks already runnable must not start a read before the group
            # cancels them, so the first failed fence halts every task.
            halted[0] = True
            raise

    async def one(file: dict) -> None:
        async with semaphore:
            if halted[0]:
                return
            await fenced()
            try:
                text = await read_text(file["id"])
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - an unreadable file keeps its metadata date
                text = None
            # Revoked access between the read and this point discards the text.
            await fenced()
            if not text:
                counts["failed"] += 1
                return
            counts["read"] += 1
            decision = content_period_decision(text, file, period, precedence=precedence)
            del text
            counts["content" if decision.basis == "content" else "fallback"] += 1
            decisions[file["id"]] = decision

    outcome = "ok"
    try:
        async with asyncio.timeout(deadline_seconds):
            # A failed fence cancels every outstanding read, not just its own.
            async with asyncio.TaskGroup() as group:
                for file in chosen:
                    group.create_task(one(file))
    except TimeoutError:
        outcome = "deadline"
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except BaseExceptionGroup as failure:
        outcome = "fenced"
        raise failure.exceptions[0] from None
    finally:
        logger.info(
            "drive_content_dates.check outcome=%s candidates=%d read=%d content=%d "
            "fallback=%d failed=%d duration_ms=%.1f",
            outcome,
            len(chosen),
            counts["read"],
            counts["content"],
            counts["fallback"],
            counts["failed"],
            (time.perf_counter() - started) * 1000,
        )
    return decisions


__all__ = [
    "CONTENT_DATE_TYPES",
    "check_content_dates",
    "content_period_decision",
    "header_dates",
]
