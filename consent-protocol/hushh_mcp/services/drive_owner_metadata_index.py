"""Gear 1 of owner Drive search: a local name index matched without any model.

Gear 1 lists the owner's Drive metadata (names, types, dates; never content)
and matches request concepts against file names in memory with typo, prefix,
substring, camelCase and underscore tolerance, the parts of Drive app search
that the REST ``name contains`` operator cannot do. Gear 2 stays the REST
``fullText contains`` pass-through for words inside documents. Nothing here
calls Gemini or Vertex, reads file content, grants access or wakes a job.

Contract for the request brain (drive_owner_search_* owner)::

    result = await match_owner_files(
        owner_id,
        concepts,              # [["statement", "stmt"], "schwab"]: concepts AND, variants OR
        period,                # {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "timezone": tz} | None
        connection_generation=job["connection_generation"],
        precedence=True,       # autoshare rule: title date, else created, else modified
        mime_filter=None,      # Callable[[str], bool]; e.g. the request kind rule
        limit=1000,
        max_pages=12,          # provider pages this call may list
        deadline_seconds=45,   # soft budget for listing in this call
        require_current=None,  # async fence check run before and after each provider page
    )
    result.candidates   # tuple[MetadataCandidate], best first
    result.ready        # every corpus has been listed at least once
    result.complete     # ready, and Drive reported no incompleteSearch / invalid rows

    vocabulary = await owner_vocabulary(owner_id, connection_generation=...)  # set[str]

Each ``MetadataCandidate.file`` is the provider row exactly as
``GoogleDriveRestTransport.read_owner_search_page("search_files")`` returns it,
so the caller can pass candidates through its existing shortcut, kind,
shareability and period checks unchanged. ``listing_day``/``date_basis`` say
which date decided the period (see ``drive_title_dates``). A candidate is
never proof that the file may be shared; sharing re-verifies every file.

Listing reuses the fenced owner-search page operation (pageSize up to 1000,
the LIST_FIELDS mask, ``corpora=user`` then each shared drive with
``corpora=drive``), so the owner, grant, rollout and generation checks wrap
every call. Results stay in this process only, keyed by owner and connection
generation, bounded in owners, files and age, and are never written to disk,
the database or logs. Logs carry counts and timings only.
"""

from __future__ import annotations

import asyncio
import bisect
import hashlib
import re
import sys
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.drive_title_dates import (
    PeriodDecision,
    RawTitleDates,
    parse_title_dates,
    period_decision,
)
from hushh_mcp.services.google_drive_adapter import FILE_ID, RESOURCE_KEY, DriveReadError

logger = drive_logger("drive_owner_metadata_index")

LISTING_QUERY = "trashed = false"
# createdTime never changes, so a file cannot move between pages while the
# listing walks them (a modifiedTime walk can skip a file edited mid-listing).
LISTING_ORDER = "createdTime desc"
PAGE_SIZES = (1000, 100, 25)
DRIVES_PAGE_SIZE = 25
DEFAULT_MAX_PAGES = 12
DEFAULT_DEADLINE_SECONDS = 45
DEFAULT_LIMIT = 1000
MAX_LIMIT = 10000
MAX_CACHED_OWNERS = 3
MAX_INDEX_FILES = 200_000
MAX_TOKENS_SEEN = 1000
INDEX_TTL_SECONDS = 1800
FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
_SAFE_ERRORS = frozenset(
    {
        "provider_unavailable",
        "provider_response_invalid",
        "reconnect_required",
        "connection_changed",
        "connector_unavailable",
        "source_unavailable",
        "file_too_large",
        "invalid_argument",
    }
)

# Token match scores. Exact words outrank spelling forms, prefixes ("state"
# for "statement", like Drive's own name search), inner words and typos.
_EXACT, _PLURAL, _JOINED, _TYPO_PREFIX = 1.0, 0.95, 0.97, 0.55
_PHRASE_BONUS = 0.03
_STOPWORDS = frozenset(
    {"a", "an", "and", "all", "any", "by", "for", "from", "in", "my", "of", "on", "or", "the"}
    | {"to", "with"}
)
_EXTENSION = re.compile(r"\.(?=[A-Za-z0-9]{0,4}[A-Za-z])[A-Za-z0-9]{1,5}$")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_NON_WORD = re.compile(r"[\W_]+")
_ALNUM_PARTS = re.compile(r"[^\W\d_]+|\d+")


def _fold(text: str) -> str:
    """Lowercase and drop accents: "Résumé" and "RESUME" both become "resume"."""
    if text.isascii():
        return text.lower()
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def name_tokens(name: str) -> tuple[tuple[str, ...], str]:
    """Searchable words of a file name, and its words joined as one phrase.

    "Q3_BankStatement-final.PDF" gives q3, bank, statement, final, q, 3 and
    the compound bankstatement: the extension goes, camelCase, underscores and
    hyphens split, letter/digit runs split, and accents fold.
    """
    stem = _EXTENSION.sub("", name) or name
    spaced = _CAMEL.sub(" ", stem)
    words = [word for word in _NON_WORD.split(_fold(spaced)) if word]
    tokens = dict.fromkeys(words)
    for word in words:
        if not word.isalpha() and not word.isdigit():
            tokens.update(dict.fromkeys(_ALNUM_PARTS.findall(word)))
    if spaced != stem:
        tokens.update(dict.fromkeys(word for word in _NON_WORD.split(_fold(stem)) if word))
    return tuple(sys.intern(token) for token in tokens), " ".join(words)


def _concept_tokens(text: str) -> tuple[str, ...]:
    words = [word for word in _NON_WORD.split(_fold(_CAMEL.sub(" ", text))) if word]
    kept = [word for word in words if word not in _STOPWORDS]
    return tuple(dict.fromkeys(kept or words))


def _plural_forms(token: str) -> set[str]:
    forms = {token + "s", token + "es"}
    if token.endswith("ies") and len(token) > 4:
        forms.add(token[:-3] + "y")
    elif token.endswith("es") and len(token) > 3:
        forms.update({token[:-2], token[:-1]})
    elif token.endswith("s") and len(token) > 3 and not token.endswith("ss"):
        forms.add(token[:-1])
    if token.endswith("y") and len(token) > 2:
        forms.add(token[:-1] + "ies")
    forms.discard(token)
    return forms


def _grams(token: str) -> set[str]:
    padded = f"${token}$"
    return {padded[index : index + 3] for index in range(len(padded) - 2)}


def _inner_grams(token: str) -> set[str]:
    return {token[index : index + 3] for index in range(len(token) - 2)}


def _bounded_distance(left: str, right: str, bound: int) -> int:
    """Optimal string alignment distance, or bound + 1 once it must exceed bound."""
    if abs(len(left) - len(right)) > bound:
        return bound + 1
    previous2: list[int] = []
    previous = list(range(len(right) + 1))
    for i, lc in enumerate(left, 1):
        current = [i] + [0] * len(right)
        best = current[0]
        for j, rc in enumerate(right, 1):
            cost = 0 if lc == rc else 1
            value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if i > 1 and j > 1 and lc == right[j - 2] and left[i - 2] == rc:
                value = min(value, previous2[j - 2] + 1)
            current[j] = value
            best = min(best, value)
        if best > bound:
            return bound + 1
        previous2, previous = previous, current
    return previous[-1]


@dataclass(slots=True)
class _Entry:
    ordinal: int
    file_id: str
    name: str
    mime: str | None
    created: str | None
    modified: str | None
    view_url: str | None
    drive_id: str | None
    resource_key: str | None
    shortcut: dict | None
    capabilities: dict | None
    encryption: dict | None
    tokens: tuple[str, ...]
    phrase: str
    title_dates: RawTitleDates

    def provider_row(self) -> dict:
        """The exact owner-search projection this entry was built from."""
        return {
            "id": self.file_id,
            "title": self.name,
            "mimeType": self.mime,
            "modifiedTime": self.modified,
            "createdTime": self.created,
            **({"driveId": self.drive_id} if self.drive_id is not None else {}),
            **({"resourceKey": self.resource_key} if self.resource_key is not None else {}),
            "viewUrl": self.view_url,
            **({"shortcutDetails": dict(self.shortcut)} if self.shortcut is not None else {}),
            **({"capabilities": dict(self.capabilities)} if self.capabilities is not None else {}),
            **(
                {"clientEncryptionDetails": dict(self.encryption)}
                if self.encryption is not None
                else {}
            ),
        }


def _entry(ordinal: int, row: object) -> _Entry | None:
    """Validate one projected provider row; None when it cannot be trusted."""
    if not isinstance(row, dict):
        return None
    file_id, name, mime = row.get("id"), row.get("title"), row.get("mimeType")
    created, modified, view = row.get("createdTime"), row.get("modifiedTime"), row.get("viewUrl")
    drive, key = row.get("driveId"), row.get("resourceKey")
    shortcut = row.get("shortcutDetails")
    capabilities = row.get("capabilities")
    encryption = row.get("clientEncryptionDetails")
    if (
        not isinstance(file_id, str)
        or not FILE_ID.fullmatch(file_id)
        or not isinstance(name, str)
        or not 1 <= len(name) <= 1024
        or mime is not None
        and (not isinstance(mime, str) or len(mime) > 200)
        or any(
            value is not None and (not isinstance(value, str) or len(value) > 64)
            for value in (created, modified)
        )
        or view is not None
        and (not isinstance(view, str) or len(view) > 2048)
        or drive is not None
        and (not isinstance(drive, str) or not FILE_ID.fullmatch(drive))
        or key is not None
        and (not isinstance(key, str) or not RESOURCE_KEY.fullmatch(key))
        or shortcut is not None
        and not isinstance(shortcut, dict)
        or capabilities is not None
        and not isinstance(capabilities, dict)
        or encryption is not None
        and not isinstance(encryption, dict)
    ):
        return None
    tokens, phrase = name_tokens(name)
    return _Entry(
        ordinal=ordinal,
        file_id=file_id,
        name=name,
        mime=sys.intern(mime) if isinstance(mime, str) else None,
        created=created,
        modified=modified,
        view_url=view,
        drive_id=sys.intern(drive) if drive is not None else None,
        resource_key=key,
        shortcut=dict(shortcut) if shortcut is not None else None,
        capabilities=dict(capabilities) if capabilities is not None else None,
        encryption=dict(encryption) if encryption is not None else None,
        tokens=tokens,
        phrase=phrase,
        title_dates=parse_title_dates(name),
    )


@dataclass(frozen=True, slots=True)
class MetadataCandidate:
    file: dict
    score: float
    matched: tuple[str, ...]
    listing_day: str | None
    date_basis: str


@dataclass(frozen=True, slots=True)
class MetadataMatchResult:
    candidates: tuple[MetadataCandidate, ...]
    ready: bool
    complete: bool
    indexed: int
    total_matches: int
    elapsed_ms: float


@dataclass(frozen=True, slots=True)
class _Variant:
    tokens: tuple[str, ...]
    joined: str | None
    phrase: str


def _parse_concepts(concepts: Sequence[str | Sequence[str]]) -> list[list[_Variant]]:
    if isinstance(concepts, str) or not isinstance(concepts, Sequence):
        raise DriveReadError("invalid_argument")
    parsed = []
    for concept in concepts:
        variants = [concept] if isinstance(concept, str) else concept
        if not isinstance(variants, Sequence) or any(not isinstance(v, str) for v in variants):
            raise DriveReadError("invalid_argument")
        kept = []
        for variant in variants:
            tokens = _concept_tokens(variant[:200])
            if tokens:
                joined = "".join(tokens) if len(tokens) > 1 else None
                kept.append(_Variant(tokens, joined, " ".join(tokens)))
        if kept:
            parsed.append(kept)
    if len(parsed) > 12 or sum(len(variants) for variants in parsed) > 64:
        raise DriveReadError("invalid_argument")
    return parsed


class OwnerMetadataIndex:
    """One owner's Drive names in memory, with a fuzzy vocabulary index."""

    def __init__(self) -> None:
        self._entries: list[_Entry | None] = []
        self._by_id: dict[str, int] = {}
        self._postings: dict[str, set[int]] = {}
        self._grams: dict[str, set[str]] = {}
        self._sorted: list[str] | None = None

    def __len__(self) -> int:
        return len(self._by_id)

    def _add_token(self, token: str, ordinal: int) -> None:
        posting = self._postings.get(token)
        if posting is None:
            self._postings[token] = {ordinal}
            self._sorted = None
            if len(token) >= 3 and not token.isdigit():
                for gram in _grams(token):
                    self._grams.setdefault(gram, set()).add(token)
        else:
            posting.add(ordinal)

    def _drop_token(self, token: str, ordinal: int) -> None:
        posting = self._postings.get(token)
        if posting is None:
            return
        posting.discard(ordinal)
        if not posting:
            del self._postings[token]
            self._sorted = None
            if len(token) >= 3 and not token.isdigit():
                for gram in _grams(token):
                    tokens = self._grams.get(gram)
                    if tokens is not None:
                        tokens.discard(token)
                        if not tokens:
                            del self._grams[gram]

    def upsert(self, row: object) -> bool:
        """Add or replace one provider row; False when the row is invalid."""
        entry = _entry(len(self._entries), row)
        if entry is None:
            return False
        self.remove(entry.file_id)
        self._entries.append(entry)
        self._by_id[entry.file_id] = entry.ordinal
        for token in entry.tokens:
            self._add_token(token, entry.ordinal)
        return True

    def remove(self, file_id: str) -> None:
        ordinal = self._by_id.pop(file_id, None)
        if ordinal is None:
            return
        entry = self._entries[ordinal]
        self._entries[ordinal] = None
        if entry is not None:
            for token in entry.tokens:
                self._drop_token(token, ordinal)

    def vocabulary(self) -> set[str]:
        return set(self._postings)

    def _vocabulary_sorted(self) -> list[str]:
        if self._sorted is None:
            self._sorted = sorted(self._postings)
        return self._sorted

    def _expand(self, token: str) -> dict[str, tuple[float, str]]:
        """Vocabulary words this concept word should match, with a score each."""
        found: dict[str, tuple[float, str]] = {}

        def keep(word: str, score: float, kind: str) -> None:
            if word not in found or score > found[word][0]:
                found[word] = (score, kind)

        if token in self._postings:
            keep(token, _EXACT, "exact")
        if token.isdigit() or len(token) < 3:
            return found
        for form in _plural_forms(token):
            if form in self._postings:
                keep(form, _PLURAL, "plural")
        vocabulary = self._vocabulary_sorted()
        start = bisect.bisect_left(vocabulary, token)
        for word in vocabulary[start:]:
            if not word.startswith(token):
                break
            if word != token:
                keep(word, 0.75 + 0.2 * len(token) / len(word), "prefix")
        if len(token) >= 4:
            inner = sorted((self._grams.get(gram, set()) for gram in _inner_grams(token)), key=len)
            if inner and inner[0]:
                for word in inner[0].intersection(*inner[1:]):
                    if token in word and not word.startswith(token):
                        keep(word, 0.6 + 0.2 * len(token) / len(word), "substring")
        if found or len(token) < 4 or not token.isalpha():
            return found
        # Spelling tolerance only for a word the owner's Drive does not have,
        # so a real word is never diluted by its near neighbours.
        bound = 1 if len(token) < 8 else 2
        grams = _grams(token)
        shared: dict[str, int] = {}
        for gram in grams:
            for word in self._grams.get(gram, ()):
                shared[word] = shared.get(word, 0) + 1
        floor = max(1, len(grams) - 3 * bound - 1)
        for word, count in shared.items():
            if count < floor:
                continue
            distance = _bounded_distance(token, word, bound)
            if distance <= bound:
                keep(word, 0.8 - 0.1 * distance, "typo")
            elif len(word) > len(token) and len(token) >= 5:
                prefix = min(
                    _bounded_distance(token, word[:size], 1)
                    for size in (len(token) - 1, len(token), len(token) + 1)
                )
                if prefix <= 1:
                    keep(word, _TYPO_PREFIX, "typo_prefix")
        return found

    def _token_scores(self, token: str) -> dict[int, tuple[float, str]]:
        scores: dict[int, tuple[float, str]] = {}
        for word, (score, kind) in self._expand(token).items():
            for ordinal in self._postings[word]:
                current = scores.get(ordinal)
                if current is None or score > current[0]:
                    scores[ordinal] = (score, kind)
        return scores

    def _variant_scores(self, variant: _Variant) -> dict[int, tuple[float, str]]:
        per_token = sorted((self._token_scores(token) for token in variant.tokens), key=len)
        scores: dict[int, tuple[float, str]] = {}
        if per_token and per_token[0]:
            common = per_token[0].keys()
            for other in per_token[1:]:
                common = common & other.keys()
            for ordinal in common:
                values = [scores_by_token[ordinal] for scores_by_token in per_token]
                weakest = min(values, key=lambda value: value[0])
                scores[ordinal] = (sum(value[0] for value in values) / len(values), weakest[1])
        if variant.joined is not None:
            # "meeting notes" also finds the single word "meetingnotes".
            for word, (score, _) in self._expand(variant.joined).items():
                for ordinal in self._postings[word]:
                    value = (_JOINED * score, "joined")
                    if ordinal not in scores or value[0] > scores[ordinal][0]:
                        scores[ordinal] = value
        return scores

    def match(
        self,
        concepts: Sequence[str | Sequence[str]],
        period: dict | None = None,
        *,
        precedence: bool = True,
        mime_filter: Callable[[str], bool] | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[MetadataCandidate], int]:
        """Ranked name matches for every concept, inside the period; and their count."""
        if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
            raise DriveReadError("invalid_argument")
        parsed = _parse_concepts(concepts)
        if not parsed:
            return [], 0
        per_concept: list[dict[int, tuple[float, str]]] = []
        for variants in parsed:
            best: dict[int, tuple[float, str]] = {}
            for variant in variants:
                for ordinal, value in self._variant_scores(variant).items():
                    if ordinal not in best or value[0] > best[ordinal][0]:
                        best[ordinal] = value
            if not best:
                return [], 0
            per_concept.append(best)
        ordered = sorted(per_concept, key=len)
        survivors = ordered[0].keys()
        for other in ordered[1:]:
            survivors = survivors & other.keys()
        phrases = [variant.phrase for variants in parsed for variant in variants]
        ranked = []
        for ordinal in survivors:
            entry = self._entries[ordinal]
            if entry is None or mime_filter is not None and not mime_filter(entry.mime or ""):
                continue
            decision: PeriodDecision = period_decision(
                {
                    "name": entry.name,
                    "created_time": entry.created,
                    "modified_time": entry.modified,
                },
                period,
                precedence=precedence,
                raw=entry.title_dates,
            )
            if not decision.in_period:
                continue
            score = sum(concept[ordinal][0] for concept in per_concept) / len(per_concept)
            if any(phrase in entry.phrase for phrase in phrases if " " in phrase):
                score += _PHRASE_BONUS
            ranked.append(
                (
                    min(1.0, round(score, 4)),
                    entry,
                    decision,
                    tuple(concept[ordinal][1] for concept in per_concept),
                )
            )
        # Stable passes: best score, then newest deciding date, then newest
        # edit, then file ID, so equal inputs always rank identically.
        ranked.sort(key=lambda item: item[1].file_id)
        ranked.sort(key=lambda item: item[1].modified or "", reverse=True)
        ranked.sort(key=lambda item: item[2].listing_day or "", reverse=True)
        ranked.sort(key=lambda item: item[0], reverse=True)
        return [
            MetadataCandidate(
                file=entry.provider_row(),
                score=score,
                matched=kinds,
                listing_day=decision.listing_day,
                date_basis=decision.basis,
            )
            for score, entry, decision, kinds in ranked[:limit]
        ], len(ranked)


@dataclass(slots=True)
class _OwnerState:
    generation: int
    index: OwnerMetadataIndex = field(default_factory=OwnerMetadataIndex)
    phase: str = "user"
    page_token: str | None = None
    drives_token: str | None = None
    drive_queue: list[str] = field(default_factory=list)
    drives_done: set[str] = field(default_factory=set)
    drives_listed: bool = False
    seen_tokens: list[str] = field(default_factory=list)
    page_size: int = PAGE_SIZES[0]
    incomplete: bool = False
    pages: int = 0
    rows: int = 0
    built_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def ready(self) -> bool:
        return self.phase == "ready"


@dataclass(frozen=True, slots=True)
class IndexStatus:
    ready: bool
    complete: bool
    indexed: int
    pages: int


def _status(state: _OwnerState) -> IndexStatus:
    return IndexStatus(
        ready=state.ready,
        complete=state.ready and not state.incomplete,
        indexed=len(state.index),
        pages=state.pages,
    )


def _next_token(payload: dict, state: _OwnerState, current: str | None) -> str | None:
    token = payload.get("nextPageToken")
    if token is None or token == "":
        return None
    if not isinstance(token, str) or len(token) > 1024:
        raise DriveReadError("provider_response_invalid")
    digest = hashlib.sha256(token.encode()).hexdigest()
    if token == current or digest in state.seen_tokens or len(state.seen_tokens) >= MAX_TOKENS_SEEN:
        raise DriveReadError("provider_response_invalid")
    state.seen_tokens.append(digest)
    return token


class OwnerMetadataIndexer:
    """Builds and caches each owner's index through the fenced listing operation."""

    def __init__(
        self,
        transport: Any = None,
        *,
        max_owners: int = MAX_CACHED_OWNERS,
        ttl_seconds: float = INDEX_TTL_SECONDS,
        max_files: int = MAX_INDEX_FILES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport
        self._owners: OrderedDict[str, _OwnerState] = OrderedDict()
        self._max_owners = max_owners
        self._ttl = ttl_seconds
        self._max_files = max_files
        self._clock = clock

    def _listing(self) -> Callable[..., Awaitable[Any]]:
        if self._transport is None:
            from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

            self._transport = GoogleDriveRestTransport()
        return self._transport.read_owner_search_page

    def _state(self, owner_id: str, generation: int) -> _OwnerState:
        if not isinstance(owner_id, str) or not 1 <= len(owner_id) <= 255:
            raise DriveReadError("invalid_argument")
        if type(generation) is not int or generation < 1:
            raise DriveReadError("invalid_argument")
        state = self._owners.get(owner_id)
        expired = (
            state is not None
            and state.built_at is not None
            and self._clock() - state.built_at > self._ttl
        )
        if state is None or state.generation != generation or expired:
            # A reconnect, a new generation or an old snapshot starts over;
            # names listed under another grant are never reused.
            state = _OwnerState(generation=generation)
            self._owners[owner_id] = state
        self._owners.move_to_end(owner_id)
        while len(self._owners) > self._max_owners:
            self._owners.popitem(last=False)
        return state

    def forget(self, owner_id: str) -> None:
        self._owners.pop(owner_id, None)

    def clear(self) -> None:
        self._owners.clear()

    async def _page(self, owner_id: str, state: _OwnerState, require_current) -> None:
        listing = self._listing()
        if state.phase == "drives":
            arguments: dict[str, Any] = {"pageSize": DRIVES_PAGE_SIZE}
            if state.drives_token:
                arguments["pageToken"] = state.drives_token
            if require_current is not None:
                await require_current()
            result = await listing(
                user_id=owner_id, tool_name="list_shared_drives", arguments=arguments
            )
            if require_current is not None:
                await require_current()
            payload = result.payload
            drives = payload.get("drives") if isinstance(payload, dict) else None
            if (
                result.is_error
                or result.truncated
                or not isinstance(drives, list)
                or len(drives) > DRIVES_PAGE_SIZE
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("id"), str)
                    or not FILE_ID.fullmatch(item["id"])
                    for item in drives
                )
            ):
                raise DriveReadError("provider_response_invalid")
            state.drives_token = _next_token(payload, state, state.drives_token)
            for item in drives:
                if item["id"] not in state.drive_queue and item["id"] not in state.drives_done:
                    state.drive_queue.append(item["id"])
            state.pages += 1
            if not state.drives_token:
                state.drives_listed = True
            self._advance(state)
            return
        arguments = {
            "query": LISTING_QUERY,
            "orderBy": LISTING_ORDER,
            "pageSize": state.page_size,
        }
        if state.page_token:
            arguments["pageToken"] = state.page_token
        if state.phase == "drive":
            arguments["driveId"] = state.drive_queue[0]
        while True:
            if require_current is not None:
                await require_current()
            try:
                result = await listing(
                    user_id=owner_id, tool_name="search_files", arguments=arguments
                )
                break
            except DriveReadError as error:
                if str(error) != "file_too_large" or state.page_size == PAGE_SIZES[-1]:
                    raise
                # Same cursor, less metadata: a page over the response budget
                # never advances the listing or loses its rows.
                state.page_size = PAGE_SIZES[PAGE_SIZES.index(state.page_size) + 1]
                arguments["pageSize"] = state.page_size
        if require_current is not None:
            await require_current()
        payload = result.payload
        if not isinstance(payload, dict):
            raise DriveReadError("provider_response_invalid")
        files = payload.get("files")
        incomplete = payload.get("incompleteSearch", False)
        if (
            result.is_error
            or result.truncated
            or payload.get("overLimit") is True
            or type(incomplete) is not bool
            or not isinstance(files, list)
            or len(files) > state.page_size
        ):
            raise DriveReadError("provider_response_invalid")
        next_token = _next_token(payload, state, state.page_token)
        for row in files:
            if len(state.index) >= self._max_files:
                incomplete = True
                next_token = None
                state.drive_queue.clear()
                state.drives_listed = True
                break
            if not state.index.upsert(row):
                incomplete = True
        state.incomplete = state.incomplete or incomplete
        state.rows += len(files)
        state.pages += 1
        state.page_token = next_token
        if not next_token:
            state.seen_tokens.clear()
            if state.phase == "drive":
                state.drives_done.add(state.drive_queue.pop(0))
            self._advance(state)

    @staticmethod
    def _advance(state: _OwnerState) -> None:
        """user -> drives (pages of drive IDs) -> drive (each drive) -> ready."""
        if state.phase == "user":
            state.phase = "drives"
        elif state.phase in {"drives", "drive"}:
            if state.drive_queue:
                state.phase = "drive"
            elif state.drives_listed:
                state.phase = "ready"
            else:
                state.phase = "drives"
        state.page_token = None

    async def refresh(
        self,
        owner_id: str,
        *,
        connection_generation: int,
        max_pages: int = DEFAULT_MAX_PAGES,
        deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
        require_current: Callable[[], Awaitable[object]] | None = None,
    ) -> IndexStatus:
        """List at most ``max_pages`` pages toward a complete index, then stop.

        Progress is kept between calls in this process, so a large Drive
        builds over several request slices and early pages are usable at once.
        Provider errors propagate after the listing keeps its last good page.
        """
        if type(max_pages) is not int or not 0 <= max_pages <= 200:
            raise DriveReadError("invalid_argument")
        state = self._state(owner_id, connection_generation)
        started = time.perf_counter()
        pages_before, outcome = state.pages, "ok"
        async with state.lock:
            try:
                deadline = self._clock() + deadline_seconds
                while (
                    not state.ready
                    and state.pages - pages_before < max_pages
                    and self._clock() < deadline
                ):
                    await self._page(owner_id, state, require_current)
                if state.ready and state.built_at is None:
                    state.built_at = self._clock()
            except asyncio.CancelledError:
                outcome = "cancelled"
                raise
            except Exception as error:
                outcome = str(error) if str(error) in _SAFE_ERRORS else "error"
                raise
            finally:
                logger.info(
                    "drive_metadata_index.refresh outcome=%s pages=%d entries=%d ready=%d "
                    "complete=%d duration_ms=%.1f",
                    outcome,
                    state.pages - pages_before,
                    len(state.index),
                    int(state.ready),
                    int(state.ready and not state.incomplete),
                    (time.perf_counter() - started) * 1000,
                )
        return _status(state)

    async def match(
        self,
        owner_id: str,
        concepts: Sequence[str | Sequence[str]],
        period: dict | None,
        *,
        connection_generation: int,
        precedence: bool = True,
        mime_filter: Callable[[str], bool] | None = None,
        limit: int = DEFAULT_LIMIT,
        max_pages: int = DEFAULT_MAX_PAGES,
        deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
        require_current: Callable[[], Awaitable[object]] | None = None,
    ) -> MetadataMatchResult:
        status = await self.refresh(
            owner_id,
            connection_generation=connection_generation,
            max_pages=max_pages,
            deadline_seconds=deadline_seconds,
            require_current=require_current,
        )
        state = self._state(owner_id, connection_generation)
        started = time.perf_counter()
        candidates, total = state.index.match(
            concepts, period, precedence=precedence, mime_filter=mime_filter, limit=limit
        )
        elapsed = (time.perf_counter() - started) * 1000
        logger.info(
            "drive_metadata_index.match concepts=%d matches=%d returned=%d ready=%d "
            "duration_ms=%.2f",
            len(concepts),
            total,
            len(candidates),
            int(status.ready),
            elapsed,
        )
        return MetadataMatchResult(
            candidates=tuple(candidates),
            ready=status.ready,
            complete=status.complete,
            indexed=status.indexed,
            total_matches=total,
            elapsed_ms=elapsed,
        )

    async def vocabulary(
        self,
        owner_id: str,
        *,
        connection_generation: int,
        max_pages: int = DEFAULT_MAX_PAGES,
        deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
        require_current: Callable[[], Awaitable[object]] | None = None,
    ) -> set[str]:
        await self.refresh(
            owner_id,
            connection_generation=connection_generation,
            max_pages=max_pages,
            deadline_seconds=deadline_seconds,
            require_current=require_current,
        )
        return self._state(owner_id, connection_generation).index.vocabulary()


_DEFAULT_INDEXER = OwnerMetadataIndexer()


async def match_owner_files(
    owner_id: str,
    concepts: Sequence[str | Sequence[str]],
    period: dict | None,
    *,
    connection_generation: int,
    precedence: bool = True,
    mime_filter: Callable[[str], bool] | None = None,
    limit: int = DEFAULT_LIMIT,
    max_pages: int = DEFAULT_MAX_PAGES,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
    require_current: Callable[[], Awaitable[object]] | None = None,
    indexer: OwnerMetadataIndexer | None = None,
) -> MetadataMatchResult:
    """Gear 1 candidates for one owner request; see the module contract."""
    return await (indexer or _DEFAULT_INDEXER).match(
        owner_id,
        concepts,
        period,
        connection_generation=connection_generation,
        precedence=precedence,
        mime_filter=mime_filter,
        limit=limit,
        max_pages=max_pages,
        deadline_seconds=deadline_seconds,
        require_current=require_current,
    )


async def owner_vocabulary(
    owner_id: str,
    *,
    connection_generation: int,
    max_pages: int = DEFAULT_MAX_PAGES,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
    require_current: Callable[[], Awaitable[object]] | None = None,
    indexer: OwnerMetadataIndexer | None = None,
) -> set[str]:
    """Every normalized word in the owner's file names, for spelling repair."""
    return await (indexer or _DEFAULT_INDEXER).vocabulary(
        owner_id,
        connection_generation=connection_generation,
        max_pages=max_pages,
        deadline_seconds=deadline_seconds,
        require_current=require_current,
    )


def forget_owner(owner_id: str) -> None:
    """Drop an owner's names from this process (disconnect or revocation)."""
    _DEFAULT_INDEXER.forget(owner_id)


def build_index(rows: Iterable[dict]) -> OwnerMetadataIndex:
    """An index from rows already in hand (tests, evaluation, REST pages)."""
    index = OwnerMetadataIndex()
    for row in rows:
        index.upsert(row)
    return index


__all__ = [
    "IndexStatus",
    "MetadataCandidate",
    "MetadataMatchResult",
    "OwnerMetadataIndex",
    "OwnerMetadataIndexer",
    "build_index",
    "forget_owner",
    "match_owner_files",
    "name_tokens",
    "owner_vocabulary",
]
