"""Checkpointed discovery and request-local verified candidate collection.

Legacy searches retain their frozen metadata policy. Enrolled searches assess
bounded contents before committing results; permission effects stay separate.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
from calendar import monthrange
from contextlib import nullcontext
from datetime import UTC, date, datetime, timedelta, timezone
from functools import partial
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_live_reader import MIME_CLAUSES, DriveLiveReader, _open_url
from hushh_mcp.services.drive_long_range_listing import _term_pattern
from hushh_mcp.services.drive_owner_index_port import MAX_LOCAL_CANDIDATES, default_owner_index
from hushh_mcp.services.drive_owner_search_store import (
    DriveOwnerSearchStore,
    _legacy_single_query,
    validate_reusable_packet,
)
from hushh_mcp.services.drive_request_discovery import (
    DISCOVERY_DELIVERY_POLICY,
    compile_discovery_queries,
    discovery_delivery,
    discovery_evidence,
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
    words = [word for word in re.split(r"[\s\-]+", variant.casefold()) if word]
    if len(words) == 1 and words[0].isalpha():
        return _term_pattern(words[0])
    # "pay slip" also names "Pay slips Sep.pdf".
    suffix = "(?:e?s)?" if words[-1].isalpha() else ""
    return re.compile(
        r"(?<!\w)" + r"[\s_\-]*".join(re.escape(word) for word in words) + suffix + r"(?!\w)",
        re.I,
    )


def _brain_title_has(variant: str, title: str) -> bool:
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
    if checkpoint.get("semantic_plan") is not None:
        return True  # The sealed semantic assessor owns document meaning.
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
    if checkpoint.get("semantic_plan") is not None:
        return True  # A provider fullText hit is a candidate, not title proof.
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
    can_share = capabilities.get("canShare") if isinstance(capabilities, dict) else None
    encryption_state = (
        "absent"
        if encryption is None
        else "unencrypted"
        if isinstance(encryption, dict) and encryption.get("encryptionState") == "unencrypted"
        else "not_unencrypted"
    )
    reason = (
        "encryption_restricted"
        if encryption_state == "not_unencrypted"
        else "allowed"
        if can_share is True
        else "capability_denied"
        if can_share is False
        else "capability_unverified"
    )
    return {
        "shareable": reason == "allowed",
        **(
            {
                "unavailableReason": "shareability_unverified"
                if reason == "capability_unverified"
                else "source_not_shareable"
            }
            if reason != "allowed"
            else {}
        ),
        "shareabilityEvidence": {
            "version": 1,
            "canShare": can_share if type(can_share) is bool else None,
            "encryptionState": encryption_state,
            "reason": reason,
        },
    }


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


MAX_QUERY_CHARS = 1800
# Newest-first title pages listed before the full-text pass takes over.
HEAD_START_PAGES = 10


def _brain_variant_clauses(variants, keys, *, title_only, dropped) -> list[str]:
    from hushh_mcp.services.drive_request_brain import full_text_safe
    from hushh_mcp.services.google_drive_rest_transport import full_text_literal, quote_literal

    clauses = []
    for key, variant in zip(keys, variants, strict=True):
        if key in dropped:
            continue
        clauses.append(f"name contains {quote_literal(variant)}")
        # Drive fullText matches whole tokens only; "1:1" stays a title clue.
        if not title_only and full_text_safe(variant):
            clauses.append(f"fullText contains {full_text_literal(variant)}")
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
    if parsed.semantic_query is not None:
        from hushh_mcp.services.drive_request_semantic_plan import (
            SemanticPlanInputRequired,
            compile_semantic_queries,
        )

        try:
            queries = compile_semantic_queries(
                parsed.semantic_query,
                file_kind=parsed.file_kind,
                period_start=purpose.get("periodStart"),
                period_end=purpose.get("periodEnd"),
                timezone=timezone,
            )
        except SemanticPlanInputRequired:
            raise DriveReadError("narrow_selection_required") from None
        return queries, {
            "start": purpose["periodStart"],
            "end": purpose["periodEnd"],
            "timezone": timezone,
        }
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
        base.append("sharedWithMe = true")
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
            generic_meeting_notes = (
                not parsed_brain.topics
                and not parsed_brain.corrected
                and len(parsed_brain.parts) == 1
                and parsed_brain.parts[0].key == "meeting_notes"
                and any(
                    item.phrase == "notes by gemini" for item in parsed_brain.parts[0].standalone
                )
                and _is_meeting_note_request(purpose.get("purpose", ""))
            )
            if generic_meeting_notes:
                # Drive's name operator matches prefixes. A Gemini file named
                # "Meeting started ... - Notes by Gemini" need not match the
                # brain's trailing "notes by gemini" name clause, and a body
                # index hit is not guaranteed. Exhaust this narrow title pass;
                # a one-page head start would leave the same recall gap.
                title = " and ".join([f"name contains {quote_literal('Meeting started')}", *base])
                if len(title) > MAX_QUERY_CHARS:
                    raise DriveReadError("invalid_argument")
                # Preserve the existing title head start on the create-time
                # page; the prefix pass follows before the content scan.
                brain_queries.insert(
                    1, {"arguments": {"query": title, "orderBy": f"{brain_order} desc"}}
                )
            return brain_queries, period
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

    if meeting_notes_v1 and not parsed.exact_title and not entity_subject:
        # Gemini-generated notes have a distinctive title prefix. A single
        # newest-first page gives these likely records the first evaluation
        # cohort. The later exhaustive alias pass still covers every title,
        # including older Gemini notes and other meeting-note spellings.
        gemini_title = " and ".join([f"name contains {quote_literal('Meeting started')}", *base])
        queries.insert(
            0,
            {
                "arguments": {"query": gemini_title, "orderBy": f"{order} desc"},
                "head_start_pages": 1,
            },
        )
    # Put the common title aliases before broad clue pages so a sync or
    # standup file enters an early evaluation cohort.
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
                *(["sharedWithMe = true"] if parsed.shared_with_me else []),
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
        return queries, period
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
    return queries, period


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
    limit = checkpoint.get("request_result_limit")
    # Provider-query packets are exhaustive originals, not a top-N request.
    # Old durable checkpoints also omit this optional ranking contract.
    if limit is None:
        return False
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
        candidate_assessor=None,
        reader_factory=None,
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
        self.candidate_assessor = candidate_assessor
        self.reader_factory = reader_factory or DriveLiveReader

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
            return {
                "kind": "packet",
                "reusable_packet": reusable_packet,
                **(
                    {
                        "provider_packet": True,
                        "plan": manifest["search"]["authored_plan"],
                        "model_binding": manifest["search"]["model_binding"],
                        "query_source": manifest["search"].get("query_source"),
                        "queries": manifest["search"]["queries"],
                        "period": {
                            "start": manifest["periodStart"],
                            "end": manifest["periodEnd"],
                            "timezone": manifest["timezone"],
                        },
                    }
                    if manifest.get("kind") == "provider_discovery"
                    else {}
                ),
            }
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
        semantic_search=False,
        semantic_model_binding=None,
        discovery_delivery_enabled=False,
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
            or plan_source not in {None, "deterministic_brain", "model", "frozen_provider_packet"}
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
        from hushh_mcp.services.drive_request_search_contract import provider_packet_scope

        provider_packet, timezone = provider_packet_scope(
            route, plan, purpose, semantic_model_binding, timezone, plan_source
        )
        if (
            not (purpose.get("periodStart") and purpose.get("periodEnd"))
            and route["kind"] != "packet"
        ):
            raise DriveReadError("date_range_required")
        await require_current()
        query = purpose["purpose"]
        plan = _v1_meeting_note_plan(plan, purpose, v1_live_request=v1_live_request)
        from hushh_mcp.services.drive_request_search_contract import validated_request_semantics
        from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

        semantic_plan, semantic_model_binding, semantic_policy = validated_request_semantics(
            plan,
            discovery_delivery_enabled=discovery_delivery_enabled,
            semantic_model_binding=semantic_model_binding,
            semantic_search=semantic_search,
            v1_live_request=v1_live_request,
            indexed=indexed,
            provider_packet=provider_packet,
            parsed_brain=parsed_brain,
        )
        request = self._request(query, timezone)
        existing = await self.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None and existing["status"] in {"queued", "running"}:
            return existing
        if indexed:
            period = {"start": purpose.get("periodStart"), "end": purpose.get("periodEnd")}
            queries = (
                route["queries"]
                if provider_packet
                else [{"arguments": {"orderBy": "modifiedTime desc"}}]
            )
            if provider_packet:
                period = route["period"]
        else:
            queries, period = compile_request_queries(
                plan,
                purpose,
                timezone,
                requested_at=requested_at,
                v1_live_request=v1_live_request,
                brain=parsed_brain,
            )
        if discovery_delivery_enabled and not provider_packet:
            from hushh_mcp.services.drive_request_semantic_plan import SemanticPlanInputRequired

            try:
                queries = compile_discovery_queries(
                    semantic_plan,
                    file_kind=plan.get("file_kind", "any"),
                    period_start=purpose.get("periodStart"),
                    period_end=purpose.get("periodEnd"),
                    timezone=timezone,
                    shared_with_me=plan.get("shared_with_me", False),
                )
            except SemanticPlanInputRequired:
                raise DriveReadError("narrow_selection_required") from None
        v1_statement_search = v1_live_request
        # Gear 1 runs when an owner index is wired and the brain has a subject.
        # The create-time page stays a 25-row Drive page; Gear 1 (which may
        # list the index from Drive) runs in the next worker slice, before
        # any further Drive page.
        local_first = bool(
            not indexed
            and parsed_brain is not None
            and parsed_brain.concepts
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
        order_field = queries[0]["arguments"].get("orderBy", "modifiedTime desc").split()[0]
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
                **(
                    {
                        "semantic_plan": semantic_plan,
                        "semantic_plan_digest": semantic_plan_digest(semantic_plan),
                        "semantic_assessment_policy": semantic_policy,
                        **(
                            {"semantic_model_binding": semantic_model_binding}
                            if semantic_model_binding is not None
                            else {}
                        ),
                        **(
                            {"discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY}
                            if discovery_delivery_enabled
                            else {}
                        ),
                        "semantic_pending": [],
                        "semantic_seen": [],
                        "semantic_purpose": purpose,
                    }
                    if semantic_plan is not None
                    else {}
                ),
                "evidence_route": route["kind"],
                **({"provider_packet": True} if provider_packet else {}),
                **(
                    {
                        key: route[key]
                        for key in (
                            "reusable_packet",
                            "query_source",
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
                "request_notes": semantic_plan is None
                and bool(re.search(r"\b(?:notes?|minutes)\b", query, re.I)),
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
                    if direct_originals or discovery_delivery_enabled
                    else "matching_topic_folders_and_descendants",
                    "shortcutDiscovery": "excluded"
                    if direct_originals or discovery_delivery_enabled
                    else "resolve_targets",
                    "resultLimit": result_limit,
                    "orderBy": f"{order_field} desc",
                    **({"planSource": plan_source} if plan_source else {}),
                    **({"localIndexFirst": True} if local_first else {}),
                },
                "coverage_counts": {},
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

    async def _request_candidates(self, job, checkpoint, candidates, *, folder_scoped, drive_id):
        if discovery_delivery(checkpoint):
            if folder_scoped:
                raise DriveReadError("provider_response_invalid")
            candidates = [
                item
                for item in candidates
                if not isinstance(item, dict)
                or item.get("mimeType") not in {FOLDER_MIME, SHORTCUT_MIME}
            ]
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
            semantic = checkpoint.get("semantic_plan")
            if semantic is not None:
                basis = semantic["date_basis"]
                if basis == "content":
                    return True  # Original picked dates go to the content assessor.
                if basis in {"created", "modified"}:
                    field = "created_time" if basis == "created" else "modified_time"
                    return _in_requested_period(
                        {"name": "", field: match.get(field)}, period, precedence=True
                    )
                return _in_requested_period(match, period, precedence=True)
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
            if match["mime_type"] == FOLDER_MIME and discovery_delivery(checkpoint):
                continue  # Direct provider matches only; no unfiltered descendants.
            if match["mime_type"] == FOLDER_MIME:
                if (
                    folder_scoped
                    or checkpoint.get("semantic_plan") is not None
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
            if not _filename_candidate(checkpoint, match):
                _counter(checkpoint, "excludedByFilenameCount")
                continue
            if not _note_candidate(checkpoint, match, folder_scoped=folder_scoped):
                _counter(checkpoint, "excludedByNoteTypeCount")
                continue
            if (
                folder_scoped
                and not checkpoint.get("request_notes")
                and not checkpoint.get("v1_live_request")
                and checkpoint.get("semantic_plan") is None
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
                        {
                            "sourceVersion": str(source.get("version", "")),
                            **{
                                key: source[key]
                                for key in ("owners", "sharingUser")
                                if key in source
                            },
                        }
                        if checkpoint.get("semantic_plan") is not None
                        else {}
                    ),
                    **(
                        {"shortcutName": match["shortcut_name"]}
                        if match.get("shortcut_name")
                        else {}
                    ),
                    **({"resourceKey": key} if key else {}),
                    "openUrl": match["open_url"],
                    **_shareability(source),
                    **evidence,
                }
            )
        return files, incomplete

    async def _local_index_rows(self, job, checkpoint, *, allow_listing=False) -> list[dict]:
        brain = _request_brain(checkpoint)
        if brain is None:
            return []
        # One lookup per AND group, as the Drive pass compiles them: topics
        # with each document part, and topics with each standalone phrase.
        topics = [list(concept.variants) for concept in brain.topics]
        groups = []
        for part in brain.parts or (None,):
            groups.append(
                topics + [list(concept.variants) for concept in (part.concepts if part else ())]
            )
            groups.extend(topics + [[item.phrase]] for item in (part.standalone if part else ()))
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
            job, checkpoint, candidates, folder_scoped=False, drive_id=None
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

    async def _indexed_page(self, job):
        from hushh_mcp.services.drive_request_index_page import indexed_page

        return await indexed_page(self, job)

    async def _semantic_assessment_page(self, job, checkpoint):
        """Drain one durable candidate under the current search lease.

        Discovery cursors and pending metadata commit before any content read.
        A crash repeats assessment, never advances a cursor or permission effect.
        Only validated positive observations enter the normal paid-batch path.
        """
        from hushh_mcp.services.drive_document_pages import OCR_IMAGE_MIMES
        from hushh_mcp.services.drive_request_candidate_assessment import (
            CANDIDATE_OBSERVATION_CODES,
            CandidateContent,
            assess_request_candidates,
            verified_evidence_matches,
        )
        from hushh_mcp.services.drive_request_package_service import assessment_policy_version

        pending = checkpoint.get("semantic_pending", [])
        if not pending:
            return checkpoint, [], False, bool(checkpoint.get("semantic_discovery_done"))
        metadata = pending[0]

        async def current():
            await self.store.require_current(job)
            if (
                current_binding["provider"] == "azure_openai"
                or current_binding.get("authorization_basis") == "uat_policy"
            ):
                from hushh_mcp.services.private_text_processing_approval_service import (
                    require_private_azure_text_approval,
                )

                await require_private_azure_text_approval(
                    job["user_id"],
                    expected_generation=current_binding["approval_generation"],
                    **(
                        {"scope": "drive_document_requests"}
                        if current_binding.get("authorization_basis") == "uat_policy"
                        else {}
                    ),
                )

        async def read(candidate):
            await current()
            reader = self.reader_factory(user_id=job["user_id"], require_access=current)
            item = candidate["metadata"]
            match = {"file_id": item["id"], "name": item["name"], "mime_type": item["mimeType"]}
            if item["mimeType"] in {"application/pdf", *OCR_IMAGE_MIMES}:
                source, pages, truncated, fingerprint = await reader.read_request_visual_pages(
                    match=match
                )
                pieces = tuple(
                    (f"page:{page.page_number}", page.text) for page in pages if page.text.strip()
                )
            else:
                source, body, truncated = await reader.read_compilation_match(match=match)
                pieces = (("content", body),)
                fingerprint = hashlib.sha256(body.encode("utf-8")).hexdigest()
            await current()
            return CandidateContent(
                file_id=match["file_id"],
                name=source.name,
                mime_type=source.mime_type,
                source_version=str(source.version),
                pieces=pieces,
                content_fingerprint=fingerprint,
                truncated=bool(truncated),
            )

        position = checkpoint.get("semantic_assessed", 0) + 1
        candidate = {
            "position": position,
            "document_ref": f"candidate_{position}",
            "metadata": metadata,
        }
        from hushh_mcp.services.drive_request_package_assessment import (
            assess_request_document_batch,
            validate_semantic_model_binding,
        )

        sealed_binding = checkpoint.get("semantic_model_binding")
        try:
            current_binding = validate_semantic_model_binding(sealed_binding)
            current_policy = assessment_policy_version(sealed_binding)
        except ValueError:
            raise DriveReadError("source_changed") from None
        policy = checkpoint["semantic_assessment_policy"]
        if policy != current_policy:
            raise DriveReadError("source_changed")
        assessor = self.candidate_assessor or assess_request_candidates
        assessor_options = {}
        if self.candidate_assessor is None:
            assessor_options["assessor"] = partial(
                assess_request_document_batch, model_binding=current_binding
            )
        observations = await assessor(
            **assessor_options,
            user_id=job["user_id"],
            request_id=checkpoint["request_origin_id"],
            request_revision=checkpoint["request_revision"],
            connection_generation=job["generation"],
            plan_digest=checkpoint["semantic_plan_digest"],
            purpose={**checkpoint["semantic_purpose"], "semanticPlan": checkpoint["semantic_plan"]},
            candidates=[candidate],
            read_candidate=read,
            require_current=current,
            policy_version=policy,
            assessment_timeout_seconds=75,
            total_timeout_seconds=85,
        )
        await current()
        if not isinstance(observations, list) or len(observations) != 1:
            raise DriveReadError("provider_response_invalid")
        observation = observations[0]
        decision = observation.get("decision")
        files = []
        if decision == "verified_match":
            if not verified_evidence_matches(
                observation,
                user_id=job["user_id"],
                request_id=checkpoint["request_origin_id"],
                request_revision=checkpoint["request_revision"],
                connection_generation=job["generation"],
                plan_digest=checkpoint["semantic_plan_digest"],
                metadata=metadata,
                policy_version=policy,
            ):
                raise DriveReadError("provider_response_invalid")
            files.append({**metadata, "contentVerified": True, "requestEvidence": observation})
            _counter(checkpoint, "verifiedCandidateCount")
        elif decision == "excluded":
            _counter(checkpoint, "contentExcludedCount")
        elif decision == "unavailable":
            if observation.get("code") in {
                "assessment_unavailable",
                "content_unavailable",
                "provider_unavailable",
            }:
                raise DriveReadError("provider_unavailable", retryable=True)
            # Account for a bounded/unsupported read while later files continue.
            # The incomplete flag forbids a terminal zero-match conclusion.
            _counter(checkpoint, "unavailableCandidateCount")
            checkpoint["semantic_coverage_incomplete"] = True
        else:
            raise DriveReadError("provider_response_invalid")
        # Retain closed reason counts in the existing encrypted checkpoint. A
        # consumed unavailable candidate must not lose its only diagnosis.
        reason = observation.get("code")
        if not isinstance(reason, str) or reason not in CANDIDATE_OBSERVATION_CODES:
            reason = "unclassified"
        counts = checkpoint.setdefault("semantic_outcome_counts", {})
        key = f"{decision}:{reason}"
        counts[key] = counts.get(key, 0) + 1
        logger.info(
            "drive_search.candidate decision=%s reason=%s position=%d",
            decision,
            reason,
            position,
        )
        checkpoint["semantic_assessed"] = position
        checkpoint["semantic_pending"] = pending[1:]
        done = (
            not checkpoint["semantic_pending"] and checkpoint.get("semantic_discovery_done") is True
        )
        return checkpoint, files, False, done

    async def _page(self, job, *, page_size_override=None):
        if (
            not discovery_delivery(job["checkpoint"])
            and job["checkpoint"].get("semantic_plan") is not None
            and (
                job["checkpoint"].get("semantic_pending")
                or job["checkpoint"].get("semantic_discovery_done")
            )
        ):
            return await self._semantic_assessment_page(job, copy.deepcopy(job["checkpoint"]))
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
            checkpoint.get(
                "semantic_page_size", checkpoint.get("file_page_size", FILE_LIST_PAGE_SIZE)
            )
            if discovery_delivery(checkpoint)
            else checkpoint.get("semantic_page_size", PAGE_SIZE)
            if checkpoint.get("semantic_plan") is not None
            else PAGE_SIZE
            if checkpoint.get("file_page_size") == PAGE_SIZE or page_size_override == PAGE_SIZE
            else FILE_LIST_PAGE_SIZE
            if checkpoint.get("file_page_size") == FILE_LIST_PAGE_SIZE
            else V1_FILE_LIST_PAGE_SIZE
            if checkpoint.get("v1_live_request") is True
            else FILE_LIST_PAGE_SIZE
        )
        if discovery_delivery(checkpoint):
            try:
                index = checkpoint["query_index"]
                if type(index) is not int or index < 0 or checkpoint["phase"] == "folder_files":
                    raise ValueError
                if checkpoint["arguments"] != checkpoint["queries"][index]["arguments"]:
                    raise ValueError
            except (KeyError, IndexError, TypeError, ValueError):
                raise DriveReadError("provider_response_invalid") from None
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
                semantic = checkpoint.get("semantic_plan") is not None
                if str(error) != "file_too_large" or file_page_size == (
                    1 if semantic else PAGE_SIZE
                ):
                    raise
                # Retry the exact cursor with less metadata; never advance a
                # checkpoint from a page that exceeded the response budget.
                if semantic:
                    file_page_size = 5 if file_page_size > 5 else 1
                    checkpoint["semantic_page_size"] = file_page_size
                else:
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
        if checkpoint.get("request_origin_id") or checkpoint.get("period_packet_origin"):
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
        if (checkpoint.get("request_origin_id") or checkpoint.get("period_packet_origin")) and (
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
        if discovery_delivery(checkpoint):
            for item in files:
                item.pop("requestEvidence", None)
                item["discoveryEvidence"] = discovery_evidence(
                    checkpoint, user_id=job["user_id"], generation=job["generation"], metadata=item
                )
            logger.info(
                "drive_search.delivery policy=%s content_assessment=not_applicable files=%d",
                DISCOVERY_DELIVERY_POLICY,
                len(files),
            )
        elif checkpoint.get("semantic_plan") is not None:
            seen = set(checkpoint.get("semantic_seen", []))
            pending = []
            for item in files:
                if len(seen) >= 1500:
                    # This is an explicit request work budget, never evidence
                    # of provider exhaustion. Keep the checkpoint bounded.
                    _counter(checkpoint, "unassessedCandidateCount")
                    checkpoint["coverage_counts"]["workLimitReached"] = True
                    incomplete, done = True, True
                    continue
                digest = hashlib.sha256(item["id"].encode()).hexdigest()[:24]
                if digest in seen:
                    _counter(checkpoint, "deduplicatedCount")
                    continue
                seen.add(digest)
                pending.append(item)
            checkpoint["semantic_seen"] = sorted(seen)
            checkpoint["semantic_pending"] = pending
            checkpoint["semantic_discovery_done"] = done
            if incomplete:
                # Partial discovery is distinct from result eligibility: each
                # committed semantic result has independent positive evidence.
                checkpoint["semantic_coverage_incomplete"] = True
                incomplete = False
            _counter(checkpoint, "uniqueCandidateCount", len(pending))
            queued_bytes = len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8"))
            if queued_bytes > MAX_CHECKPOINT_BYTES:
                if file_page_size > 1:
                    # Re-read the exact original cursor with fewer rows. No
                    # cursor, seen set or folder queue from the oversized page
                    # may commit, or candidates would be silently skipped.
                    retry_job = dict(job)
                    retry_checkpoint = copy.deepcopy(job["checkpoint"])
                    retry_checkpoint["semantic_page_size"] = 5 if file_page_size > 5 else 1
                    retry_counts = retry_checkpoint.setdefault("coverage_counts", {})
                    for key in ("providerRowsScanned", "providerFilePages"):
                        retry_counts[key] = checkpoint.get("coverage_counts", {}).get(key, 0)
                    retry_counts["resizedProviderPages"] = (
                        retry_counts.get("resizedProviderPages", 0) + 1
                    )
                    retry_checkpoint["semantic_provider_incomplete"] = (
                        retry_checkpoint.get("semantic_provider_incomplete") is True or incomplete
                    )
                    retry_job["checkpoint"] = retry_checkpoint
                    return await self._page(retry_job)
                from hushh_mcp.services.drive_sharing_contract import MAX_ENVELOPE_BYTES

                if queued_bytes > MAX_ENVELOPE_BYTES:
                    # Refuse without committing or advancing an irreducible
                    # page that cannot fit the existing encrypted envelope.
                    raise DriveReadError("provider_response_invalid")
                checkpoint["coverage_counts"]["workLimitReached"] = True
                checkpoint["semantic_discovery_done"] = True
                incomplete, done = True, True
            incomplete = incomplete or checkpoint.get("semantic_provider_incomplete") is True
            if incomplete:
                checkpoint["semantic_coverage_incomplete"] = True
                incomplete = False
            files = []
            # Pending observations are encrypted with this provider cursor.
            done = done and not pending
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
            if checkpoint.get("semantic_pending") and deadline_seconds < 88:
                # A short scheduler remainder is not a failed provider attempt.
                if require_current:
                    await require_current()
                return finish(await self.store.release(job))
            saved_request = checkpoint.get("request")
            from hushh_mcp.services.drive_request_bulk_service import (
                _deterministic_statement_plan,
            )

            if (
                checkpoint.get("request_origin_id")
                and checkpoint.get("semantic_plan") is None
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
            async with asyncio.timeout(deadline_seconds), session():
                for _ in range(max_pages):
                    if pages and _clock() - slice_started > deadline_seconds - reserve:
                        # Hand off with the checkpoint committed; the worker
                        # chains the next slice without a retry backoff.
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
                    if checkpoint.get("semantic_plan") is not None and not discovery_delivery(
                        checkpoint
                    ):
                        # One content assessment per 90s slice fits the existing
                        # 120s lease; progressive sharing runs after each commit.
                        break
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
