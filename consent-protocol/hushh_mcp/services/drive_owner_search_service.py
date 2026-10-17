"""Checkpointed Drive REST metadata collection under explicit per-search consent.

The planner runs once in the authenticated route. This service freezes that
plan; background work never invokes a model, reads contents, or grants access.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import time
from calendar import monthrange
from contextlib import nullcontext
from contextvars import ContextVar
from datetime import UTC, date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_content_check_port import (
    ContentCheckBudget,
    brain_concept_groups,
    default_content_check,
)
from hushh_mcp.services.drive_file_routing import content_route
from hushh_mcp.services.drive_live_reader import MIME_CLAUSES, DriveLiveReader, _open_url
from hushh_mcp.services.drive_long_range_listing import _term_pattern
from hushh_mcp.services.drive_match_evidence import (
    CONTENT,
    CORRECTED,
    SYNONYM,
    WALK,
    possible_match_fields,
)
from hushh_mcp.services.drive_owner_allowed import autoshare_enabled
from hushh_mcp.services.drive_owner_index_port import MAX_LOCAL_CANDIDATES, default_owner_index
from hushh_mcp.services.drive_owner_search_store import (
    DriveOwnerSearchStore,
    _legacy_single_query,
    release_detail,
    validate_reusable_packet,
)
from hushh_mcp.services.drive_request_review_policy import (
    AUTOSHARE_SELECTION_POLICY,
    autoshare_selection,
)
from hushh_mcp.services.drive_search_paging_config import (
    FILE_LIST_PAGE_SIZE_MAX,
    OWNER_SEARCH_PAGE_SIZE_MAX,
)
from hushh_mcp.services.drive_sharing_contract import request_requires_explicit_dates
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation, drive_stage
from hushh_mcp.services.drive_text_tokens import (
    NOT_AFTER_WORD,
    NOT_BEFORE_WORD,
    ascii_digits,
    code_like,
    is_word,
    normalize,
    separated_words,
    words,
)
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import (
    FILE_ID,
    LIVE_SUPPORTED_TYPES,
    RESOURCE_KEY,
    DriveReadError,
)
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

PAGE_SIZE = 25
FILE_LIST_PAGE_SIZE = FILE_LIST_PAGE_SIZE_MAX
V1_FILE_LIST_PAGE_SIZE = OWNER_SEARCH_PAGE_SIZE_MAX
MAX_SLICE_PAGES = 4
SLICE_SECONDS = 90
# A slice starts another page only with this much of its budget left, so it
# ends as a clean hand-off rather than a timed-out (retried, backed-off) page.
PAGE_RESERVE_SECONDS = 15
_clock = time.monotonic
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
V1_DOCUMENT_NON_DOCUMENT_MIME_PREFIXES = ("audio/", "video/")
logger = drive_logger("drive_owner_search")
# "Shared with me" is every file the owner can reach but does not own, in the
# user corpus, plus the shared-folder walk. ``sharedWithMe = true`` is only
# the "Shared with me" collection: direct shares, never files nested in a
# shared folder. A shared drive's files are not shared with the owner.
SHARED_WITH_ME_CLAUSE = "not 'me' in owners"
# Shared-folder walk (research P1-1). Google's user corpus leaves out files
# reachable only through a folder shared with the owner, and "'<id>' in
# parents" lists one level, so a bounded breadth-first walk lists those
# folders in worker slices: every folder shared with the owner and every
# folder-shortcut target, then their subfolders. Walked names feed Gear 1 and
# the same candidate checks as any Drive page; a walk cut short by its budget
# is recorded as partial coverage, never as a failed or incomplete search.
SHARED_WALK_FLAG = "DRIVE_SHARED_FOLDER_WALK_ENABLED"
MAX_WALK_FOLDERS = 200
MAX_WALK_CALLS = 50
# File shortcuts one walk page may resolve as candidates (one read each).
MAX_WALK_SHORTCUTS = 25
# Files one walk page may hand to the store: a commit holds at most 100.
# Title matches go first; the rest are counted and coverage reads partial.
MAX_WALK_PAGE_FILES = 100
WALK_PAGE_SIZES = (1000, 100, 25)
_WALK_SEEDS = {
    "seed_folders": f"sharedWithMe = true and mimeType = '{FOLDER_MIME}'",
    "seed_shortcuts": f"mimeType = '{SHORTCUT_MIME}'",
}
# Possible matches (decision D3). An autoshare search keeps a candidate that
# passes the kind, period and shareability checks but lacks title evidence,
# tagged with how it was found (drive_match_evidence). Claims never send it
# without the owner's tap. Planned only where autoshare is enabled
# (autoshare_enabled: production keeps the owner-review flow, #8180).
#
# Request-time content check (research P1-8; drive_content_check_port). After
# Drive's passes and the walk, a bounded phase reads Drive-blind candidates
# (big, long or scanned PDFs, images, fresh uploads, non-Latin titles, files
# reached only through a shared folder) in the parser child and keeps content
# hits as possible matches. Candidates come from the walk's unmatched rows and
# Gear 1's recent rows; they live in the encrypted checkpoint, bounded.
CONTENT_CHECK_PHASE = "content_check"
# Possible matches one search keeps. The owner's list shows at most 100; the
# cap keeps discovery rows from crowding the result store title matches use.
MAX_POSSIBLE_MATCHES = 200
MAX_CONTENT_CANDIDATES = 40
# Gear 1 rows scanned for Drive-blind candidates, newest change first.
CONTENT_INDEX_ROWS = 400
# Content pages one search may spend; the rest is reported as partial coverage.
MAX_CONTENT_CHECK_PAGES = 12
# One content page's wall clock, inside the 90-second slice.
CONTENT_CHECK_PAGE_SECONDS = 40
CONTENT_CHECK_BUDGET = ContentCheckBudget(
    max_files=MAX_CONTENT_CANDIDATES,
    max_bytes=256 * 1024 * 1024,
    slice_seconds=CONTENT_CHECK_PAGE_SECONDS,
    max_files_per_slice=6,
    max_ocr_pages_per_slice=6,
)
# The slice's absolute deadline (``_clock`` time), so a content page fits it.
_SLICE_DEADLINE: ContextVar[float | None] = ContextVar("drive_search_slice_deadline", default=None)
_WALK_STAGES = frozenset({*_WALK_SEEDS, "folders", "done"})
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
_MONTH_NUMBERS = {
    name: index
    for index, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1
    )
}
# Title checks see through "_" and camelCase (_title_words), so title dates
# must too: "2025_08_14", "2025.08.14" and compact "20250814" are dates. An
# unread title date falls back to file activity, which would let an
# out-of-period file into automatic sharing.
_TITLE_DATE = re.compile(
    r"(?<!\d)(\d{4})[-/._](\d{1,2})[-/._](\d{1,2})(?!\d)"
    r"|(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)"
)
# Autoshare also reads day-first and month-name title dates ("16-06-2026",
# "16/06/2026", "Jun 16, 2026", "16 June 2026"). A day-first date that could
# also be month-first counts as both, so either reading outside the period
# keeps the file out of an automatic grant.
_DAY_FIRST_TITLE_DATE = re.compile(
    r"(?<!\d)(?<!\d[-/.])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)(?![-/.]\d)"
)
_MONTH_NAME = (
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_MONTH_NAME_TITLE_DATE = re.compile(
    rf"(?<![a-z]){_MONTH_NAME}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})(?!\d)"
    rf"|(?<!\d)(\d{{1,2}})(?:st|nd|rd|th)?\s+{_MONTH_NAME}\.?,?\s+(\d{{4}})(?!\d)",
    re.I,
)
_TITLE_TIME = re.compile(
    r"[ T](?P<hour>\d{1,2}):(?P<minute>\d{2})\s*"
    r"(?P<zone>IST|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?)\b",
    re.I,
)
_YESTERDAY = re.compile(r"\byesterday(?:['’]?s)?\b", re.I)
_NOTE_TITLE = re.compile(r"\b(?:notes?|minutes)\b", re.I)
_MEETING_SUBJECT = re.compile(r"\b(?:meetings?|stand[\s-]?up|syncs?|huddles?)\b", re.I)
# A bounded discovery expansion for common meeting-note titles. These are
# candidates only; extracted content and its event date decide membership.
_MEETING_NOTE_DISCOVERY = (
    "meeting",
    "notes",
    "standup",
    "stand up",
    "stand-up",
    "sync",
    "minutes",
    "huddle",
)
# The words a Gemini note title can stand in for in an autoshare
# meeting-notes request. Any other request term must be in the title.
_MEETING_NOTE_WORDS = frozenset(
    {
        "meeting",
        "meetings",
        "note",
        "notes",
        "minutes",
        "standup",
        "standups",
        "stand up",
        "stand-up",
        "sync",
        "syncs",
        "huddle",
        "huddles",
    }
)
# A Gemini note title stands in for the generic ask only, as the request brain
# rules: "standup notes" or "sync notes" need that kind in the title, so they
# never share every in-period Gemini note.
_SPECIFIC_MEETING_KIND = re.compile(r"\b(?:stand[\s-]?ups?|syncs?|huddles?)\b", re.I)
# A deterministic plan that replaced a failed planner searches only its own
# words. A request with any other word beyond period and filler words names a
# subject or issuer that plan dropped, so its search keeps the owner's review.
_FALLBACK_PLAN_WORDS = {
    "meeting_notes": _MEETING_NOTE_WORDS | {"stand", "up"},
    "statements": frozenset({"brokerage", "broker", "statement", "statements"}),
}
_FALLBACK_FILLER_WORDS = frozenset(
    {
        *_MONTH_WORDS,
        "a",
        "all",
        "an",
        "and",
        "any",
        "between",
        "copies",
        "current",
        "daily",
        "date",
        "dates",
        "day",
        "days",
        "doc",
        "docs",
        "document",
        "documents",
        "during",
        "every",
        "file",
        "files",
        "for",
        "from",
        "in",
        "last",
        "latest",
        "me",
        "monthly",
        "month",
        "months",
        "my",
        "of",
        "on",
        "or",
        "our",
        "over",
        "past",
        "pdf",
        "pdfs",
        "please",
        "previous",
        "prior",
        "quarter",
        "quarterly",
        "quarters",
        "recent",
        "s",
        "since",
        "the",
        "this",
        "through",
        "till",
        "to",
        "until",
        "week",
        "weekly",
        "weeks",
        "year",
        "years",
        "yesterday",
        "jan",
        "january",
        "feb",
        "february",
        "mar",
        "march",
        "apr",
        "april",
        "may",
        "jun",
        "june",
        "jul",
        "july",
        "aug",
        "august",
        "sep",
        "sept",
        "september",
        "oct",
        "october",
        "nov",
        "november",
        "dec",
        "december",
    }
)
_FALLBACK_NUMBER = re.compile(r"\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\d{2}")
_SCHWAB_NAME = re.compile(r"\b(?:charles\s+)?schwab\b", re.I)


def _fallback_plan_covers_request(text: str, planner_fallback: dict | None) -> bool:
    """A failed planner's stand-in plan keeps every word the request used."""
    if planner_fallback is None:
        return True
    vocabulary = _FALLBACK_PLAN_WORDS.get(planner_fallback.get("plan"))
    if vocabulary is None or not isinstance(text, str):
        return False
    if planner_fallback.get("plan") == "statements":
        # The statement plan binds Schwab as a required entity.
        text = _SCHWAB_NAME.sub(" ", text)
    words = re.findall(r"[^\W_]+", text.casefold())
    return all(
        word in vocabulary or word in _FALLBACK_FILLER_WORDS or _FALLBACK_NUMBER.fullmatch(word)
        for word in words
    )


_TERM_COORDINATOR = re.compile(r"(?:,|and|or|&|,\s*(?:and|or|&))", re.I)
# Compound filenames hide their words from whole-word title checks:
# "MeetingNotes.pdf" and "2026_09_MeetingNotes" contain no standalone "notes".
_COMPOUND_WORD_BREAK = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def _title_words(title: str) -> str:
    """Split camelCase and underscore-joined filename words for local title checks."""
    return _COMPOUND_WORD_BREAK.sub(" ", title.replace("_", " "))


def _title_search(pattern: re.Pattern[str], title: str) -> bool:
    """A title check that also sees the words inside a compound filename."""
    return bool(pattern.search(title) or pattern.search(_title_words(title)))


_GENERIC_SUBJECT = frozenset({"note", "notes", "document", "documents", "file", "files"})


def _request_brain(checkpoint: dict):
    from hushh_mcp.services.drive_request_brain import brain_from_checkpoint

    return brain_from_checkpoint(checkpoint.get("request_brain"))


def _variant_pattern(variant: str) -> re.Pattern[str]:
    folded = normalize(variant).casefold()
    if code_like(folded) or any(mark in folded for mark in "_./") and separated_words(folded):
        # A code is its parts in order: "INV_2026_HDFC_9981" also names
        # "INV-2026-HDFC-9981.pdf" and "INV 2026 HDFC 9981", as Drive reads
        # _ - . / as spaces. A longer code ("..._99812") never matches.
        return re.compile(
            NOT_AFTER_WORD
            + r"[\s_\-./]*".join(re.escape(part) for part in words(folded))
            + NOT_BEFORE_WORD,
            re.I,
        )
    parts = [word for word in re.split(r"[\s\-]+", folded) if word]
    if len(parts) == 1 and parts[0].isascii() and parts[0].isalpha():
        return _term_pattern(parts[0])
    # "pay slip" also names "Pay slips Sep.pdf". Combining marks are word
    # characters: "बैंक" never matches inside "बैंकिंग".
    suffix = "(?:e?s)?" if parts[-1].isascii() and parts[-1].isalpha() else ""
    return re.compile(
        NOT_AFTER_WORD
        + r"[\s_\-]*".join(re.escape(word) for word in parts)
        + suffix
        + NOT_BEFORE_WORD,
        re.I,
    )


def _brain_title_has(variant: str, title: str) -> bool:
    # NFC and ASCII digits on both sides: a decomposed (macOS) title or
    # Devanagari digits spell the same words.
    title = normalize(title)
    if variant != variant.casefold():
        # A cased abbreviation ("MoM") is an ordinary word in lowercase
        # ("Mom passport.pdf"), so only its own case is title evidence.
        cased = re.compile(r"(?<![A-Za-z0-9])" + re.escape(variant) + r"s?(?![A-Za-z0-9'’])")
        return any(cased.search(form) for form in (title, title.replace("_", " ")))
    pattern = _variant_pattern(variant)
    return any(
        pattern.search(form) for form in (title, title.replace("_", " "), _title_words(title))
    )


def _concept_named(concept, title: str) -> bool:
    """Only evidence spellings count: what was typed and its exact synonyms."""
    return any(_brain_title_has(spelling, title) for spelling in concept.title_evidence)


def _brain_title_evidence(brain, title: str) -> bool:
    """Every topic, and one listed part, named in the title by an evidence spelling.

    Loose discovery clues ("salary" for payslips, "call" for meetings) and
    spelling fixes from the owner's Drive never count. A brain with no
    subject is evidence only for an explicit listing ("all files").
    """
    if not brain.topics and not brain.parts:
        return brain.listing is True
    if not all(_concept_named(concept, title) for concept in brain.topics):
        return False
    if not brain.parts:
        return True
    return any(
        part.concepts
        and all(_concept_named(concept, title) for concept in part.concepts)
        or any(_brain_title_has(item.phrase, title) for item in part.standalone)
        for part in brain.parts
    )


def _brain_discovery_named(brain, title: str) -> bool:
    """The title names the request only through discovery spellings.

    The same shape as ``_brain_title_evidence`` over every searched variant:
    spelling fixes and loose synonyms included. Discovery only: it labels a
    possible match ("Similar spelling", "Similar word") and never authorises
    a share.
    """
    if not brain.topics and not brain.parts:
        return False

    def named(concept) -> bool:
        return any(_brain_title_has(variant, title) for variant in concept.variants)

    if not all(named(concept) for concept in brain.topics):
        return False
    if not brain.parts:
        return True
    return any(
        part.concepts
        and all(named(concept) for concept in part.concepts)
        or any(_brain_title_has(item.phrase, title) for item in part.standalone)
        for part in brain.parts
    )


def _brain_cased_evidence(brain, title: str) -> bool:
    """A cased abbreviation the requester typed ("MoM") in its own case."""
    return any(
        _brain_title_has(spelling, title)
        for concept in brain.concepts
        for spelling in concept.title_evidence
        if spelling != spelling.casefold()
    )


def _brain_topic_evidence(brain, title: str) -> bool:
    """Folder discovery keeps the request's own words, as plan terms did."""
    words = [
        spelling
        for concept in brain.concepts
        for spelling in concept.title_evidence
        if spelling.casefold() not in _GENERIC_SUBJECT
    ] + [item.phrase for part in brain.parts for item in part.standalone]
    return any(_brain_title_has(word, title) for word in words)


def _other_title_days(title: str) -> list[date]:
    """Day-first and month-name title dates, read only for autoshare."""
    title = ascii_digits(title)
    days = []
    for found in _DAY_FIRST_TITLE_DATE.finditer(title):
        first, second, year = (int(part) for part in found.groups())
        for day, month in {(first, second), (second, first)}:
            try:
                days.append(date(year, month, day))
            except ValueError:
                continue
    for found in _MONTH_NAME_TITLE_DATE.finditer(title):
        month_name, day, year = found.group(1, 2, 3) if found.group(1) else found.group(5, 4, 6)
        try:
            days.append(date(int(year), _MONTH_NUMBERS[month_name[:3].casefold()], int(day)))
        except ValueError:
            continue
    return days


_SPAN_PHRASE = re.compile(
    r"\b(?P<count>\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
    r"[\s-]+(?P<unit>days?|weeks?|months?|years?)\b",
    re.I,
)
# Shortest calendar length per unit: "1 month" never conflicts with 30 days.
_SPAN_DAYS = {"day": 1, "week": 7, "month": 28, "year": 365}


def _period_conflict(text: str, period: dict | None) -> str | None:
    """Name a phrase span wider than the consented dates; never widen them.

    "3 months meeting notes" with a one-month picker still searches and
    shares only the picked dates. The owner and requester can see why.
    """
    if not period or not period.get("start") or not period.get("end"):
        return None
    picked = (date.fromisoformat(period["end"]) - date.fromisoformat(period["start"])).days + 1
    for match in _SPAN_PHRASE.finditer(text):
        count = _MONTH_WORDS.get(match["count"].lower()) or int(match["count"])
        unit = match["unit"].lower().rstrip("s")
        if count * _SPAN_DAYS[unit] > picked:
            return "request_mentions_longer_span"
    return None


def _is_meeting_note_request(text: str) -> bool:
    return bool(_NOTE_TITLE.search(text) and _MEETING_SUBJECT.search(text))


def _v1_meeting_note_plan(plan: dict, purpose: dict, *, v1_live_request: bool) -> dict:
    """Keep a meeting-notes request on content/event dates, not file activity."""
    if (
        not v1_live_request
        or plan.get("exact_title")
        or not _is_meeting_note_request(purpose.get("purpose", ""))
    ):
        return plan
    return {**plan, "time_intent": "document_coverage"}


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
    brain = _request_brain(checkpoint)
    if brain is not None:
        return _brain_topic_evidence(brain, title)
    # A generic "notes" folder is not evidence of the requested meeting topic.
    terms = [
        term
        for term in checkpoint.get("request_subject_terms", [])
        if term.casefold() not in {"note", "notes", "document", "documents", "file", "files"}
    ]
    return any(
        _title_search(
            _term_pattern(
                "standup"
                if term.casefold() in {"standup", "stand up", "stand-up"}
                else term.casefold()
            ),
            title,
        )
        for term in terms
    )


def _v1_folder_clue_matches(checkpoint: dict, title: str) -> bool:
    """A clue can discover a folder; its children still require content evaluation."""
    if checkpoint.get("v1_live_request") is not True:
        return False
    authored = checkpoint.get("authored_plan")
    clues = authored.get("discovery_clues") if isinstance(authored, dict) else None
    if not isinstance(clues, list):
        return False
    return any(
        isinstance(clue, str)
        and 1 <= len(clue) <= 50
        and _title_search(_term_pattern(clue.casefold()), title)
        for clue in clues[:12]
    )


def _trusted_subject_matches(checkpoint: dict, match: dict) -> bool:
    """Require title evidence before granting access without owner review."""
    # A shortcut alias can describe a different file. Its target is what Drive
    # grants, so only the target's own title can authorize automatic sharing.
    title = match["name"]
    exact = checkpoint.get("request_exact_title")
    if exact:
        return exact == title
    brain = _request_brain(checkpoint)
    if brain is not None:
        # Each typed word, or an exact synonym of it, in the title.
        return _brain_title_evidence(brain, title)
    terms = [
        term
        for term in checkpoint.get("request_subject_terms", [])
        if term.casefold() not in {"note", "notes", "document", "documents", "file", "files"}
    ]
    if not terms:
        return True
    matches = [
        _title_search(
            _term_pattern(
                "standup"
                if term.casefold() in {"standup", "stand up", "stand-up"}
                else term.casefold()
            ),
            title,
        )
        for term in terms
    ]
    request_text = checkpoint.get("request", {}).get("query", "")
    return any(matches) if _coordinated_alternatives(terms, request_text) else all(matches)


def _note_candidate(checkpoint: dict, match: dict, *, folder_scoped: bool) -> bool:
    if not _filename_candidate(checkpoint, match):
        return False
    owner_review = checkpoint.get("request_owner_review_required") is True
    if owner_review and (not folder_scoped or checkpoint.get("v1_live_request") is True):
        # A provider fullText hit is a candidate for the owner's exact review.
        # V1 folder children also go through content evaluation; their generic
        # filenames cannot prove or disprove the document's contents.
        return True
    if not checkpoint.get("request_notes"):
        return True
    # The compilation lane uses these same title checks: a topical folder
    # does not turn an agenda, recording, or budget into a requested note.
    from hushh_mcp.services.drive_content_compilation import _GEMINI_NOTE_TITLE, _NON_NOTE_TITLE

    name = match["name"]
    alias = match.get("shortcut_name", "")
    excluded = _title_search(_NON_NOTE_TITLE, name) or _title_search(_NON_NOTE_TITLE, alias)
    if checkpoint.get("authority_mode") == "trusted_auto" and not owner_review:
        # Google Drive fullText may match an incidental mention inside a
        # generic document. Automatic grants need positive title evidence;
        # an owner-reviewed search can still show the broader candidates.
        # "MoM" abbreviates "minutes of meeting", but only when the requester
        # typed it, and only cased: "Mom passport.pdf" is never a note.
        brain = _request_brain(checkpoint)
        mom = brain is not None and _brain_cased_evidence(brain, name)
        return not excluded and (_title_search(_NOTE_TITLE, name) or mom)
    return not excluded and (
        not folder_scoped
        or _title_search(_GEMINI_NOTE_TITLE, name)
        or _title_search(_GEMINI_NOTE_TITLE, alias)
        or _subject_matches(checkpoint, name)
        or _subject_matches(checkpoint, alias)
    )


def _filename_candidate(checkpoint: dict, match: dict) -> bool:
    if checkpoint.get("request_owner_review_required") is True:
        exact = checkpoint.get("request_exact_title")
        return not exact or exact in {match["name"], match.get("shortcut_name")}
    if checkpoint.get("authority_mode") != "trusted_auto" or _trusted_subject_matches(
        checkpoint, match
    ):
        return True
    # A Gemini meeting note names its event, not the word "meeting". For a
    # meeting-notes request its title stands in for the meeting words only:
    # every other request term (a client, a topic) must still be in it.
    from hushh_mcp.services.drive_content_compilation import _GEMINI_NOTE_TITLE

    if _request_brain(checkpoint) is not None:
        # The brain already carries "Notes by Gemini" for the generic ask
        # only; "standup notes" must not share every Gemini note.
        return False
    query = checkpoint.get("request", {}).get("query", "")
    if not (
        autoshare_selection(checkpoint)
        and not checkpoint.get("request_exact_title")
        and _is_meeting_note_request(query)
        and not _SPECIFIC_MEETING_KIND.search(query)
        and _title_search(_GEMINI_NOTE_TITLE, match["name"])
    ):
        return False
    subject = [
        term
        for term in checkpoint.get("request_subject_terms", [])
        if term.casefold() not in _MEETING_NOTE_WORDS
    ]
    return _trusted_subject_matches({**checkpoint, "request_subject_terms": subject}, match)


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


def _possible_kind(
    checkpoint: dict, match: dict, *, source: str, folder_scoped: bool
) -> str | None:
    """How a candidate without title evidence was found, when it may be listed.

    Only a search planned with possible matches keeps one (D3); None keeps
    the previous exclusion. A topical folder's generic children and a notes
    request's agenda or recording are never possible matches. The label is
    the evidence, not the gear: a walked file, then a title that names the
    request only through a spelling fix or a loose synonym, then a Gear 1 name
    found with typo or prefix tolerance, else a Drive content (fullText) hit.
    """
    if checkpoint.get("request_possible_matches") is not True or folder_scoped:
        return None
    if checkpoint.get("request_notes"):
        from hushh_mcp.services.drive_content_compilation import _NON_NOTE_TITLE

        if _title_search(_NON_NOTE_TITLE, match["name"]) or _title_search(
            _NON_NOTE_TITLE, match.get("shortcut_name") or ""
        ):
            return None
    if source == "walk":
        return WALK
    brain = _request_brain(checkpoint)
    if brain is not None and _brain_discovery_named(brain, match["name"]):
        return CORRECTED if brain.corrected else SYNONYM
    if source == "index":
        return CORRECTED
    return CONTENT


def _content_planned(checkpoint: dict) -> bool:
    state = checkpoint.get("content_phase")
    return isinstance(state, dict) and state.get("stage") == "planned"


def _content_window_start(checkpoint: dict) -> str | None:
    """The day before the picked period starts: older files are not read.

    A file last changed before the period began rarely holds that period's
    content; the content check still decides by the dates it reads.
    """
    period = checkpoint.get("requested_period")
    start = period.get("start") if isinstance(period, dict) else None
    try:
        return (date.fromisoformat(start) - timedelta(days=1)).isoformat() if start else None
    except (TypeError, ValueError):
        return None


def _content_rest_row(compact: dict) -> dict:
    """The REST shape the content check selects from (name, size, walk source)."""
    return {
        "id": compact["id"],
        "name": compact["title"],
        "mimeType": compact["mimeType"],
        "createdTime": compact.get("createdTime"),
        "modifiedTime": compact.get("modifiedTime"),
        **({"size": compact["size"]} if type(compact.get("size")) is int else {}),
        **({"source": "walk"} if compact.get("source") == "walk" else {}),
    }


def _content_candidate(checkpoint: dict, row: object, *, source: str) -> dict | None:
    """A compact Drive-blind candidate for the content phase, or None.

    Only files this request could share: the requested kind, a type the
    parser child reads, downloadable (the routing facts: not restricted and
    not client-side encrypted), canShare, not trashed, changed since the
    period began, and not already named by the request's discovery spellings
    (Gears 1 and 2 own those). A row outside a shared folder must also be
    Drive-blind: too big for Drive's index, a likely long PDF, an image, a
    fresh upload or a non-Latin title.
    """
    from hushh_mcp.services.drive_file_routing import file_size
    from hushh_mcp.services.drive_request_content_check import (
        READABLE_MIMES,
        drive_blind_reasons,
    )

    match = DriveLiveReader._match(row)
    if match is None or row.get("trashed") is True:
        return None
    mime = match["mime_type"]
    kind = checkpoint.get("request_file_kind", "any")
    if (
        mime in {FOLDER_MIME, SHORTCUT_MIME}
        or mime not in READABLE_MIMES
        or not _request_candidate_kind_matches(checkpoint, kind, mime)
        or not content_route(row).may_read_content
        or _shareability(row).get("shareable") is not True
    ):
        return None
    start = _content_window_start(checkpoint)
    changed = [value[:10] for value in (match["modified_time"], match["created_time"]) if value]
    if start is not None and (not changed or max(changed) < start):
        return None
    brain = _request_brain(checkpoint)
    if brain is None or _brain_discovery_named(brain, match["name"]):
        return None
    compact = {
        "id": match["file_id"],
        "title": match["name"],
        "mimeType": mime,
        "createdTime": match["created_time"],
        "modifiedTime": match["modified_time"],
        "capabilities": {"canShare": True},
        "source": "walk" if source == "walk" else "index",
    }
    size = file_size(row)
    if size is not None:
        compact["size"] = size
    key = row.get("resourceKey")
    if isinstance(key, str) and RESOURCE_KEY.fullmatch(key):
        compact["resourceKey"] = key
    if source != "walk" and not drive_blind_reasons(
        _content_rest_row(compact), now=datetime.now(UTC)
    ):
        return None
    return compact


def _remember_content_candidates(checkpoint: dict, rows, *, source: str) -> int:
    """Keep the newest Drive-blind candidates for the content phase, bounded.

    The pool lives in the encrypted checkpoint (MAX_CONTENT_CANDIDATES rows,
    within MAX_CHECKPOINT_BYTES). Candidates that do not fit are counted; the
    content phase then reports partial coverage.
    """
    if not _content_planned(checkpoint) or not rows:
        return 0
    state = checkpoint["content_phase"]
    pool = state.get("candidates")
    if not isinstance(pool, list):
        pool = state["candidates"] = []
    known = {item.get("id") for item in pool if isinstance(item, dict)}
    added = 0
    for row in rows:
        compact = _content_candidate(checkpoint, row, source=source)
        if compact is None or compact["id"] in known:
            continue
        known.add(compact["id"])
        pool.append(compact)
        added += 1
    if not added:
        return 0
    pool.sort(key=lambda item: item["id"])
    pool.sort(key=lambda item: item.get("modifiedTime") or "", reverse=True)
    dropped = max(0, len(pool) - MAX_CONTENT_CANDIDATES)
    del pool[MAX_CONTENT_CANDIDATES:]
    while pool and (
        len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8")) > MAX_CHECKPOINT_BYTES
    ):
        pool.pop()
        dropped += 1
    if dropped:
        _counter(checkpoint, "contentCandidatesDropped", dropped)
    return added


def _fit_content_groups(groups: list[list[str]]) -> list[list[str]]:
    """Fit the content check's bounds by dropping the last discovery spellings.

    Each group keeps its first spellings (its own words come first); the
    group count and order never change, so requirement indices stay valid.
    """
    from hushh_mcp.services.drive_request_content_check import (
        MAX_GROUPS,
        MAX_SPELLING_CHARS,
        MAX_SPELLINGS,
    )

    if len(groups) > MAX_GROUPS:
        return []
    fitted = [[item for item in group if len(item) <= MAX_SPELLING_CHARS] for group in groups]
    if any(not group for group in fitted):
        return []
    while sum(len(group) for group in fitted) > MAX_SPELLINGS:
        longest = max(fitted, key=len)
        if len(longest) == 1:
            return []
        longest.pop()
    return fitted


def _content_or_done(checkpoint: dict) -> bool:
    """After Drive's passes and the walk: the planned content phase; else done."""
    if checkpoint.get("request_origin_id") and _content_planned(checkpoint):
        _phase(checkpoint, CONTENT_CHECK_PHASE)
        return False
    return True


def _end_content(checkpoint: dict, outcome: str) -> bool:
    """Close the content phase, the search's last pass: the search is done.

    outcome: complete, partial (page cap), budget_exhausted, disabled (the
    flag is off, or this is not the drained worker), not_needed or invalid.
    Candidates and per-file results are dropped from the checkpoint; only
    counts remain. Drive-blind candidates left unread make coverage partial.
    """
    state = checkpoint.get("content_phase")
    if isinstance(state, dict):
        for key in ("candidates", "check", "committed"):
            state.pop(key, None)
        state["stage"] = "done"
    counts = checkpoint.setdefault("coverage_counts", {})
    unread = outcome in {"partial", "budget_exhausted"} or (
        outcome == "complete" and bool(counts.get("contentCandidatesDropped"))
    )
    if unread:
        counts["contentCheckIncomplete"] = True
        counts["coveragePartial"] = True
    manifest = checkpoint.get("coverage_manifest")
    if isinstance(manifest, dict):
        manifest["contentCheck"] = "partial" if unread and outcome == "complete" else outcome
    return True


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
            base.append(SHARED_WITH_ME_CLAUSE)
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
                **({"corpora": "user"} if parsed.shared_with_me else {}),
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


MAX_QUERY_CHARS = 1800
# Newest-first title pages listed before the full-text pass takes over.
HEAD_START_PAGES = 10


def _full_text_value(phrase: str) -> str:
    """A fullText literal: one bare word, else a double-quoted phrase.

    Combining marks are word characters, so a Devanagari word goes bare.
    """
    from hushh_mcp.services.google_drive_rest_transport import quote_literal

    return quote_literal(phrase if is_word(phrase) else '"' + phrase.replace('"', '\\"') + '"')


def _brain_variant_clauses(variants, keys, *, title_only, dropped) -> list[str]:
    from hushh_mcp.services.drive_request_brain import full_text_phrase
    from hushh_mcp.services.google_drive_rest_transport import quote_literal

    clauses = []
    phrases: set[str] = set()
    for key, variant in zip(keys, variants, strict=True):
        if key in dropped:
            continue
        clauses.append(f"name contains {quote_literal(variant)}")
        if title_only:
            continue
        # Drive fullText matches whole tokens only; "1:1" stays a title clue.
        # A code goes as the phrase of its parts: '"inv 2026 hdfc 9981"'.
        phrase = full_text_phrase(variant)
        if phrase is not None and phrase not in phrases:
            phrases.add(phrase)
            clauses.append(f"fullText contains {_full_text_value(phrase)}")
    return clauses


def _brain_subject(brain, *, title_only: bool, dropped: set) -> str | None:
    """Topics AND every part; a part is its concepts ANDed, or a standalone phrase."""

    def concept_clause(concept, prefix):
        keys = [(*prefix, index) for index in range(len(concept.variants))]
        clauses = _brain_variant_clauses(
            concept.variants, keys, title_only=title_only, dropped=dropped
        )
        return "(" + " or ".join(clauses) + ")"

    topics = [concept_clause(concept, ("t", index)) for index, concept in enumerate(brain.topics)]
    alternatives = []
    for number, part in enumerate(brain.parts):
        options = []
        if part.concepts:
            options.append(
                "("
                + " and ".join(
                    concept_clause(concept, ("p", number, index))
                    for index, concept in enumerate(part.concepts)
                )
                + ")"
            )
        for index, item in enumerate(part.standalone):
            options.extend(
                _brain_variant_clauses(
                    [item.phrase],
                    [("s", number, index)],
                    title_only=title_only or item.title_only,
                    dropped=dropped,
                )
            )
        if options:
            alternatives.append("(" + " or ".join(options) + ")")
    if alternatives:
        topics.append("(" + " or ".join(alternatives) + ")")
    return "(" + " and ".join(topics) + ")" if topics else None


def _brain_queries(brain, base: list[str], order: str) -> list[dict] | None:
    """Title pass first (newest first), then the full-text pass Drive cannot sort.

    Never fail a search for length: optional spellings and standalone phrases
    are dropped, least important first, until the query fits Drive's budget.
    Each concept's own word is never dropped.
    """
    droppable = sorted(
        [
            (index, ("t", number, index))
            for number, concept in enumerate(brain.topics)
            for index in range(1, len(concept.variants))
        ]
        + [
            (index, ("p", part_number, number, index))
            for part_number, part in enumerate(brain.parts)
            for number, concept in enumerate(part.concepts)
            for index in range(1, len(concept.variants))
        ]
        + [
            (2.5, ("s", part_number, index))
            for part_number, part in enumerate(brain.parts)
            for index in range(len(part.standalone))
        ],
        key=lambda item: -item[0],
    )

    def fitted(title_only: bool) -> tuple[str | None, frozenset]:
        dropped: set = set()
        for index in range(len(droppable) + 1):
            subject = _brain_subject(brain, title_only=title_only, dropped=dropped)
            if subject is None:
                return None, frozenset()
            query = " and ".join([subject, *base])
            if len(query) <= MAX_QUERY_CHARS:
                return query, frozenset(dropped)
            if index < len(droppable):
                dropped.add(droppable[index][1])
        raise DriveReadError("invalid_argument")

    title, title_dropped = fitted(True)
    if title is None:
        return None
    content, content_dropped = fitted(False)
    queries = [{"arguments": {"query": title, "orderBy": f"{order} desc"}}]
    if content != title:
        if content_dropped <= title_dropped:
            # The content pass lists every title match again, so the title
            # pass is only a newest-first head start, never a second scan.
            queries[0]["head_start_pages"] = HEAD_START_PAGES
        # Drive refuses orderBy with fullText; this pass keeps relevance order.
        queries.append({"arguments": {"query": content}})
    return queries


def compile_request_queries(
    plan: dict,
    purpose: dict,
    timezone: str,
    *,
    requested_at: datetime | None = None,
    v1_live_request: bool = False,
    brain=None,
) -> tuple[list[dict], dict | None]:
    """Broaden a requested file set before the owner reviews it.

    Search the subject without a modified-time cut. File-activity requests
    check their period against metadata; document coverage remains unverified
    until the owner reviews the exact candidates.

    brain: a deterministic RequestBrain (or its checkpoint JSON). When present,
    its concepts compile the subject: a title pass, then a content pass.
    """
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
    from hushh_mcp.services.google_drive_rest_transport import compile_search_terms, quote_literal

    plan = _v1_meeting_note_plan(plan, purpose, v1_live_request=v1_live_request)
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
    direct_originals = (
        parsed.result_limit is not None and not parsed.terms and not parsed.exact_title
    )
    financial_v1 = v1_live_request and parsed.semantic_intent in {
        "institutional_statement",
        "broad_financial_records",
    }
    meeting_notes_v1 = v1_live_request and _is_meeting_note_request(purpose.get("purpose", ""))
    kind_clause = (
        _request_kind_clause(parsed.file_kind)
        if direct_originals
        else _request_discovery_clause(parsed.file_kind)
    )
    if financial_v1 and not direct_originals:
        # A named clue can surface an unsupported document. Do not hide that
        # potential match behind the planner's MIME family before checking it.
        kind_clause = None
    if kind_clause:
        base.append(kind_clause)
    if direct_originals:
        # A generic latest-N request ranks originals by their own timestamps.
        # Alias timestamps and recursive folder discovery cannot establish
        # that order. Originals anywhere in each corpus remain searchable.
        base.extend([f"mimeType != '{FOLDER_MIME}'", f"mimeType != '{SHORTCUT_MIME}'"])
    if parsed.shared_with_me:
        base.append(SHARED_WITH_ME_CLAUSE)

    def scoped(compiled: list[dict]) -> list[dict]:
        # "Shared with me" lists the user corpus only (see SHARED_WITH_ME_CLAUSE).
        return (
            [{**query, "corpora": "user"} for query in compiled]
            if parsed.shared_with_me
            else compiled
        )

    if brain is not None and not parsed.exact_title and not v1_live_request:
        from hushh_mcp.services.drive_request_brain import RequestBrain, brain_from_checkpoint

        parsed_brain = brain if isinstance(brain, RequestBrain) else brain_from_checkpoint(brain)
        if parsed_brain is None:
            raise DriveReadError("invalid_argument")
        brain_order = (
            parsed.file_time_field
            if parsed.result_limit is not None or parsed.time_intent == "file_activity"
            else "modifiedTime"
        )
        brain_queries = _brain_queries(parsed_brain, base, brain_order)
        if brain_queries is not None:
            return scoped(brain_queries), period
    broader_subject = None
    compound_free_subject = None
    entity_subject = (
        "("
        + " or ".join(compile_search_terms([entity]) for entity in parsed.required_entities)
        + ")"
        if parsed.required_entities
        else None
    )
    if parsed.exact_title:
        subject = f"name = {quote_literal(parsed.exact_title)}"
    elif parsed.terms:
        # Variants of one concept are alternatives; distinct concepts retain
        # the planner's conjunction. Legacy plans supply one term per group.
        term_groups = parsed.search_term_groups()
        groups = [
            "("
            + " or ".join(
                compile_search_terms([variant])
                for term in group
                for variant in (
                    ("standup", "stand up", "stand-up")
                    if term.casefold() in {"standup", "stand-up", "stand up"}
                    else (term,)
                )
            )
            + ")"
            for group in term_groups
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
        # Drive's "name contains" matches word prefixes, so "MeetingNotes.pdf"
        # has no "notes" word for a conjunction to find when its body never
        # says "notes". One bounded clause, the concepts' first spellings run
        # together, finds such a compound title. Title checks still decide.
        compound = "".join(
            character for group in term_groups for character in group[0] if character.isalnum()
        )
        if joiner == " and " and 2 <= len(groups) <= 3 and 4 <= len(compound) <= 50:
            compound_free_subject = subject
            subject = f"({subject} or name contains {quote_literal(compound.casefold())})"
        if parsed.time_intent == "document_coverage" and len(groups) > 1 and joiner == " and ":
            # A Drive full-text index can omit one of several request words
            # even when the original document is relevant. Exhaust a second,
            # broader provider query after the precise one. These rows remain
            # unverified candidates: an owner reviews them, and an autoshare
            # search grants one only when its title passes _filename_candidate.
            broader_subject = "(" + " or ".join(groups) + ")"
    else:
        subject = None
    clauses = [*([subject] if subject else []), *base]
    if not clauses:
        # A broad date-only request still has a Drive boundary. Content dates
        # remain owner-reviewed; only file activity uses a metadata period.
        if period is None:
            raise DriveReadError("narrow_selection_required")
        clauses = ["trashed = false"]
    query = " and ".join(clauses)
    if len(query) > 1800 and compound_free_subject is not None:
        # The optional compound clause never costs a request its search: drop
        # it and keep the query main already accepted.
        query = " and ".join([compound_free_subject, *base])
    if len(query) > 1800:
        raise DriveReadError("invalid_argument")
    # Google warns that createdTime sorting can time out on large collections.
    # Discovery normally has no creation-order promise: date membership is
    # checked from each file's metadata below. Preserve an explicit file-time
    # intent, while using modifiedTime for generic discovery and exact titles.
    order = (
        parsed.file_time_field
        if parsed.result_limit is not None or parsed.time_intent == "file_activity"
        else "modifiedTime"
    )
    queries = [{"arguments": {"query": query, "orderBy": f"{order} desc"}}]

    def append_v1_meeting_note_sweep() -> None:
        # Native Drive can find a "Team Sync and Standup" document for a
        # meeting-notes request even when neither word is in the model plan.
        # Keep the expansion lexical and bounded; content review remains the
        # only source of a verified match.
        if not v1_live_request or parsed.exact_title or not meeting_notes_v1:
            return
        # A title sweep mirrors the owner's visible Drive result set without
        # turning every incidental body mention of "sync" into a candidate.
        # The precise first query still searches fullText, and topical folders
        # bring their generic-named children into the content evaluator.
        aliases = (
            "("
            + " or ".join(
                f"name contains {quote_literal(term)}" for term in _MEETING_NOTE_DISCOVERY
            )
            + ")"
        )
        sweep = " and ".join([*([entity_subject] if entity_subject else []), aliases, *base])
        if len(sweep) > 1800:
            raise DriveReadError("invalid_argument")
        candidate_query = {"arguments": {"query": sweep, "orderBy": f"{order} desc"}}
        if candidate_query not in queries:
            queries.append(candidate_query)

    # Put the common title aliases before broad clue pages so a sync or
    # standup file enters the first evaluation cohort as soon as possible.
    append_v1_meeting_note_sweep()

    def append_v1_structural_sweep() -> None:
        # The whole-Drive MIME sweep is reserved for financial statements,
        # whose exact issuer/period evidence may be absent from Drive text.
        # Meeting-note requests use lexical aliases plus topical folder
        # children. Sweeping every document for notes can hit the 10k-row
        # work limit before any candidate receives content evaluation.
        if not financial_v1 or parsed.exact_title:
            return
        mime_subject = (
            "("
            + " or ".join(
                f"mimeType = '{mime}'" for mime in sorted(LIVE_SUPPORTED_TYPES | {SHORTCUT_MIME})
            )
            + ")"
        )
        structural_query = " and ".join(
            [
                "trashed = false",
                mime_subject,
                *([SHARED_WITH_ME_CLAUSE] if parsed.shared_with_me else []),
            ]
        )
        if len(structural_query) > 1800:
            raise DriveReadError("invalid_argument")
        queries.append({"arguments": {"query": structural_query, "orderBy": f"{order} desc"}})

    if entity_subject:
        # The explicit-entity sweep already includes every anatomy clue. One
        # exhaustive sweep avoids N redundant broad searches for account/portfolio.
        entity_query = {
            "arguments": {
                "query": " and ".join([entity_subject, *base]),
                "orderBy": f"{order} desc",
            }
        }
        if entity_query not in queries:
            queries.append(entity_query)
        append_v1_structural_sweep()
        return scoped(queries), period
    if broader_subject is not None and not meeting_notes_v1:
        broader_query = " and ".join(
            [*([entity_subject] if entity_subject else []), broader_subject, *base]
        )
        if len(broader_query) > 1800:
            raise DriveReadError("invalid_argument")
        queries.append({"arguments": {"query": broader_query, "orderBy": f"{order} desc"}})
    # Model-authored clues broaden discovery, including content-only issuer,
    # account and anatomy terms. They never become filename inclusion rules.
    # Bounded groups keep Drive's literal query budget without dropping clues.
    clues = getattr(parsed, "discovery_clues", [])
    for offset in range(0, len(clues), 4):
        clue_subject = (
            "("
            + " or ".join(compile_search_terms([clue]) for clue in clues[offset : offset + 4])
            + ")"
        )
        clue_query = " and ".join(
            [*([entity_subject] if entity_subject else []), clue_subject, *base]
        )
        if len(clue_query) > 1800:
            raise DriveReadError("invalid_argument")
        candidate_query = {"arguments": {"query": clue_query, "orderBy": f"{order} desc"}}
        if candidate_query not in queries:
            queries.append(candidate_query)
    append_v1_structural_sweep()
    return scoped(queries), period


def _in_requested_period(match: dict, period: dict | None, *, precedence: bool = False) -> bool:
    """Title dates decide when present; otherwise the file's own timestamps.

    precedence: the autoshare rule. Only the first present date decides: the
    title dates (every one inside the period, including day-first and
    month-name dates), else created time, else modified time. Without it, any
    title date or either timestamp inside the period matches (file activity).
    """
    if period is None:
        return True
    start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
    zone = ZoneInfo(period["timezone"])
    # One ASCII digit per Unicode digit, so "२०२६-०९-१०" is read like 2026-09-10.
    match = {**match, "name": ascii_digits(match["name"])}
    title_days = []
    for match_date in _TITLE_DATE.finditer(match["name"]):
        try:
            parts = match_date.groups()
            year, month, day = (int(part) for part in (parts[:3] if parts[0] else parts[3:]))
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
    if precedence:
        title_days.extend(_other_title_days(match["name"]))
    if title_days:
        inside = [start <= day <= end for day in title_days]
        # Autoshare never grants a file with any title date outside the period.
        return all(inside) if precedence else any(inside)
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
            if precedence:
                # The created time is present and outside: modified never decides.
                return False
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


def _request_candidate_kind_matches(checkpoint: dict, kind: str, mime: str) -> bool:
    if _matches_requested_kind(kind, mime):
        return True
    # A bank statement may be a spreadsheet or an image of a paper statement.
    # The model still has to verify the document's contents before review.
    authored = checkpoint.get("authored_plan")
    meeting_notes = _is_meeting_note_request(checkpoint.get("request", {}).get("query", ""))
    return (
        checkpoint.get("v1_live_request") is True
        and kind == "document"
        and isinstance(authored, dict)
        and (
            authored.get("semantic_intent")
            in {"institutional_statement", "broad_financial_records"}
            or meeting_notes
        )
        and mime in LIVE_SUPPORTED_TYPES
    )


def _v1_unsupported_candidate(
    checkpoint: dict, kind: str, mime: str, *, mime_verified: bool = True
) -> bool:
    authored = checkpoint.get("authored_plan")
    meeting_notes = _is_meeting_note_request(checkpoint.get("request", {}).get("query", ""))
    return (
        checkpoint.get("v1_live_request") is True
        and kind in {"any", "document"}
        and isinstance(authored, dict)
        and (
            authored.get("semantic_intent")
            in {"institutional_statement", "broad_financial_records"}
            or meeting_notes
        )
        and mime not in LIVE_SUPPORTED_TYPES
        and mime not in {FOLDER_MIME, SHORTCUT_MIME}
        # A live video or audio file cannot satisfy a document request. Its
        # incidental fullText hit must not make the whole search incomplete.
        # A shortcut's targetMimeType is only a snapshot, so keep an
        # unavailable target unresolved until its current MIME is verified.
        and not (
            mime_verified
            and kind == "document"
            and mime.startswith(V1_DOCUMENT_NON_DOCUMENT_MIME_PREFIXES)
        )
    )


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
    checkpoint.pop("request_rank_scan", None)


def _rank_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if timestamp.tzinfo is not None and timestamp.utcoffset() is not None:
            return timestamp.astimezone(UTC)
    except (ValueError, OverflowError):
        pass
    return None


def _bounded_corpus_complete(checkpoint, candidates, files, *, incomplete):
    """Prove a corpus cannot add a newer result, without ignoring ties.

    Drive pagination is not a snapshot. Validate observed descending order
    across pages and preserve the existing exhaustive fallback when the
    provider cannot supply a trustworthy ordering or complete response.
    """
    if not checkpoint.get("request_direct_originals"):
        return False
    limit = checkpoint["request_result_limit"]
    field = checkpoint["request_order_field"]
    scan = checkpoint.setdefault(
        "request_rank_scan",
        {"digests": [], "valid_order": True, "incomplete": False},
    )
    scan["incomplete"] = scan["incomplete"] or incomplete
    previous = _rank_timestamp(scan.get("last_timestamp"))
    for candidate in candidates:
        timestamp = _rank_timestamp(candidate.get(field)) if isinstance(candidate, dict) else None
        if timestamp is None or previous is not None and timestamp > previous:
            scan["valid_order"] = False
        if timestamp is not None:
            previous = timestamp
            scan["last_timestamp"] = timestamp.isoformat()
    if not scan["valid_order"] or scan["incomplete"]:
        return False
    seen = set(scan["digests"])
    for file in files:
        if len(seen) >= limit:
            break
        digest = hashlib.sha256(file["id"].encode()).hexdigest()
        if digest not in seen:
            seen.add(digest)
            scan["digests"].append(digest)
            if len(seen) == limit:
                scan["cutoff_timestamp"] = file[field]
    cutoff = _rank_timestamp(scan.get("cutoff_timestamp"))
    # Exhaust every equal timestamp at the boundary so the store can apply
    # its deterministic ID tiebreak globally across user and shared drives.
    return cutoff is not None and previous is not None and previous < cutoff


def _advance_query(checkpoint):
    queries = checkpoint.get("queries", [])
    index = checkpoint.get("query_index", 0) + 1
    if index >= len(queries):
        if checkpoint.get("request_origin_id") and checkpoint.get("folder_queue"):
            _phase(checkpoint, "folder_files")
            return False
        return _walk_or_done(checkpoint)
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


def _user_corpus_only(checkpoint) -> bool:
    """The current query lists the user corpus only ("shared with me")."""
    queries = checkpoint.get("queries") or [{}]
    index = checkpoint.get("query_index", 0)
    query = queries[index] if type(index) is int and 0 <= index < len(queries) else {}
    return isinstance(query, dict) and query.get("corpora") == "user"


def shared_walk_enabled() -> bool:
    """The walk lists Drive only in the worker deployment, unless switched off.

    ``DRIVE_SHARED_FOLDER_WALK_ENABLED=false`` is the operator's kill switch:
    a planned walk stops where it stands and the search completes with
    partial coverage. The API process never walks.
    """
    return (
        os.getenv("DRIVE_WORKER_MODE", "").strip().lower() == "true"
        and os.getenv(SHARED_WALK_FLAG, "true").strip().lower() != "false"
    )


def _walk_planned() -> bool:
    """A new search plans a walk unless the operator switched walks off."""
    return os.getenv(SHARED_WALK_FLAG, "true").strip().lower() != "false"


def _walk_or_done(checkpoint) -> bool:
    """After Drive's own passes, the planned shared-folder walk, then the content
    phase; else done."""
    walk = checkpoint.get("shared_walk")
    if (
        checkpoint.get("request_origin_id")
        and isinstance(walk, dict)
        and walk.get("stage") in _WALK_STAGES - {"done"}
    ):
        _phase(checkpoint, "shared_walk")
        return False
    return _content_or_done(checkpoint)


def _walked_title_match(checkpoint, row) -> bool:
    """A walked row whose own title names the request (a shortcut's target is unknown)."""
    title = row.get("title") if isinstance(row, dict) else None
    return bool(
        isinstance(title, str)
        and title
        and row.get("mimeType") != SHORTCUT_MIME
        and _trusted_subject_matches(checkpoint, {"name": title})
    )


def _finish_walk(checkpoint, outcome: str) -> bool:
    """Close the walk (see ``_end_walk``), then the planned content phase, if any."""
    return _end_walk(checkpoint, outcome) and _content_or_done(checkpoint)


def _walk_digest(identity: str) -> str:
    # 64 bits: a collision among 200 folders only skips one folder.
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def _walk_partial(checkpoint, reason: str) -> None:
    counts = checkpoint.setdefault("coverage_counts", {})
    counts["coveragePartial"] = True
    if reason == "limit":
        counts["sharedFolderWalkLimitReached"] = True
    elif reason == "incomplete":
        counts["sharedFolderWalkIncomplete"] = True


def _walk_enqueue(checkpoint, identity, key, drive) -> None:
    """Queue one folder once: a visited set guards shortcut cycles and repeats."""
    walk = checkpoint["shared_walk"]
    counts = checkpoint.setdefault("coverage_counts", {})
    if (
        not isinstance(identity, str)
        or not FILE_ID.fullmatch(identity)
        or key is not None
        and (not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key))
        or drive is not None
        and (not isinstance(drive, str) or not FILE_ID.fullmatch(drive))
    ):
        _walk_partial(checkpoint, "incomplete")
        return
    digest = _walk_digest(identity)
    full = hashlib.sha256(identity.encode()).hexdigest()
    # A topical folder Drive's pass already listed (folder_files) is not
    # listed twice; nor is a folder this walk has already queued.
    if digest in walk["visited"] or full in checkpoint.get("folder_digests", ()):
        counts["sharedFolderWalkRepeats"] = counts.get("sharedFolderWalkRepeats", 0) + 1
        return
    if len(walk["visited"]) >= MAX_WALK_FOLDERS:
        counts["sharedFolderWalkSkipped"] = counts.get("sharedFolderWalkSkipped", 0) + 1
        _walk_partial(checkpoint, "limit")
        return
    walk["visited"].append(digest)
    walk["queue"].append([identity, key, drive])


def _end_walk(checkpoint, outcome: str) -> bool:
    """Close the walk; the walk is the search's last pass, so the search is done.

    outcome: complete, partial (budget), stopped (kill switch) or invalid.
    """
    walk = checkpoint.get("shared_walk")
    if isinstance(walk, dict):
        walk.update(stage="done", queue=[], visited=[], token=None, tokens=[])
    counts = checkpoint.setdefault("coverage_counts", {})
    if outcome == "partial":
        _walk_partial(checkpoint, "limit")
    elif outcome != "complete":
        _walk_partial(checkpoint, outcome)
    partial = bool(
        counts.get("sharedFolderWalkLimitReached") or counts.get("sharedFolderWalkIncomplete")
    )
    if partial:
        counts["coveragePartial"] = True
    manifest = checkpoint.get("coverage_manifest")
    if isinstance(manifest, dict):
        manifest["sharedFolderWalk"] = (
            outcome if outcome != "complete" else "partial" if partial else "complete"
        )
    return True


def _walk_token(payload, walk):
    token = payload.get("nextPageToken")
    if token is not None and (not isinstance(token, str) or len(token) > 1024):
        raise DriveReadError("provider_response_invalid")
    if not token:
        return None
    digest = hashlib.sha256(token.encode()).hexdigest()[:16]
    seen = walk.setdefault("tokens", [])
    if token == walk.get("token") or digest in seen or len(seen) > MAX_WALK_CALLS:
        raise DriveReadError("provider_response_invalid")
    seen.append(digest)
    return token


def _brain_groups(brain) -> list[list[list[str]]]:
    """One name lookup per AND group, as the Drive pass compiles them.

    Topics with each document part, and topics with each standalone phrase.
    """
    topics = [list(concept.variants) for concept in brain.topics]
    groups = []
    for part in brain.parts or (None,):
        groups.append(
            topics + [list(concept.variants) for concept in (part.concepts if part else ())]
        )
        groups.extend(topics + [[item.phrase]] for item in (part.standalone if part else ()))
    return [group for group in groups if group]


def _walk_groups(checkpoint) -> list[list[list[str]]]:
    """The request's concepts for matching walked names (Gear 1's matcher)."""
    exact = checkpoint.get("request_exact_title")
    if isinstance(exact, str) and exact:
        return [[[exact]]]
    brain = _request_brain(checkpoint)
    if brain is not None:
        return _brain_groups(brain) if brain.concepts else []
    terms = [
        term
        for term in checkpoint.get("request_subject_terms") or []
        if isinstance(term, str) and term.casefold() not in _GENERIC_SUBJECT
    ]
    if not terms:
        return []
    if _coordinated_alternatives(terms, checkpoint.get("request", {}).get("query", "")):
        return [[[term]] for term in terms]
    return [[[term] for term in terms]]


class DriveOwnerSearchService:
    def __init__(
        self,
        store=None,
        transport=None,
        sharing=None,
        *,
        facts=None,
        packets=None,
        packet_matcher=None,
        packet_checker=None,
        owner_index=None,
        content_check=None,
    ):
        self.store = store or DriveOwnerSearchStore()
        self.transport = transport or GoogleDriveRestTransport()
        self.sharing = sharing
        self.facts = facts
        self.packets = packets
        self.packet_matcher = packet_matcher
        self.packet_checker = packet_checker
        # Gear 1: the owner's local metadata index. The default is a no-op.
        self.owner_index = owner_index or default_owner_index()
        # The request-time content check; None resolves the flag-gated
        # default (a no-op outside the drained worker) at each phase page.
        self.content_check = content_check

    def _facts_store(self):
        if self.facts is None:
            from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore

            self.facts = DriveDocumentFactsStore(db=self.store.db)
        return self.facts

    def _packet_store(self):
        if self.packets is None:
            from hushh_mcp.services.drive_packet_store import DrivePacketStore

            self.packets = DrivePacketStore(db=self.store.db)
        return self.packets

    async def request_evidence_route(self, *, user_id, reusable_packet=None, request=None):
        if reusable_packet is not None:
            manifest = await self._packet_store().current_packet_manifest(
                owner_user_id=user_id,
                packet_id=reusable_packet["packetId"],
                version=reusable_packet["version"],
            )
            validate_reusable_packet(manifest, reusable_packet, user_id)
            return {"kind": "packet", "reusable_packet": reusable_packet}
        try:
            status = await self._facts_store().current_index_status(owner_user_id=user_id)
        except DriveReadError as error:
            if str(error) not in {
                "collection_processing_required",
                "background_preparation_required",
                "connector_unavailable",
            }:
                raise
            return {"kind": "provider", "fallback_reason": "collection_not_enabled"}
        if status["complete"]:
            if request is not None:
                matched = await self._match_canonical_packet(user_id=user_id, request=request)
                if matched is not None:
                    return {**matched, "index_snapshot": status}
            return {"kind": "index", "index_snapshot": status}
        return {
            "kind": "hybrid" if status.get("indexed", 0) else "provider",
            "fallback_reason": "index_incomplete",
            "index_snapshot": status,
        }

    async def _match_canonical_packet(self, *, user_id, request):
        from hushh_mcp.services.drive_packet_intelligence import match_request_packet

        matcher = self.packet_matcher or match_request_packet
        cursor, candidates, manifests = None, [], {}
        source_facts = {}
        # Bound both request latency and model context. If the catalogue exceeds
        # this window, use the full paged index; never pick the first match.
        for _ in range(2):
            page = await self._packet_store().list_packets(user_id=user_id, cursor=cursor, limit=25)
            for item in page["packets"]:
                if (
                    item["state"] != "ready"
                    or item["freshness"] != "current"
                    or not 0 < item["documentCount"] <= 120
                ):
                    continue
                try:
                    manifest = await self._packet_store().current_packet_manifest(
                        owner_user_id=user_id, packet_id=item["packetId"], version=item["version"]
                    )
                except DriveReadError as error:
                    if str(error) == "packet_unavailable":
                        continue
                    raise
                identities = []
                for source in manifest["sources"]:
                    identity = tuple(
                        source[key] for key in ("document_id", "source_version", "facts_version")
                    )
                    if identity not in source_facts:
                        if len(source_facts) == 120:
                            return None
                        document = await self._facts_store().current_document(
                            owner_user_id=user_id,
                            **{
                                key: source[key]
                                for key in ("document_id", "source_version", "facts_version")
                            },
                        )
                        facts = document["facts"]
                        source_facts[identity] = {
                            "document_id": source["document_id"],
                            "source_version": source["source_version"],
                            "facts_version": source["facts_version"],
                            "evidence_complete": document["complete"],
                            **{
                                key: facts[key]["value"] if facts.get(key) else None
                                for key in ("document_type", "issuer", "subject", "account")
                            },
                            "content_periods": [
                                {"start": item["start"], "end": item["end"]}
                                for item in facts["periods"]
                            ],
                            "date_evidence": [
                                {key: item[key] for key in ("role", "start", "end", "meaning")}
                                for item in facts.get("date_evidence", [])
                            ],
                            "record_status": facts.get("record_status"),
                            "facts": [item["value"] for item in facts["facts"]],
                            "topics": [item["value"] for item in facts["topics"]],
                            "missing_information": facts["missing_information"],
                            "ambiguous": facts["ambiguous"],
                        }
                    identities.append(source_facts[identity])
                candidates.append(
                    {
                        "packet_id": manifest["packet_id"],
                        "version": manifest["version"],
                        "assessment": manifest["assessment"],
                        "verification": manifest["verification"],
                        "document_count": len(manifest["sources"]),
                        "current_source_facts": identities,
                    }
                )
                manifests[(manifest["packet_id"], manifest["version"])] = manifest
            cursor = page["nextCursor"]
            if cursor is None:
                break
        if (
            cursor is not None
            or not candidates
            or len(json.dumps(candidates, ensure_ascii=False).encode()) > 128 * 1024
        ):
            return None
        try:
            async with asyncio.timeout(55):
                result = await matcher(user_id=user_id, request=request, packets=candidates)
        except Exception:  # noqa: BLE001 - optional model routing never hides the full index
            logger.info("drive_search.packet_match status=unavailable")
            return None
        if result.decision != "exact":
            return None
        manifest = manifests.get((result.packet_id, result.version))
        if manifest is None:
            raise DriveReadError("provider_response_invalid")
        from hushh_mcp.services.drive_packet_intelligence import verify_packet

        checker = self.packet_checker or verify_packet
        selected = next(
            item
            for item in candidates
            if item["packet_id"] == result.packet_id and item["version"] == result.version
        )
        try:
            async with asyncio.timeout(55):
                checked = await checker(
                    user_id=user_id,
                    packet={**manifest["assessment"], "document_request": request},
                    documents=selected["current_source_facts"],
                    complete=True,
                    batch_scope="complete_current_request_packet",
                )
        except Exception:  # noqa: BLE001 - fallback still evaluates the full index
            logger.info("drive_search.packet_request_check status=unavailable")
            return None
        if checked.state != "ready":
            return None
        binding = {
            "packetId": manifest["packet_id"],
            "version": manifest["version"],
            "manifestDigest": manifest["digest"],
            "listingRevision": manifest["listing_revision"],
            "priceCents": manifest["price_cents"],
            "ownerUserId": user_id,
        }
        return {
            "kind": "packet",
            "matched_packet": binding,
            "request_packet_verification": checked.model_dump(mode="json"),
        }

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

    async def replan_legacy_statement_request(
        self,
        *,
        user_id,
        request_id,
        context,
        expected_lease=None,
    ):
        """Install the current deterministic plan on an unfrozen legacy job."""
        # Imported here because request orchestration already imports this
        # search service. The same planner is used for fresh and saved jobs.
        from hushh_mcp.services.drive_request_bulk_service import (
            _deterministic_statement_plan,
        )

        purpose = context["purpose"]
        plan = _deterministic_statement_plan(purpose)
        if plan is None or context.get("agentPackageRequired"):
            return None, False, None
        queries, period = compile_request_queries(
            plan.model_dump(mode="json"),
            purpose,
            context.get("requestTimeZone") or "UTC",
            requested_at=context.get("requestCreatedAt"),
        )
        return await self.store.replan_legacy_statement_request(
            user_id=user_id,
            request_id=request_id,
            request_revision=context["revision"],
            purpose=purpose,
            queries=queries,
            period=period,
            terms=plan.terms,
            expected_lease=expected_lease,
        )

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
        evidence_route=None,
        v1_live_request=False,
        planner_fallback=None,
        autoshare=False,
        brain=None,
        plan_source=None,
    ):
        """Start or resume the owner-approved request's durable metadata search.

        autoshare: the request's sealed automatic flow. Its trusted search
        selects every in-period match by title, created, then modified date,
        so no owner file review is required.

        brain: the deterministic request brain's checkpoint JSON. It compiles
        the Drive subject and title evidence; plan_source records which stage
        produced the plan, so a skipped model stage is always visible.
        """
        from hushh_mcp.services.drive_request_brain import brain_from_checkpoint

        parsed_brain = brain_from_checkpoint(brain) if brain is not None else None
        if (
            brain is not None
            and (parsed_brain is None or v1_live_request)
            or plan_source not in {None, "deterministic_brain", "model"}
        ):
            raise DriveReadError("invalid_argument")
        if (
            authority_mode not in {"owner", "trusted_auto", "agent_package"}
            or type(v1_live_request) is not bool
            or type(autoshare) is not bool
            or planner_fallback is not None
            and (
                not isinstance(planner_fallback, dict)
                or planner_fallback.get("reason") not in {"timeout", "invalid_plan", "model_error"}
                or planner_fallback.get("plan") not in {"statements", "meeting_notes"}
            )
        ):
            raise DriveReadError("invalid_argument")
        if v1_live_request and authority_mode != "agent_package":
            raise DriveReadError("invalid_argument")
        route = evidence_route or {"kind": "provider"}
        indexed = route["kind"] in {"index", "packet"}
        if (
            not (purpose.get("periodStart") and purpose.get("periodEnd"))
            and route["kind"] != "packet"
        ):
            raise DriveReadError("date_range_required")
        await require_current()
        query = purpose["purpose"]
        plan = _v1_meeting_note_plan(plan, purpose, v1_live_request=v1_live_request)
        request = self._request(query, timezone)
        existing = await self.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None and existing["status"] in {"queued", "running"}:
            return existing
        if indexed:
            period = {"start": purpose.get("periodStart"), "end": purpose.get("periodEnd")}
            queries = [{"arguments": {"orderBy": "modifiedTime desc"}}]
        else:
            queries, period = compile_request_queries(
                plan,
                purpose,
                timezone,
                requested_at=requested_at,
                v1_live_request=v1_live_request,
                brain=parsed_brain,
            )
        v1_statement_search = v1_live_request
        # Gear 1 runs when an owner index is wired and the brain has a subject.
        # The create-time page stays a 25-row Drive page; Gear 1 (which may
        # list the index from Drive) runs in the next worker slice, before
        # any further Drive page.
        # Gear 1 rows carry no owner, so a "shared with me" search skips them.
        local_first = bool(
            not indexed
            and parsed_brain is not None
            and parsed_brain.concepts
            and not plan.get("shared_with_me")
            and getattr(self.owner_index, "enabled", False) is True
        )
        time_intent = plan.get("time_intent", "document_coverage")
        # The brain left out a word that may name the subject or issuer
        # ("Google One receipts"). Its title evidence is broader than the
        # request, so the owner reviews, whatever the time intent.
        brain_dropped = bool(parsed_brain is not None and parsed_brain.dropped)
        # The picked dates bound an autoshare search; no period, no selection.
        autoshare_dates = bool(
            autoshare
            and authority_mode == "trusted_auto"
            and not indexed
            and period is not None
            # A stand-in for a failed planner may have dropped the request's
            # subject or issuer. Only a request it fully covers shares itself.
            and _fallback_plan_covers_request(query, planner_fallback)
            and not brain_dropped
        )
        owner_review_required = not autoshare_dates and (
            time_intent == "document_coverage" or authority_mode == "agent_package" or brain_dropped
        )
        result_limit = None if indexed else plan.get("result_limit")
        direct_originals = (
            result_limit is not None and not plan.get("terms") and not plan.get("exact_title")
        )
        order_field = queries[0]["arguments"]["orderBy"].split()[0]
        # The shared-folder walk runs after Drive's own passes for a request
        # that names a subject (a listing or a newest-N request does not walk;
        # V1 and indexed routes have their own lanes). Planned here, it runs
        # only in worker slices; a switched-off walk is partial coverage.
        walk_subject = bool(
            plan.get("exact_title")
            or (parsed_brain.concepts if parsed_brain is not None else plan.get("terms"))
        )
        # A walked file can widen what an automatic search shares (by title,
        # as any file). Production keeps the old flow until autoshare is
        # approved there (#8180): its automatic searches do not walk. An
        # owner-reviewed search may walk anywhere: the owner picks each file.
        walk_applies = bool(
            not indexed
            and not v1_live_request
            and not direct_originals
            and walk_subject
            and (owner_review_required or autoshare_enabled())
        )
        walk_state = (
            {"stage": "seed_folders", "queue": [], "visited": [], "token": None, "tokens": []}
            if walk_applies and _walk_planned()
            else None
        )
        walk_manifest = (
            "planned" if walk_state else "disabled" if walk_applies else "not_applicable"
        )
        # Possible matches and the content phase (D3, P1-8): an autoshare
        # search with a subject the brain holds it to, where autoshare is on.
        # Neither ever widens what shares itself: claims still need title
        # evidence or the owner's Send.
        possible_matches = bool(
            autoshare_dates
            and autoshare_enabled()
            and parsed_brain is not None
            and parsed_brain.concepts
            and result_limit is None
            and not plan.get("exact_title")
        )
        state, created = await self.store.create(
            user_id=user_id,
            client_request_id=request_id,
            request=request,
            confirmed=True,
            v1_statement_search=v1_statement_search,
            replace_terminal_request=True,
            replace_legacy_completed_request=True,
            checkpoint={
                "request": request,
                "arguments": queries[0]["arguments"],
                "queries": queries,
                "query_index": 0,
                "request_origin_id": request_id,
                "request_revision": request_revision,
                "evidence_route": route["kind"],
                **(
                    {
                        key: route[key]
                        for key in (
                            "reusable_packet",
                            "matched_packet",
                            "request_packet_verification",
                        )
                        if key in route
                    }
                ),
                **(
                    {"index_snapshot": route["index_snapshot"]} if "index_snapshot" in route else {}
                ),
                "index_cursor": None,
                "packet_offset": 0,
                "authority_mode": authority_mode,
                "agent_package_required": authority_mode == "agent_package",
                "v1_live_request": v1_live_request,
                **({"authored_plan": plan} if v1_live_request else {}),
                # A deterministic plan that replaced a failed planner call.
                **({"planner_fallback": planner_fallback} if planner_fallback else {}),
                **({"request_plan_source": plan_source} if plan_source else {}),
                **({"request_brain": parsed_brain.as_checkpoint()} if parsed_brain else {}),
                **({"local_offset": 0} if local_first else {}),
                **({"shared_walk": walk_state} if walk_state else {}),
                **(
                    {
                        "request_possible_matches": True,
                        "content_phase": {"stage": "planned", "candidates": []},
                    }
                    if possible_matches
                    else {}
                ),
                **({"request_shared_with_me": True} if plan.get("shared_with_me") else {}),
                "request_shareability_version": 1,
                "request_selection_version": 2,
                **(
                    {"request_selection_policy": AUTOSHARE_SELECTION_POLICY}
                    if autoshare_dates
                    else {}
                ),
                "request_coverage_query_version": 1
                if len(queries) >= 2 and time_intent == "document_coverage"
                else None,
                "request_time_intent": time_intent,
                "request_owner_review_required": owner_review_required,
                "request_file_kind": plan.get("file_kind", "any"),
                "request_subject_terms": plan.get("terms", []),
                "request_exact_title": plan.get("exact_title"),
                "request_result_limit": result_limit,
                "request_order_field": order_field,
                "request_direct_originals": direct_originals,
                "request_notes": bool(re.search(r"\b(?:notes?|minutes)\b", query, re.I)),
                "request_explicit_dates": bool(
                    purpose.get("periodStart") and purpose.get("periodEnd")
                ),
                "requested_period": period,
                "coverage_manifest": {
                    "corpora": ["user", "member_shared_drives"],
                    "retrievalSource": {
                        "index": "document_index",
                        "packet": "reusable_packet",
                        "hybrid": "index_and_google_drive",
                        "provider": "google_drive",
                    }[route["kind"]],
                    "retrievalCompleteness": "verified_index" if indexed else "provider_candidates",
                    **(
                        {"formatScope": "supported_live_formats_with_named_unsupported_flags"}
                        if v1_live_request
                        else {}
                    ),
                    "fallbackReason": route.get("fallback_reason"),
                    "lastIndexedAt": route.get("index_snapshot", {}).get("last_synced_at"),
                    "fileKind": plan.get("file_kind", "any"),
                    "requestedPeriod": period,
                    # The selected dates stay the sharing boundary either way.
                    "periodConflict": _period_conflict(query, period),
                    "timeIntent": time_intent,
                    "ownerReviewRequired": owner_review_required,
                    "dateBasis": "content_period_unverified"
                    if owner_review_required
                    else "title_date_then_created_then_modified"
                    if autoshare_dates
                    else "title_date_then_created_or_modified",
                    "contentPeriodVerified": False,
                    "folderDiscovery": "none_direct_originals"
                    if direct_originals
                    else "matching_topic_folders_and_descendants",
                    "shortcutDiscovery": "excluded" if direct_originals else "resolve_targets",
                    "resultLimit": result_limit,
                    "orderBy": f"{order_field} desc",
                    **({"planSource": plan_source} if plan_source else {}),
                    **({"localIndexFirst": True} if local_first else {}),
                    "sharedFolderWalk": walk_manifest,
                    # Owner-only: planned, then complete, partial,
                    # budget_exhausted, disabled, not_needed or invalid.
                    **(
                        {"contentCheck": "planned", "possibleMatches": True}
                        if possible_matches
                        else {}
                    ),
                    **(
                        {"sharedWithMeScope": "not_owned_user_corpus_and_walk"}
                        if plan.get("shared_with_me")
                        else {}
                    ),
                },
                "coverage_counts": {"coveragePartial": True} if walk_manifest == "disabled" else {},
                "folder_queue": [],
                "folder_digests": [],
                "phase": "index"
                if route["kind"] == "hybrid"
                else route["kind"]
                if indexed
                else "user",
                "page_token": None,
                "drive_page_token": None,
                "drives": [],
                "drive_index": 0,
                "seen_tokens": [],
                "drive_tokens": [],
            },
        )
        if not created:
            return state
        await self.store.align_request_expiry(user_id=user_id, request_id=request_id)
        await self.run_one(
            user_id=user_id,
            job_id=state["jobId"],
            max_pages=1,
            deadline_seconds=15,
            **({} if direct_originals else {"initial_page_size": PAGE_SIZE}),
            require_current=require_current,
            **({"after_page": after_page} if after_page is not None else {}),
        )
        await wake_drive_work("v1" if v1_statement_search else "suggestions")
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

    async def results(
        self, *, user_id, job_id, require_current, cursor=None, limit=25, request_id=None
    ):
        await require_current()
        result = await self.store.results(
            user_id=user_id, job_id=job_id, cursor=cursor, limit=limit, request_id=request_id
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

    async def _request_candidates(
        self, job, checkpoint, candidates, *, folder_scoped, drive_id, found_by="drive"
    ):
        """Kind, title-evidence, period and shareability checks for one page.

        found_by: "drive" (Gear 2), "index" (Gear 1) or "walk". It only labels
        a possible match; every row passes the same checks whatever found it.
        """
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
        owner_review_required = checkpoint.get("request_owner_review_required") is True
        evidence = (
            {
                "requestEvidence": {
                    "version": 1,
                    "assessment": "unverified",
                    "basis": "provider_search",
                }
            }
            if owner_review_required
            else {}
        )

        def period_matches(match):
            if owner_review_required:
                # Creation, modification and title dates do not establish the
                # period covered by a document's contents.
                return True
            if autoshare_selection(checkpoint):
                return _in_requested_period(match, period, precedence=True)
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
                    if target_kind and _v1_unsupported_candidate(
                        checkpoint, kind, target_kind, mime_verified=False
                    ):
                        incomplete = True
                        _counter(checkpoint, "unsupportedCandidateCount")
                        continue
                    if target_kind and not _request_candidate_kind_matches(
                        checkpoint, kind, target_kind
                    ):
                        _counter(checkpoint, "excludedByKindCount")
                        continue
                    if not _filename_candidate(checkpoint, match):
                        _counter(checkpoint, "excludedByFilenameCount")
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
                            **evidence,
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
                    or _v1_folder_clue_matches(checkpoint, match["name"])
                    or (
                        match.get("shortcut_name")
                        and (
                            _subject_matches(checkpoint, match["shortcut_name"])
                            or _v1_folder_clue_matches(checkpoint, match["shortcut_name"])
                        )
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
            if _v1_unsupported_candidate(checkpoint, kind, match["mime_type"]):
                incomplete = True
                _counter(checkpoint, "unsupportedCandidateCount")
                continue
            if not _request_candidate_kind_matches(checkpoint, kind, match["mime_type"]):
                _counter(checkpoint, "excludedByKindCount")
                continue
            # A candidate without title evidence is kept only as a possible
            # match (D3): tagged, listed for the owner, never auto-claimed.
            possible = None
            if not _filename_candidate(checkpoint, match):
                possible = _possible_kind(
                    checkpoint, match, source=found_by, folder_scoped=folder_scoped
                )
                if possible is None:
                    _counter(checkpoint, "excludedByFilenameCount")
                    continue
            elif not _note_candidate(checkpoint, match, folder_scoped=folder_scoped):
                possible = _possible_kind(
                    checkpoint, match, source=found_by, folder_scoped=folder_scoped
                )
                if possible is None:
                    _counter(checkpoint, "excludedByNoteTypeCount")
                    continue
            if (
                folder_scoped
                and not checkpoint.get("request_notes")
                and not checkpoint.get("v1_live_request")
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
            shareability = _shareability(source)
            if possible is not None:
                if shareability.get("shareable") is not True:
                    # The owner could not send it: excluded, as before.
                    _counter(checkpoint, "excludedByFilenameCount")
                    continue
                if (
                    checkpoint.get("coverage_counts", {}).get("possibleMatchCandidates", 0)
                    >= MAX_POSSIBLE_MATCHES
                ):
                    _counter(checkpoint, "possibleMatchesDropped")
                    continue
                # Counted before the store's dedupe (a file both passes find
                # counts twice), so the cap only ever errs on the safe side.
                _counter(checkpoint, "possibleMatchCandidates")
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
                    **shareability,
                    **evidence,
                    **(possible_match_fields(possible) if possible is not None else {}),
                }
            )
        return files, incomplete

    async def _remember_walked(self, job, rows) -> None:
        """Gear 1 learns walked names (in this process only); never fails a walk."""
        remember = getattr(self.owner_index, "remember_files", None)
        if remember is None or getattr(self.owner_index, "enabled", False) is not True:
            return
        try:
            await remember(
                owner_id=job["user_id"],
                rows=rows,
                connection_generation=job.get("generation"),
            )
        except Exception:  # noqa: BLE001 - an accelerator never fails the search
            logger.info("drive_search.walk_index status=unavailable")

    async def _walk_candidates(self, job, checkpoint, rows) -> list[dict]:
        """Walked files whose names match the request, through the usual checks.

        A walk lists every child of a folder, so its rows are matched by name
        first (Gear 1's matcher, the same AND groups as the Gear 1 lookup).
        The matches then pass the same kind, title-evidence, period and
        shareability checks as a Drive page: a walked file widens the corpus,
        never the authority to share it.
        """
        from hushh_mcp.services.drive_owner_metadata_index import build_index

        groups = _walk_groups(checkpoint)
        if not groups or not rows:
            return []
        index = build_index(rows)
        kind = checkpoint.get("request_file_kind", "any")
        owner_review = checkpoint.get("request_owner_review_required") is True
        matched: dict[str, None] = {}
        for concepts in groups:
            try:
                found, _ = index.match(
                    concepts,
                    None if owner_review else checkpoint.get("requested_period"),
                    precedence=autoshare_selection(checkpoint),
                    mime_filter=lambda mime: (
                        mime == SHORTCUT_MIME or _matches_requested_kind(kind, mime)
                    ),
                    limit=MAX_LOCAL_CANDIDATES,
                )
            except DriveReadError:
                continue
            matched.update(dict.fromkeys(candidate.file["id"] for candidate in found))
        by_id = {row["id"]: row for row in rows if isinstance(row, dict) and "id" in row}
        # A walked file whose name does not match is outside Google's user
        # corpus, so Drive's fullText never read it: a content-phase candidate.
        _remember_content_candidates(
            checkpoint,
            [row for identity, row in by_id.items() if identity not in matched],
            source="walk",
        )
        picked = [by_id[identity] for identity in matched if identity in by_id]
        shortcuts = [row for row in picked if row.get("mimeType") == SHORTCUT_MIME]
        if len(shortcuts) > MAX_WALK_SHORTCUTS:
            # Each shortcut costs a target read; the rest are reported, not read.
            deferred = {row["id"] for row in shortcuts[MAX_WALK_SHORTCUTS:]}
            picked = [row for row in picked if row["id"] not in deferred]
            _counter(checkpoint, "sharedFolderWalkShortcutsDeferred", len(deferred))
            _walk_partial(checkpoint, "limit")
        if len(picked) > MAX_WALK_PAGE_FILES:
            # One walk page lists up to 1000 rows, but one commit holds 100
            # files: a larger hand-off would fail the whole search. Title
            # matches first (stable), the rest reported as partial coverage.
            picked.sort(key=lambda row: not _walked_title_match(checkpoint, row))
            _counter(checkpoint, "sharedFolderWalkSkipped", len(picked) - MAX_WALK_PAGE_FILES)
            _walk_partial(checkpoint, "limit")
            del picked[MAX_WALK_PAGE_FILES:]
        if not picked:
            return []
        files, _ = await self._request_candidates(
            job, checkpoint, picked, folder_scoped=False, drive_id=None, found_by="walk"
        )
        _counter(checkpoint, "sharedFolderWalkCandidates", len(files))
        return files

    async def _shared_walk_page(self, job, checkpoint):
        """One bounded call of the shared-folder walk (see SHARED_WALK_FLAG).

        Seeds first (folders shared with the owner, then the owner's folder
        shortcuts), then one folder level per call, breadth first. The queue,
        the visited digests and the cursor live in the encrypted checkpoint,
        so every slice resumes where the last one stopped. Budget: at most
        MAX_WALK_FOLDERS folders and MAX_WALK_CALLS list calls per walk.
        """
        walk = checkpoint.get("shared_walk")
        counts = checkpoint.setdefault("coverage_counts", {})
        if (
            not isinstance(walk, dict)
            or walk.get("stage") not in _WALK_STAGES - {"done"}
            or not isinstance(walk.get("queue"), list)
            or not isinstance(walk.get("visited"), list)
        ):
            return checkpoint, [], False, _finish_walk(checkpoint, "invalid")
        if not shared_walk_enabled():
            # The operator's switch (or a process that is not the worker)
            # stops the walk where it stands; nothing else changes.
            return checkpoint, [], False, _finish_walk(checkpoint, "stopped")
        stage = walk["stage"]
        if stage == "folders" and not walk["queue"]:
            return checkpoint, [], False, _finish_walk(checkpoint, "complete")
        if counts.get("sharedFolderWalkCalls", 0) >= MAX_WALK_CALLS:
            return checkpoint, [], False, _finish_walk(checkpoint, "partial")
        listing_read = getattr(self.transport, "read_owner_search_page", None)
        page_size = walk.get("page_size")
        if page_size not in WALK_PAGE_SIZES:
            page_size = WALK_PAGE_SIZES[0]
        if listing_read is None:
            # Older injected transports keep the agent-facing 25-row page.
            listing_read = self.transport.read_tool
            page_size = WALK_PAGE_SIZES[-1]
        if stage in _WALK_SEEDS:
            arguments = {"query": _WALK_SEEDS[stage], "orderBy": "modifiedTime desc"}
        else:
            identity, key, drive = walk["queue"][0]
            query = "trashed = false"
            if checkpoint.get("request_shared_with_me") is True:
                query += f" and {SHARED_WITH_ME_CLAUSE}"
            arguments = {
                "folderId": identity,
                "query": query,
                "orderBy": "modifiedTime desc",
                **({"resourceKey": key} if key else {}),
                **({"driveId": drive} if drive else {}),
            }
        arguments["pageSize"] = page_size
        if walk.get("token"):
            arguments["pageToken"] = walk["token"]
        counts["sharedFolderWalkCalls"] = counts.get("sharedFolderWalkCalls", 0) + 1
        try:
            result = await listing_read(
                user_id=job["user_id"], tool_name="search_files", arguments=arguments
            )
        except DriveReadError as error:
            if str(error) == "file_too_large" and page_size != WALK_PAGE_SIZES[-1]:
                # Same cursor, fewer rows: a page over the response budget
                # never advances the walk or loses its rows.
                walk["page_size"] = WALK_PAGE_SIZES[WALK_PAGE_SIZES.index(page_size) + 1]
                return checkpoint, [], False, False
            if str(error) != "source_unavailable" or stage != "folders":
                raise
            # Deleted, or the owner lost access: nothing in it can be shared.
            _counter(checkpoint, "sharedFolderWalkUnavailable")
            walk["queue"].pop(0)
            walk.update(token=None, tokens=[])
            done = False
            if not walk["queue"]:
                done = _finish_walk(checkpoint, "complete")
            elif counts["sharedFolderWalkCalls"] >= MAX_WALK_CALLS:
                done = _finish_walk(checkpoint, "partial")
            return checkpoint, [], False, done
        payload = result.payload
        rows = payload.get("files") if isinstance(payload, dict) else None
        incomplete = payload.get("incompleteSearch", False) if isinstance(payload, dict) else None
        if (
            result.is_error
            or result.truncated
            or not isinstance(payload, dict)
            or payload.get("overLimit") is True
            or type(incomplete) is not bool
            or not isinstance(rows, list)
            or len(rows) > page_size
        ):
            raise DriveReadError("provider_response_invalid")
        token = _walk_token(payload, walk)
        if incomplete:
            _walk_partial(checkpoint, "incomplete")
        candidates = []
        for row in rows:
            match = DriveLiveReader._match(row)
            if match is None:
                _walk_partial(checkpoint, "incomplete")
                continue
            if match["mime_type"] == FOLDER_MIME:
                _walk_enqueue(checkpoint, row.get("id"), row.get("resourceKey"), row.get("driveId"))
                continue
            details = row.get("shortcutDetails")
            if (
                match["mime_type"] == SHORTCUT_MIME
                and isinstance(details, dict)
                and details.get("targetMimeType") == FOLDER_MIME
            ):
                _walk_enqueue(
                    checkpoint, details.get("targetId"), details.get("targetResourceKey"), None
                )
                continue
            if stage == "folders":
                # The owner's own shortcuts (a seed listing) are Drive's pass.
                candidates.append(row)
        if stage == "folders":
            _counter(checkpoint, "sharedFolderWalkFiles", len(candidates))
        await self._remember_walked(job, rows)
        files = await self._walk_candidates(job, checkpoint, candidates)
        walk["token"] = token
        if not token:
            walk["tokens"] = []
            if stage == "seed_folders":
                walk["stage"] = "seed_shortcuts"
            elif stage == "seed_shortcuts":
                walk["stage"] = "folders"
            else:
                walk["queue"].pop(0)
                _counter(checkpoint, "sharedFoldersWalked")
        ended = None
        if walk["stage"] == "folders" and not walk["queue"]:
            ended = "complete"
        elif counts["sharedFolderWalkCalls"] >= MAX_WALK_CALLS:
            ended = "partial"
        while (
            ended is None
            and walk["queue"]
            and len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8"))
            > MAX_CHECKPOINT_BYTES
        ):
            # The encrypted checkpoint has a fixed budget: the newest queued
            # folders give way and the walk reports partial coverage.
            walk["queue"].pop()
            _counter(checkpoint, "sharedFolderWalkSkipped")
            _walk_partial(checkpoint, "limit")
        if (
            ended is None
            and len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8"))
            > MAX_CHECKPOINT_BYTES
        ):
            ended = "partial"
        # A walk that ends hands over to the content phase when one is planned.
        done = _finish_walk(checkpoint, ended) if ended is not None else False
        return checkpoint, files, False, done

    async def _local_index_rows(self, job, checkpoint, *, allow_listing=False) -> list[dict]:
        brain = _request_brain(checkpoint)
        if brain is None:
            return []
        # One lookup per AND group, as the Drive pass compiles them: topics
        # with each document part, and topics with each standalone phrase.
        groups = _brain_groups(brain)
        # File dates do not decide an owner-review request; the period rule
        # is the one _request_candidates applies to Drive's rows.
        owner_review = checkpoint.get("request_owner_review_required") is True
        rows: dict[str, dict] = {}
        for position, concepts in enumerate(groups):
            try:
                found = await self.owner_index.match_owner_files(
                    owner_id=job["user_id"],
                    concepts=concepts,
                    period=None if owner_review else checkpoint.get("requested_period"),
                    file_kind=checkpoint.get("request_file_kind", "any"),
                    limit=MAX_LOCAL_CANDIDATES,
                    connection_generation=job.get("generation"),
                    precedence=autoshare_selection(checkpoint),
                    require_current=lambda: self.store.require_current(job),
                    # Only the first lookup may list index pages from Drive.
                    allow_listing=allow_listing and position == 0,
                )
            except Exception:  # noqa: BLE001 - an accelerator never fails the search
                logger.info("drive_search.local_index status=unavailable")
                return []
            for row in found if isinstance(found, list) else []:
                capabilities = row.get("capabilities") if isinstance(row, dict) else None
                # A row without Drive's own canShare answer would be frozen as
                # unverified and then dedupe away the verified Drive row.
                if (
                    isinstance(capabilities, dict)
                    and type(capabilities.get("canShare")) is bool
                    and isinstance(row.get("id"), str)
                ):
                    rows.setdefault(row["id"], row)
        return list(rows.values())[:MAX_LOCAL_CANDIDATES]

    async def _local_index_page(self, job, checkpoint):
        """Gear 1: commit indexed matches first; Drive (Gear 2) still runs in full.

        Every row passes the same candidate checks as a Drive page, and the
        store dedupes by file ID, so Gear 2 never adds a second copy.
        """
        from hushh_mcp.services.external_mcp_client import ExternalMcpError
        from hushh_mcp.services.google_drive_rest_transport import _project_page

        offset = checkpoint.get("local_offset", 0)
        rows = (
            await self._local_index_rows(job, checkpoint, allow_listing=offset == 0)
            if type(offset) is int
            else []
        )
        chunk = rows[offset : offset + FILE_LIST_PAGE_SIZE] if type(offset) is int else []
        try:
            # The exact projection and fence a Drive REST page goes through.
            candidates = _project_page({"files": chunk}, chunk)["files"]
        except (DriveReadError, ExternalMcpError, KeyError, TypeError, ValueError):
            # The shared projection rejects a malformed row with ExternalMcpError;
            # Gear 1 is dropped for this job and Drive still runs in full.
            logger.info("drive_search.local_index status=invalid_rows")
            candidates, rows = [], []
        files, _ = await self._request_candidates(
            job, checkpoint, candidates, folder_scoped=False, drive_id=None, found_by="index"
        )
        _counter(checkpoint, "localIndexCandidates", len(files))
        next_offset = (offset if type(offset) is int else 0) + len(chunk)
        if chunk and next_offset < len(rows):
            checkpoint["local_offset"] = next_offset
        else:
            checkpoint.pop("local_offset", None)
            # Gear 1 is a head start, not coverage: Drive is listed in full,
            # continuing from wherever its own phase and page token stand.
            if checkpoint.get("phase") == "local_index":
                _phase(checkpoint, "user")
        return checkpoint, files, False, False

    async def _index_content_rows(self, job, checkpoint) -> list[dict]:
        """Gear 1's recent rows (no listing call), projected like a Drive page.

        Only rows already held in this worker's memory; a cold or disabled
        index adds nothing. A "shared with me" search skips Gear 1, whose rows
        do not record the owner.
        """
        from hushh_mcp.services.external_mcp_client import ExternalMcpError
        from hushh_mcp.services.google_drive_rest_transport import _project_page

        recent = getattr(self.owner_index, "recent_files", None)
        if (
            recent is None
            or getattr(self.owner_index, "enabled", False) is not True
            or checkpoint.get("request_shared_with_me") is True
        ):
            return []
        try:
            rows = await recent(
                owner_id=job["user_id"],
                since=_content_window_start(checkpoint),
                file_kind=checkpoint.get("request_file_kind", "any"),
                limit=CONTENT_INDEX_ROWS,
                connection_generation=job.get("generation"),
            )
        except Exception:  # noqa: BLE001 - an accelerator never fails the search
            logger.info("drive_search.content_candidates status=index_unavailable")
            return []
        if not isinstance(rows, list) or not rows:
            return []
        try:
            return _project_page({"files": rows}, rows)["files"]
        except (DriveReadError, ExternalMcpError, KeyError, TypeError, ValueError):
            logger.info("drive_search.content_candidates status=invalid_rows")
            return []

    @staticmethod
    def _content_result(item: dict) -> dict | None:
        """A content-only hit as a frozen result: a possible match, never title evidence."""
        match = DriveLiveReader._match(item)
        if match is None:
            return None
        key = item.get("resourceKey")
        return {
            "id": match["file_id"],
            "name": match["name"],
            "mimeType": match["mime_type"],
            "modifiedTime": match["modified_time"],
            "createdTime": match["created_time"],
            **({"resourceKey": key} if isinstance(key, str) and key else {}),
            "openUrl": match["open_url"],
            **_shareability(item),
            **possible_match_fields(CONTENT),
        }

    async def _content_check_page(self, job, checkpoint):
        """One bounded call of the request-time content check (CONTENT_CHECK_PHASE).

        Reads Drive-blind candidates in the parser child (drive_content_check
        port): only matched concept indices, header dates and counts come
        back, never text. Content hits are committed as possible matches; the
        autoshare title rule is untouched. The check's own resume state rides
        in the encrypted checkpoint and is dropped when the phase ends.
        """
        state = checkpoint.get("content_phase")
        if not _content_planned(checkpoint) or not isinstance(state.get("candidates", []), list):
            return checkpoint, [], False, _end_content(checkpoint, "invalid")
        brain = _request_brain(checkpoint)
        groups, requirements = brain_concept_groups(brain) if brain is not None else ([], [])
        groups = _fit_content_groups(groups)
        if not groups:
            return checkpoint, [], False, _end_content(checkpoint, "not_needed")
        check = self.content_check or default_content_check()
        if getattr(check, "enabled", False) is not True:
            # The operator's flag, a process that is not the worker, or a
            # disabled drain: nothing is read and coverage is unchanged.
            return checkpoint, [], False, _end_content(checkpoint, "disabled")
        if not state.get("seeded"):
            state["seeded"] = True
            _remember_content_candidates(
                checkpoint, await self._index_content_rows(job, checkpoint), source="index"
            )
        candidates = [item for item in state.get("candidates") or [] if isinstance(item, dict)]
        if not candidates:
            return checkpoint, [], False, _end_content(checkpoint, "not_needed")
        deadline = _SLICE_DEADLINE.get()
        seconds = CONTENT_CHECK_PAGE_SECONDS
        if deadline is not None:
            seconds = min(seconds, int(deadline - _clock()) - 5)
        if seconds < 5:
            # Too little of this slice is left: the next slice continues here.
            return checkpoint, [], False, False
        from dataclasses import replace

        state["pages"] = state.get("pages", 0) + 1
        _counter(checkpoint, "contentCheckPages")
        try:
            outcome = await check.check_files(
                owner_id=job["user_id"],
                candidates=[_content_rest_row(item) for item in candidates],
                concepts=groups,
                requirements=requirements,
                period=checkpoint.get("requested_period"),
                connection_generation=job["generation"],
                require_current=lambda: self.store.require_current(job),
                checkpoint=state.get("check"),
                precedence=True,
                budget=replace(CONTENT_CHECK_BUDGET, slice_seconds=seconds),
            )
        except DriveReadError as error:
            if str(error) != "invalid_argument":
                # Grant, fence and connection failures stop the search as any
                # Drive page would; per-file trouble never reaches here.
                raise
            # An extra pass never fails a search whose title matches stand.
            return checkpoint, [], False, _end_content(checkpoint, "invalid")
        state["check"] = outcome.checkpoint
        by_id = {item["id"]: item for item in candidates}
        committed = set(state.get("committed") or [])
        files = []
        for result in outcome.possible_matches:
            item = by_id.get(result.file_id)
            if item is None or result.file_id in committed:
                continue
            frozen = self._content_result(item)
            if frozen is None or frozen.get("shareable") is not True:
                continue
            committed.add(result.file_id)
            if (
                checkpoint.get("coverage_counts", {}).get("possibleMatchCandidates", 0)
                >= MAX_POSSIBLE_MATCHES
            ):
                _counter(checkpoint, "possibleMatchesDropped")
                continue
            _counter(checkpoint, "possibleMatchCandidates")
            files.append(frozen)
        state["committed"] = sorted(committed)
        counts = checkpoint.setdefault("coverage_counts", {})
        counts["contentFilesSelected"] = int(outcome.counts.get("selected", 0) or 0)
        counts["contentFilesRead"] = sum(
            1 for result in outcome.results if result.status == "checked"
        )
        counts["contentPossibleMatches"] = counts.get("contentPossibleMatches", 0) + len(files)
        if outcome.status == "partial" and state["pages"] < MAX_CONTENT_CHECK_PAGES:
            return checkpoint, files, False, False
        ending = {
            "complete": "complete",
            "budget_exhausted": "budget_exhausted",
            "not_needed": "not_needed",
            "disabled": "disabled",
        }.get(outcome.status, "partial")
        return checkpoint, files, False, _end_content(checkpoint, ending)

    async def _indexed_page(self, job):
        checkpoint = copy.deepcopy(job["checkpoint"])
        if checkpoint["evidence_route"] == "packet":
            binding = checkpoint.get("reusable_packet") or checkpoint["matched_packet"]
            manifest = await self._packet_store().current_packet_manifest(
                owner_user_id=job["user_id"],
                packet_id=binding["packetId"],
                version=binding["version"],
            )
            validate_reusable_packet(manifest, binding, job["user_id"])
            offset = checkpoint["packet_offset"]
            sources = manifest["sources"][offset : offset + PAGE_SIZE]
            documents = [
                {**source, "metadata": manifest["source_metadata"][source["document_id"]]}
                for source in sources
            ]
            checkpoint["packet_offset"] += len(documents)
            done = checkpoint["packet_offset"] == len(manifest["sources"])
        else:
            current = await self._facts_store().current_index_status(owner_user_id=job["user_id"])
            if (
                checkpoint["evidence_route"] == "index"
                and not current["complete"]
                or current["signature"] != checkpoint["index_snapshot"]["signature"]
            ):
                raise DriveReadError("source_changed")
            page = await self._facts_store().current_documents_page(
                owner_user_id=job["user_id"], cursor=checkpoint["index_cursor"], limit=PAGE_SIZE
            )
            documents = page["documents"]
            checkpoint["index_cursor"] = page["next_cursor"]
            done = page["next_cursor"] is None
        semaphore = asyncio.Semaphore(6)

        async def candidate(document):
            metadata = document["metadata"]
            async with semaphore:
                # The whole page is fenced before provider I/O and atomically
                # at commit; avoid rescanning the collection per file.
                result = await self.transport.read_tool(
                    user_id=job["user_id"],
                    tool_name="get_file_metadata",
                    arguments={"fileId": metadata["file_id"]},
                )
                if result.is_error or result.truncated or not isinstance(result.payload, dict):
                    raise DriveReadError("provider_response_invalid")
                source = result.payload.get("file")
                match = DriveLiveReader._match(source)
                if (
                    match is None
                    or match["file_id"] != metadata["file_id"]
                    or source.get("version") != document["source_version"]
                    or match["name"] != metadata["name"]
                    or source.get("trashed") is True
                ):
                    raise DriveReadError("source_changed")
                capabilities = source.get("capabilities", {})
                if (
                    capabilities.get("canDownload") is not True
                    or capabilities.get("canAccessViaGenAi") is False
                ):
                    raise DriveReadError("source_unavailable")
                return {
                    "id": match["file_id"],
                    "name": match["name"],
                    "mimeType": match["mime_type"],
                    "modifiedTime": match["modified_time"],
                    "createdTime": match.get("created_time"),
                    "openUrl": match["open_url"],
                    **_shareability(source),
                    "indexedEvidence": {
                        key: document[key]
                        for key in ("document_id", "source_version", "facts_version")
                    },
                    "indexedEvidenceBytes": len(
                        json.dumps(document.get("facts", {}), ensure_ascii=False).encode()
                    )
                    * 2,
                    "requestEvidence": {
                        "version": 1,
                        "assessment": "unverified",
                        "basis": "document_index",
                    },
                }

        tasks = [asyncio.create_task(candidate(document)) for document in documents]
        try:
            files = await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        _counter(checkpoint, "indexedDocumentsReused", len(files))
        if done and checkpoint["evidence_route"] == "hybrid":
            checkpoint["phase"] = "user"
            done = False
        return checkpoint, files, False, done

    async def _page(self, job, *, page_size_override=None):
        if (
            job["checkpoint"].get("evidence_route") in {"index", "packet"}
            or job["checkpoint"].get("phase") == "index"
        ):
            return await self._indexed_page(job)
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
        if checkpoint.get("phase") == "local_index" or (
            type(checkpoint.get("local_offset")) is int and page_size_override is None
        ):
            # Never in the create-time page: a cold index would spend that one
            # 15-second page listing Drive instead of returning its first rows.
            return await self._local_index_page(job, checkpoint)
        if checkpoint.get("phase") == "shared_walk":
            return await self._shared_walk_page(job, checkpoint)
        if checkpoint.get("phase") == CONTENT_CHECK_PHASE:
            return await self._content_check_page(job, checkpoint)
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
            if checkpoint.get("file_page_size") == FILE_LIST_PAGE_SIZE
            else V1_FILE_LIST_PAGE_SIZE
            if checkpoint.get("v1_live_request") is True
            else FILE_LIST_PAGE_SIZE
        )
        args = {**checkpoint["arguments"], "pageSize": file_page_size}
        if phase == "folder_files":
            folder = checkpoint["folder_queue"][0]
            clause = _request_discovery_clause(checkpoint.get("request_file_kind", "any"))
            args = {
                "folderId": folder["id"],
                "query": clause or "trashed = false",
                # New checkpoints carry the discovery order. Keep the saved
                # order for resumed folder pages so their token is not reused
                # with different provider arguments after a rollout.
                "orderBy": checkpoint["arguments"].get("orderBy", "modifiedTime desc"),
                "pageSize": file_page_size,
                **({"driveId": folder["driveId"]} if folder.get("driveId") else {}),
                **({"resourceKey": folder["resourceKey"]} if folder.get("resourceKey") else {}),
            }
        if checkpoint["page_token"]:
            args["pageToken"] = checkpoint["page_token"]
        if phase == "files":
            args["driveId"] = checkpoint["drives"][checkpoint["drive_index"]]
        while True:
            try:
                result = await listing_read(
                    user_id=job["user_id"], tool_name="search_files", arguments=args
                )
                break
            except DriveReadError as error:
                if str(error) != "file_too_large" or file_page_size == PAGE_SIZE:
                    raise
                # Retry the exact cursor with less metadata; never advance a
                # checkpoint from a page that exceeded the response budget.
                file_page_size = FILE_LIST_PAGE_SIZE if file_page_size > 100 else PAGE_SIZE
                checkpoint["file_page_size"] = file_page_size
                args["pageSize"] = file_page_size
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
        while (
            file_page_size > PAGE_SIZE
            and sum(
                item.get("mimeType") == SHORTCUT_MIME
                for item in candidates
                if isinstance(item, dict)
            )
            > 8
        ):
            # A shortcut-heavy page could require hundreds of target reads.
            # Retry the same cursor at a smaller size before committing rows.
            large_page_incomplete = incomplete
            file_page_size = FILE_LIST_PAGE_SIZE if file_page_size > 100 else PAGE_SIZE
            checkpoint["file_page_size"] = file_page_size
            args["pageSize"] = file_page_size
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
                or len(candidates) > file_page_size
            ):
                raise DriveReadError("provider_response_invalid")
            incomplete = incomplete or large_page_incomplete
        if checkpoint.get("request_origin_id"):
            _counter(checkpoint, "providerRowsScanned", len(candidates))
            _counter(checkpoint, "providerFilePages")
            original_candidates = candidates
            if checkpoint.get("request_direct_originals"):
                # Do not expand aliases or folders when the provider violates
                # the direct-original query; neither belongs to this scope.
                candidates = [
                    candidate
                    for candidate in candidates
                    if isinstance(candidate, dict)
                    and candidate.get("mimeType") not in {FOLDER_MIME, SHORTCUT_MIME}
                ]
                incomplete = incomplete or len(candidates) != len(original_candidates)
            files, candidate_incomplete = await self._request_candidates(
                job,
                checkpoint,
                candidates,
                folder_scoped=phase == "folder_files",
                drive_id=args.get("driveId"),
            )
            incomplete = incomplete or candidate_incomplete
            bounded_complete = _bounded_corpus_complete(
                checkpoint, original_candidates, files, incomplete=incomplete
            )
        else:
            bounded_complete = False
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
        if next_token and bounded_complete:
            _counter(checkpoint, "boundedCorporaCompleted")
            checkpoint["request_rank_pruned"] = True
            next_token = None
        checkpoint["page_token"] = next_token
        done = False
        query = (checkpoint.get("queries") or [{}])[checkpoint.get("query_index", 0)]
        head_start = query.get("head_start_pages") if phase != "folder_files" else None
        if type(head_start) is int and head_start > 0:
            used = checkpoint.get("head_start_used", 0) + 1
            checkpoint["head_start_used"] = used
            if used >= head_start:
                # The following full-text pass covers every remaining title
                # match in every corpus; stop the head start here.
                checkpoint.pop("head_start_used", None)
                checkpoint["page_token"] = next_token = None
                done = _advance_query(checkpoint)
                phase = "head_start_done"
        if not next_token and phase != "head_start_done":
            if phase == "user":
                if _user_corpus_only(checkpoint):
                    # "Shared with me" lists the user corpus and the walk; a
                    # shared drive's files are not shared with the owner.
                    done = _advance_query(checkpoint)
                else:
                    _phase(checkpoint, "drives")
            elif phase == "folder_files":
                checkpoint["folder_queue"].pop(0)
                _counter(checkpoint, "matchingFoldersExhausted")
                if checkpoint["folder_queue"]:
                    _phase(checkpoint, "folder_files")
                else:
                    done = _walk_or_done(checkpoint)
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
        if done:
            # Drive, the completeness authority, has finished: no head start.
            checkpoint.pop("local_offset", None)
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
        with drive_stage(logger, "search_claim"):
            job = await self.store.claim(user_id=user_id, job_id=job_id)
        if job is None:
            return "not_claimed"
        started = time.monotonic()
        pages = 0
        found = 0
        outcome = "failed"
        handing_off = False
        deadline_token = None

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
            checkpoint = job["checkpoint"]
            saved_request = checkpoint.get("request")
            from hushh_mcp.services.drive_request_bulk_service import (
                _deterministic_statement_plan,
            )

            if (
                checkpoint.get("request_origin_id")
                and checkpoint.get("evidence_route", "provider") == "provider"
                and checkpoint.get("request_coverage_query_version") != 1
                and _legacy_single_query(checkpoint)
                and isinstance(saved_request, dict)
                and _deterministic_statement_plan({"purpose": saved_request.get("query")})
                is not None
            ):
                if require_current:
                    await require_current()
                await self.store.require_current(job)
                from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                sharing = self.sharing or DriveSharingStore(db=self.store.db)
                from hushh_mcp.services.drive_sharing_contract import DriveSharingError

                try:
                    context = await sharing.request_bulk_context(
                        user_id=user_id, request_id=checkpoint["request_origin_id"]
                    )
                except DriveSharingError:
                    await self.store.release(job, error="connection_changed")
                    return finish("superseded")
                _, changed, worker_stage = await self.replan_legacy_statement_request(
                    user_id=user_id,
                    request_id=checkpoint["request_origin_id"],
                    context=context,
                    expected_lease=job["lease_id"],
                )
                if changed:
                    await wake_drive_work(worker_stage)
                    return finish("queued")
            session = getattr(self.transport, "owner_search_session", nullcontext)
            reserve = min(PAGE_RESERVE_SECONDS, deadline_seconds / 3)
            slice_started = _clock()
            deadline_token = _SLICE_DEADLINE.set(slice_started + deadline_seconds)
            async with asyncio.timeout(deadline_seconds), session():
                for _ in range(max_pages):
                    if pages and _clock() - slice_started > deadline_seconds - reserve:
                        # Hand off with the checkpoint committed; the worker
                        # chains the next slice without a retry backoff.
                        break
                    if (
                        pages
                        and job["checkpoint"].get("phase") == CONTENT_CHECK_PHASE
                        and deadline_seconds - (_clock() - slice_started)
                        < CONTENT_CHECK_PAGE_SECONDS + reserve
                    ):
                        # A content page needs its own budget: start it in
                        # the next slice rather than cut it short here.
                        break
                    with drive_stage(logger, "search_authority"):
                        if require_current:
                            await require_current()
                        await self.store.require_current(job)
                    page_started = time.monotonic()
                    phase = job["checkpoint"].get("phase")
                    if type(job["checkpoint"].get("local_offset")) is int and not (
                        pages == 0 and initial_page_size is not None
                    ):
                        phase = "local_index"
                    phase = (
                        phase
                        if phase
                        in {
                            "local_index",
                            "user",
                            "drives",
                            "files",
                            "folder_files",
                            "shared_walk",
                            CONTENT_CHECK_PHASE,
                            "index",
                            "packet",
                        }
                        else "unknown"
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
                    with drive_stage(logger, "search_commit"):
                        if require_current:
                            await require_current()
                        result = await self.store.commit_page(
                            job,
                            checkpoint=checkpoint,
                            files=files,
                            incomplete=incomplete,
                            done=done,
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
                            with drive_stage(logger, "search_handoff"):
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
            if str(error) == "reconnect_required":
                # Drive rejected the current access token (HTTP 401). As with a
                # refused refresh, the owner must reconnect; a retry cannot help
                # and "provider unavailable" would hide the cause.
                return finish(await self.store.release(job, error="connection_changed"))
            return finish(
                await self.store.release(
                    job,
                    error=str(error),
                    retryable=str(error) == "provider_unavailable" and error.retryable,
                    # Precise cause and Retry-After (page-token restart, quota
                    # deferral, encrypted cause); empty when the code says all.
                    **release_detail(error),
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
            if deadline_token is not None:
                _SLICE_DEADLINE.reset(deadline_token)
            logger.info(
                "drive_search.slice status=%s pages=%d matched=%d elapsed_ms=%.2f",
                outcome,
                pages,
                found,
                (time.monotonic() - started) * 1000,
            )
