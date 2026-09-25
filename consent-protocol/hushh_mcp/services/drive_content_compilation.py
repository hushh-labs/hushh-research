"""Owner-only, bounded Markdown compilation of original live Drive note text.

Discovery is metadata-only and follows the narrow long-range listing grammar.
The subsequent reads preserve the live reader's owner, connection, filename,
and source-version checks. No document text is sent to a model or stored here.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_reader import UNREADABLE, DriveLiveReader
from hushh_mcp.services.drive_long_range_listing import (
    LongRangeListing,
    filter_long_range_matches,
    parse_long_range_listing,
)
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError

MAX_CANDIDATES = 100
MAX_FILES = 40
MAX_PARALLEL_READS = 4
MAX_FILE_TEXT_BYTES = 128_000
MAX_TOTAL_TEXT_BYTES = 1_600_000
MAX_MARKDOWN_BYTES = 2_000_000
MAX_COMPILATION_SECONDS = 300

_FILE_FAILURES = UNREADABLE | frozenset({"source_changed", "provider_unavailable"})
_FAILURE_LABELS = {
    "encrypted_document": "Password protected",
    "file_too_large": "Too large to read",
    "unsupported_format": "Unsupported format",
    "no_extractable_text": "No extractable text",
    "source_unavailable": "No longer available to read",
    "invalid_document": "Damaged or invalid document",
    "source_changed": "Changed while reading",
    "provider_unavailable": "Drive could not read this file right now",
}


class CompilationInputError(ValueError):
    """The explicit owner query cannot be compiled by the bounded live lane."""


@dataclass(frozen=True, slots=True)
class CompilationResult:
    markdown: str
    status: str
    matched: int
    included: int
    failed: int
    truncated: bool


def _emit(callback: Callable[..., None] | None, *args: Any) -> None:
    if callback is None:
        return
    try:
        callback(*args)
    except Exception:  # noqa: BLE001 - a display callback cannot fail a private read
        return


def _zone(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _markdown_title(value: str) -> str:
    title = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"([\\`*_{}\[\]()#+.!>|~-])", r"\\\1", title)


def _fence(value: str) -> str:
    longest = max((len(match.group()) for match in re.finditer(r"~+", value)), default=0)
    return "~" * max(3, longest + 1)


def _utf8_prefix(value: str, byte_limit: int) -> str:
    if byte_limit <= 0:
        return ""
    return value.encode("utf-8")[:byte_limit].decode("utf-8", errors="ignore")


def _allocate_text_bytes(lengths: list[int]) -> list[int]:
    """Give every readable file a fair share, then reuse unused shares."""
    remaining = [min(length, MAX_FILE_TEXT_BYTES) for length in lengths]
    allocated = [0] * len(lengths)
    budget = MAX_TOTAL_TEXT_BYTES
    active = {index for index, length in enumerate(remaining) if length}
    while active and budget:
        share = max(1, budget // len(active))
        for index in tuple(sorted(active)):
            amount = min(remaining[index], share, budget)
            allocated[index] += amount
            remaining[index] -= amount
            budget -= amount
            if not remaining[index]:
                active.remove(index)
            if not budget:
                break
    return allocated


def _render(
    *,
    spec: LongRangeListing,
    now_utc: datetime,
    timezone: str,
    matches: list[dict],
    selected: list[dict],
    read: dict[int, tuple[object, str, bool]],
    failures: dict[int, str],
    discovery_truncated: bool,
) -> CompilationResult:
    lengths = [len(read[index][1].encode("utf-8")) for index in sorted(read)]
    allowance = dict(zip(sorted(read), _allocate_text_bytes(lengths), strict=True))
    shortened = False
    lines = [
        "# Compiled Drive notes",
        "",
        f"Window: {spec.window_description(now_utc=now_utc, timezone=timezone)}",
        f"Matched title/date candidates: {len(matches)}. Checked: {len(selected)}. "
        f"Included: {len(read)}. Could not read: {len(failures)}.",
        "This is a bounded Drive title/date search, not proof that no other notes exist.",
    ]
    if spec.requested_count is not None and len(matches) < spec.requested_count:
        lines.append(
            f"You asked for {spec.requested_count}; only {len(matches)} candidates matched."
        )
    if discovery_truncated or len(matches) > len(selected):
        lines.append("More matching files may exist or were outside this compilation's file limit.")
    lines.extend(["", "## Notes", ""])

    for index, match in enumerate(selected):
        title = _markdown_title(match["name"])
        day = str(match["listing_day"])
        file_id = match.get("file_id")
        if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
            raise DriveReadError("provider_response_invalid")
        # A canonical URL keeps the exact file identity and prevents provider
        # supplied query characters from altering the Markdown link target.
        open_url = f"https://drive.google.com/open?id={file_id}"
        lines.extend(
            [
                f"### {day} — {title}",
                f"[Open original in Drive]({open_url})",
                "",
            ]
        )
        if index in failures:
            lines.extend([f"Content unavailable: {_FAILURE_LABELS[failures[index]]}.", ""])
            continue
        _, body, source_truncated = read[index]
        text = _utf8_prefix(body, allowance[index])
        if source_truncated:
            shortened = True
            lines.append(
                "Drive extraction supplied only part of this file; open the original for the rest."
            )
        if len(text.encode("utf-8")) < len(body.encode("utf-8")):
            shortened = True
            lines.append(
                "Content shortened by the compilation limit; open the original for the rest."
            )
        fence = _fence(text)
        lines.extend([f"{fence}text", text, fence, ""])

    status = (
        "partial"
        if failures
        or shortened
        or discovery_truncated
        or len(matches) > len(selected)
        or spec.requested_count is not None
        and len(matches) < spec.requested_count
        else "complete"
    )
    if status == "partial":
        lines.insert(2, "Coverage: partial. See missing, unreadable, or shortened files below.")
    markdown = "\n".join(lines)
    if len(markdown.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        # All provider titles and text are bounded before this point. Refuse
        # rather than silently drop a file or produce an invalid Markdown tail.
        raise DriveReadError("response_too_large")
    return CompilationResult(
        markdown=markdown,
        status=status,
        matched=len(matches),
        included=len(read),
        failed=len(failures),
        truncated=shortened or discovery_truncated or len(matches) > len(selected),
    )


class DriveContentCompilationService:
    def __init__(self, *, reader_factory=None):
        self.reader_factory = reader_factory

    async def compile(
        self,
        *,
        user_id: str,
        message: str,
        timezone: str,
        require_access,
        on_stage: Callable[[str], None] | None = None,
        on_progress: Callable[[int, int, int], None] | None = None,
    ) -> CompilationResult:
        if (
            not isinstance(message, str)
            or not message.strip()
            or len(message.encode("utf-8")) > 2048
        ):
            raise CompilationInputError("Ask for all named notes from a period of up to 31 days.")
        spec = parse_long_range_listing(message)
        if spec is None:
            raise CompilationInputError("Ask for all named notes from a period of up to 31 days.")
        await require_access()
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise PermissionError("Drive chat reads are unavailable")
        reader = (
            self.reader_factory(user_id=user_id, require_access=require_access)
            if self.reader_factory
            else DriveLiveReader(user_id=user_id, require_access=require_access)
        )
        now_utc = datetime.now(UTC)
        owner_zone = _zone(timezone)
        first, last = spec.window(now_utc=now_utc, timezone=owner_zone.key)
        start_utc = datetime.combine(first, time.min, tzinfo=owner_zone).astimezone(UTC)
        end_utc = datetime.combine(
            last + timedelta(days=1), time.min, tzinfo=owner_zone
        ).astimezone(UTC)

        async with asyncio.timeout(MAX_COMPILATION_SECONDS):
            _emit(on_stage, "searching")
            found = await reader.find(
                query=[spec.anchor],
                time_field="createdTime",
                start_time=start_utc.isoformat().replace("+00:00", "Z"),
                end_time=end_utc.isoformat().replace("+00:00", "Z"),
                max_results=MAX_CANDIDATES,
                title_only=True,
            )
            matches = filter_long_range_matches(
                spec, found["matches"], now_utc=now_utc, timezone=owner_zone.key
            )
            if not matches:
                raise CompilationInputError(
                    "No title-and-date matches were confirmed in this bounded Drive search."
                )
            selected = matches[:MAX_FILES]
            read: dict[int, tuple[object, str, bool]] = {}
            failures: dict[int, str] = {}
            settled = 0
            _emit(on_stage, "fetching")
            semaphore = asyncio.Semaphore(MAX_PARALLEL_READS)

            async def read_one(index: int, match: dict):
                async with semaphore:
                    try:
                        return index, await reader.read_compilation_match(match=match), None
                    except DriveReadError as error:
                        code = str(error)
                        if code in _FILE_FAILURES:
                            return index, None, code
                        raise

            tasks = [
                asyncio.create_task(read_one(index, match)) for index, match in enumerate(selected)
            ]
            try:
                for completed in asyncio.as_completed(tasks):
                    index, item, reason = await completed
                    if reason is None:
                        read[index] = item
                    else:
                        failures[index] = reason
                    settled += 1
                    _emit(on_progress, settled, len(selected), len(failures))
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

            # Do not release a compilation assembled over several network
            # rounds until every included source is current again. A changed
            # file is omitted with a visible partial reason, never cited stale.
            _emit(on_stage, "finalizing")

            async def verify_one(index: int, item: tuple[object, str, bool]):
                async with semaphore:
                    try:
                        await reader.require_compilation_source_current(metadata=item[0])
                        return index, None
                    except DriveReadError as error:
                        if str(error) in _FILE_FAILURES:
                            return index, str(error)
                        raise

            checks = [asyncio.create_task(verify_one(index, item)) for index, item in read.items()]
            try:
                for completed in asyncio.as_completed(checks):
                    index, reason = await completed
                    if reason is not None:
                        read.pop(index, None)
                        failures[index] = reason
            finally:
                for task in checks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*checks, return_exceptions=True)
            await require_access()
            return _render(
                spec=spec,
                now_utc=now_utc,
                timezone=owner_zone.key,
                matches=matches,
                selected=selected,
                read=read,
                failures=failures,
                discovery_truncated=found["truncated"],
            )
