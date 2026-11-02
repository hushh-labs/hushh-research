"""Pure Calendar-relevance rules for follow-up candidates.

A gene: import-safe, deterministic and free of provider or model access. The
semantic decision (is this a request that belongs on the owner's Calendar?)
is made by the typed Email extraction child. This module only enforces the
structured contract around that decision, so a missing, malformed or
contradictory verdict can never become a task, and so repeated phrasings of
one request collapse into one.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Literal, Protocol, TypeVar

# Bump when the extraction contract changes. Messages assessed under an older
# version are re-assessed once, so earlier misclassifications can be corrected.
ASSESSMENT_VERSION = 2

Relevance = Literal["actionable", "informational", "uncertain"]
Category = Literal[
    "meeting_request",
    "schedule_change",
    "document_or_information",
    "deliverable_deadline",
    "response_needed",
    "assigned_task",
    "account_security",
    "marketing",
    "receipt_or_status",
    "other",
]
MeetingState = Literal["proposed", "confirmed", "none"]
Urgency = Literal["asap", "time_bound", "none"]

# The only categories that describe a request tied to the owner's schedule or
# responsibilities. Everything else is, by definition, not Calendar work.
CALENDAR_CATEGORIES: frozenset[str] = frozenset(
    {
        "meeting_request",
        "schedule_change",
        "document_or_information",
        "deliverable_deadline",
        "response_needed",
        "assigned_task",
    }
)

DROP_NOT_RELEVANT = "not_calendar_relevant"
DROP_NOT_OWNER = "not_owner_responsibility"
DROP_QUOTED = "quoted_or_signature"
DROP_DUPLICATE = "duplicate"
DROP_NO_EVIDENCE = "missing_evidence"


def surfaceable(
    *,
    relevance: str | None,
    category: str | None,
    responsibility: str,
    evidence_reason: str | None,
) -> str | None:
    """Return the reason a candidate must be dropped, or None to keep it.

    Surfacing needs all of: an explicit ``actionable`` verdict, a Calendar
    category, a stated reason, and responsibility that is not assigned to
    someone else. ``uncertain`` is kept out of the owner's list on purpose: an
    unexplained guess is exactly how a security notice reached the card.
    """
    if relevance != "actionable" or category not in CALENDAR_CATEGORIES:
        return DROP_NOT_RELEVANT
    if not (evidence_reason or "").strip():
        return DROP_NO_EVIDENCE
    if responsibility == "other":
        return DROP_NOT_OWNER
    return None


# Only unambiguous reply boundaries. A bare "From:" line or a forwarded-message
# marker is not one: a forwarded request is still a request to the owner.
_REPLY_HEADER = re.compile(
    r"^\s*(?:on\s.{5,200}\swrote:|-{2,}\s*original message\s*-{2,})\s*$",
    re.IGNORECASE,
)
# A rule of underscores opens a quoted reply only when the quoted header block
# follows it (Outlook). Elsewhere it is a visual divider, and what is below a
# divider is still part of the message.
_RULE = re.compile(r"^\s*_{5,}\s*$")
_QUOTED_HEADER = re.compile(r"^\s*(?:from|sent|date|to|cc|subject)\s*:", re.IGNORECASE)
# A signature is a short closing block; a long remainder after "--" is content.
_SIGNATURE_MAX_LINES = 12
_DEVICE_SIGNATURE = re.compile(
    r"^\s*(?:sent from my .{2,40}|get outlook for .{2,20}|sent via .{2,40})\s*$", re.IGNORECASE
)


def _is_signature_tail(lines: Sequence[str], start: int) -> bool:
    count = 0
    for line in lines[start:]:
        if line.strip():
            count += 1
            if count > _SIGNATURE_MAX_LINES:
                return False
    return True


def _quoted_header_follows(lines: Sequence[str], start: int) -> bool:
    for line in lines[start:]:
        if line.strip():
            return bool(_QUOTED_HEADER.match(line))
    return False


def quoted_or_signature_regions(body: str) -> tuple[tuple[int, int], ...]:
    """Spans of quoted earlier mail and signature blocks, as body offsets.

    A request inside such a span is repeated text, not a new request: the
    earlier message that actually contained it is assessed on its own.
    """
    regions: list[tuple[int, int]] = []
    offset = 0
    tail_start: int | None = None
    lines = body.split("\n")
    for index, line in enumerate(lines):
        end = offset + len(line)
        stripped = line.strip()
        if tail_start is None:
            if stripped.startswith(">"):
                regions.append((offset, end))
            elif (
                (stripped == "--" and _is_signature_tail(lines, index + 1))
                or _REPLY_HEADER.match(line)
                or (_RULE.match(line) and _quoted_header_follows(lines, index + 1))
            ):
                tail_start = offset
            elif _DEVICE_SIGNATURE.match(line):
                regions.append((offset, end))
        offset = end + 1
    if tail_start is not None:
        regions.append((tail_start, len(body)))
    return tuple(regions)


def inside_region(start: int, end: int, regions: Sequence[tuple[int, int]]) -> bool:
    return any(region_start <= start and end <= region_end for region_start, region_end in regions)


_STOPWORDS = frozenset(
    "a an and are as at be by for from in is it of on or please so that the this to we you your "
    "with can could would will do dont not forget remember reminder just also kindly".split()
)


def _stem(token: str) -> str:
    for suffix in ("ing", "ed", "es", "s"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def title_tokens(title: str) -> frozenset[str]:
    words = re.findall(r"[a-z0-9]+", title.casefold())
    return frozenset(_stem(word) for word in words if word not in _STOPWORDS)


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def similar_titles(left: str, right: str) -> bool:
    """True when two titles word the same obligation (the same bar as ``same_request``)."""
    return _jaccard(title_tokens(left), title_tokens(right)) >= 0.5


class _Dedupable(Protocol):
    kind: str
    title: str
    due_date: str | None
    proposed_date: str | None
    proposed_at: str | None
    global_quote_start: int
    original_due_wording: str | None


_C = TypeVar("_C", bound=_Dedupable)


def same_request(left: _Dedupable, right: _Dedupable) -> bool:
    """True when two candidates are one obligation phrased twice.

    Different kinds or different dates are different obligations, whatever the
    wording. Equal dates with strongly overlapping titles are one obligation.
    """
    if left.kind != right.kind:
        return False
    if (left.due_date, left.proposed_date, left.proposed_at) != (
        right.due_date,
        right.proposed_date,
        right.proposed_at,
    ):
        return False
    return _jaccard(title_tokens(left.title), title_tokens(right.title)) >= 0.5


def _completeness(item: _Dedupable) -> int:
    return sum(
        value is not None
        for value in (
            item.due_date,
            item.proposed_date,
            item.proposed_at,
            item.original_due_wording,
        )
    )


def dedupe(candidates: Iterable[_C]) -> tuple[list[_C], int]:
    """Merge repeated phrasings, keeping the most complete, earliest statement."""
    kept: list[_C] = []
    dropped = 0
    for item in sorted(candidates, key=lambda candidate: candidate.global_quote_start):
        for index, existing in enumerate(kept):
            if same_request(existing, item):
                dropped += 1
                if _completeness(item) > _completeness(existing):
                    kept[index] = item
                break
        else:
            kept.append(item)
    return kept, dropped


_URL = re.compile(r"<?\bhttps?://[^\s<>]+>?", re.IGNORECASE)
_IMAGE = re.compile(r"\[image:[^\]]{0,120}\]", re.IGNORECASE)
_ADDRESS_ONLY = re.compile(r"^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$")


def sanitize_excerpt(text: str, *, limit: int = 240) -> str:
    """Brief human-readable evidence: no links, tracking URLs or placeholders."""
    cleaned = _IMAGE.sub(" ", _URL.sub(" ", text or ""))
    lines = [" ".join(line.split()) for line in cleaned.splitlines()]
    lines = [line for line in lines if line and not _ADDRESS_ONLY.match(line)]
    flat = " ".join(lines)
    if len(flat) <= limit:
        return flat
    cut = flat[:limit].rsplit(" ", 1)[0].rstrip(",;:-")
    return cut + "…"


def sanitize_source_body(text: str, *, limit: int = 20000) -> str:
    """The authorized full-source view without tracking links or image markers.

    Links are replaced rather than shown: long redirect and tracking URLs are
    noise to a reader and can identify the recipient. The original email stays
    one tap away in Gmail.
    """
    cleaned = _IMAGE.sub("", _URL.sub("[link]", text or ""))
    lines = [line.rstrip() for line in cleaned.splitlines()]
    flat = "\n".join(lines)
    while "\n\n\n" in flat:
        flat = flat.replace("\n\n\n", "\n\n")
    flat = flat.strip()
    return flat if len(flat) <= limit else flat[:limit].rstrip() + "\n…"
