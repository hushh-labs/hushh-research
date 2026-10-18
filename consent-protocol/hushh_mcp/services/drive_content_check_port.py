"""Seam between request search and the request-time content check.

Google's own content search (Gear 2, ``fullText contains``) cannot see every
file: big files (Drive indexes about 1 MB of text; most types over 10 MB,
XLSX over 20 MB and PDFs over 30 MB are not searchable), PDFs over 80 pages
(OCR stops there), images and scans, files changed in the last day (not yet
indexed), files with non-Latin titles, and files reachable only through a
shared folder (outside the ``user`` corpus). For those candidates the search
can ask this port to read the content itself, inside the request's slice.

The answer is discovery evidence only. A content match never authorises an
automatic share: matched files are *possible matches* the owner sends with
one tap (decision D3). Autoshare authority stays title evidence of the typed
words in the picked period, unchanged.

Privacy contract: text is read in a disposable child process and discarded
there; only matched concept indices, header dates and counts come back.
Nothing readable is stored (no new table, no plaintext index); the caller
keeps ``ContentCheckOutcome.checkpoint`` and the per-file results inside its
existing encrypted search checkpoint. Logs carry fixed codes and counts.

Kill switch: the check runs only in the Drive worker deployment
(``DRIVE_WORKER_MODE=true``) while drains are enabled
(``DRIVE_WORK_DRAIN_ENABLED=true``) and only when
``DRIVE_REQUEST_CONTENT_CHECK_ENABLED=true`` is set explicitly. Unset means
off in every environment, UAT included: the check parses files other people
put in folders shared with the owner, and the parser-child hardening the
research made a precondition (P1-11: no network, no_new_privs, seccomp, a
non-dumpable worker) has not landed. Turn it on only after that ships. The
API process always gets the no-op. No Gemini, Vertex or any model is called
on this path.

Integrator contract::

    check = default_content_check()          # NoContentCheck unless enabled
    groups, requirements = brain_concept_groups(brain)
    outcome = await check.check_files(
        owner_id=job["user_id"],
        candidates=rows,                     # Drive REST rows (Gear 1/Gear 2/walk); add
                                             # "size" when known and "source": "walk"
                                             # for files reached only through the walk
        concepts=groups,                     # OR-spelling lists, one per concept
        requirements=requirements,           # alternatives of AND-ed group indices
        period=checkpoint.get("requested_period"),
        connection_generation=job["connection_generation"],
        require_current=fence,               # the job fence, run around every read
        checkpoint=checkpoint.get("content_check"),
        precedence=True,                     # autoshare date rule for header dates
    )
    checkpoint["content_check"] = outcome.checkpoint   # encrypted with the job
    possible = [r for r in outcome.results if r.possible_match]
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

CONTENT_CHECK_FLAG = "DRIVE_REQUEST_CONTENT_CHECK_ENABLED"
CHECKPOINT_VERSION = 1
EVIDENCE_KIND = "content"

# Why a candidate is read locally. Counts by reason feed the coverage manifest.
REASON_OVER_INDEX_SIZE = "over_index_size"
REASON_PDF_LIKELY_LONG = "pdf_likely_long"
REASON_IMAGE = "image_or_scan"
REASON_FRESH = "fresh_upload"
REASON_NON_LATIN_TITLE = "non_latin_title"
REASON_SHARED_FOLDER_ONLY = "shared_folder_only"
SELECTION_REASONS = (
    REASON_OVER_INDEX_SIZE,
    REASON_PDF_LIKELY_LONG,
    REASON_IMAGE,
    REASON_FRESH,
    REASON_NON_LATIN_TITLE,
    REASON_SHARED_FOLDER_ONLY,
)

# Per-file outcomes.
STATUS_CHECKED = "checked"  # read; matched/dates are meaningful
STATUS_TOO_LARGE = "too_large"  # over what the fenced read may download
STATUS_UNREADABLE = "unreadable"  # damaged, locked, unsupported or no text
STATUS_UNAVAILABLE = "unavailable"  # cannot be downloaded, gone, Gen AI off, CSE
STATUS_UNSAFE = "unsafe"  # the malware scan flagged it; never read
STATUS_DEFERRED = "deferred"  # transient failure; retried by a later slice
FINAL_STATUSES = frozenset(
    {STATUS_CHECKED, STATUS_TOO_LARGE, STATUS_UNREADABLE, STATUS_UNAVAILABLE, STATUS_UNSAFE}
)


@dataclass(frozen=True)
class ContentCheckBudget:
    """Bounds for one request (across slices) and for one slice.

    ``max_file_bytes`` can never exceed the fenced read's 32 MiB download cap;
    larger files are reported ``too_large``, never partially read.
    """

    max_files: int = 100  # files read per request, across slices
    max_bytes: int = 500 * 1024 * 1024  # bytes downloaded per request, across slices
    max_file_bytes: int = 32 * 1024 * 1024
    slice_seconds: float = 60.0  # wall clock one call may spend
    max_files_per_slice: int = 24
    max_text_pages: int = 50  # pages of text read per file (from page 1)
    max_ocr_pages: int = 3  # pages OCRed per file (from page 1)
    max_ocr_pages_per_slice: int = 12  # OCR is the CPU-heavy part: bound it per slice
    concurrency: int = 2
    max_attempts: int = 2  # transient failures per file before it is final
    fresh_hours: int = 24

    def validate(self) -> None:
        if not (
            1 <= self.max_files <= 500
            and 1 <= self.max_bytes <= 4 * 1024 * 1024 * 1024
            and 1 <= self.max_file_bytes <= 32 * 1024 * 1024
            and 1 <= self.slice_seconds <= 170
            and 1 <= self.max_files_per_slice <= 100
            and 1 <= self.max_text_pages <= 200
            and 0 <= self.max_ocr_pages <= 8
            and 0 <= self.max_ocr_pages_per_slice <= 64
            and 1 <= self.concurrency <= 4
            and 1 <= self.max_attempts <= 5
            and 1 <= self.fresh_hours <= 24 * 7
        ):
            raise ValueError("invalid content check budget")


DEFAULT_BUDGET = ContentCheckBudget()


@dataclass(frozen=True)
class ContentFileResult:
    """What the content check learned about one candidate. Never its text.

    ``matched_concepts`` and the file ID are private request data: keep them
    in the encrypted checkpoint only, never in logs or B's views.
    """

    file_id: str = field(repr=False)
    status: str
    reasons: tuple[str, ...]
    matched: tuple[int, ...] = field(default=(), repr=False)
    matched_concepts: tuple[str, ...] = field(default=(), repr=False)
    requirement_met: bool = False
    date_found: str | None = None  # ISO day the header names (content basis)
    date_basis: str | None = None  # content | created | modified | none
    in_period: bool | None = None
    pages_read: int = 0
    total_pages: int | None = None
    ocr_pages: int = 0
    complete: bool = False
    error_code: str | None = None
    evidence_kind: str = EVIDENCE_KIND

    @property
    def possible_match(self) -> bool:
        """Owner-reviewed list only; content evidence never autoshares."""
        return (
            self.status == STATUS_CHECKED and self.requirement_met and self.in_period is not False
        )

    def as_checkpoint(self) -> dict:
        return {
            "id": self.file_id,
            "status": self.status,
            "reasons": list(self.reasons),
            "matched": list(self.matched),
            "requirementMet": self.requirement_met,
            "dateFound": self.date_found,
            "dateBasis": self.date_basis,
            "inPeriod": self.in_period,
            "pagesRead": self.pages_read,
            "totalPages": self.total_pages,
            "ocrPages": self.ocr_pages,
            "complete": self.complete,
            "errorCode": self.error_code,
        }


@dataclass(frozen=True)
class ContentCheckOutcome:
    """Every result so far (this slice and earlier ones) and the next checkpoint."""

    status: str  # disabled | complete | partial | budget_exhausted | not_needed
    results: tuple[ContentFileResult, ...] = field(default=(), repr=False)
    checkpoint: dict | None = field(default=None, repr=False)
    pending: int = 0
    counts: dict = field(default_factory=dict)

    @property
    def possible_matches(self) -> tuple[ContentFileResult, ...]:
        return tuple(result for result in self.results if result.possible_match)


class ContentCheck(Protocol):
    enabled: bool

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
        now: Any = None,
    ) -> ContentCheckOutcome:
        """Read the Drive-blind candidates within budget; see module docstring."""
        ...


class NoContentCheck:
    """Off: no Drive call, no download, no child process. The previous behaviour."""

    enabled = False

    async def check_files(self, *, checkpoint: dict | None = None, **_: object):
        return ContentCheckOutcome("disabled", checkpoint=checkpoint)


def content_check_enabled() -> bool:
    """Worker-only, drain-gated, and off unless the operator sets the flag to true.

    Never on by default, in UAT either: third-party files reach native
    parsers, so the sandbox hardening (P1-11) must land before anyone opts in.
    """
    if os.getenv("DRIVE_WORKER_MODE", "").strip().lower() != "true":
        return False
    if os.getenv("DRIVE_WORK_DRAIN_ENABLED", "").strip().lower() != "true":
        return False
    return os.getenv(CONTENT_CHECK_FLAG, "").strip().lower() == "true"


def default_content_check() -> ContentCheck:
    """The single wiring point for the request-time content check."""
    if not content_check_enabled():
        return NoContentCheck()
    from hushh_mcp.services.drive_request_content_check import RequestContentCheck

    return RequestContentCheck()


def brain_concept_groups(brain) -> tuple[list[list[str]], list[list[int]]]:
    """Concept groups and requirement alternatives for a request brain.

    Groups are the topics, then every document part's concepts, then each
    standalone phrase that may appear in prose. One requirement per part:
    every topic AND every concept of that part, or every topic AND one of its
    standalone phrases.
    A listing brain (no subject words) yields no groups: nothing to match.
    Spellings are discovery variants plus title evidence spellings.
    """
    groups: list[list[str]] = []

    def add(spellings: Sequence[str]) -> int:
        groups.append(list(dict.fromkeys(str(item) for item in spellings if str(item).strip())))
        return len(groups) - 1

    topics = [add([*concept.variants, *concept.title_evidence]) for concept in brain.topics]
    requirements: list[list[int]] = []
    for part in brain.parts:
        concepts = [add([*concept.variants, *concept.title_evidence]) for concept in part.concepts]
        if concepts or topics:
            requirements.append([*topics, *concepts])
        for item in part.standalone:
            if not item.title_only:  # a joined title form ("bankstatement") is not prose
                requirements.append([*topics, add([item.phrase])])
    if not requirements and topics:
        requirements.append(topics)
    if not groups:
        return [], []
    return groups, requirements


__all__ = [
    "CHECKPOINT_VERSION",
    "CONTENT_CHECK_FLAG",
    "DEFAULT_BUDGET",
    "EVIDENCE_KIND",
    "FINAL_STATUSES",
    "SELECTION_REASONS",
    "ContentCheck",
    "ContentCheckBudget",
    "ContentCheckOutcome",
    "ContentFileResult",
    "NoContentCheck",
    "brain_concept_groups",
    "content_check_enabled",
    "default_content_check",
]
