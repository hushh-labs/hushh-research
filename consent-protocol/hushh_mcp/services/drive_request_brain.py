"""Deterministic request brain: a Drive request phrase becomes search concepts.

No model call. The brain proposes discovery literals only, the way an owner
would type them into the Google Drive search box (with Drive's synonym and
typo help made explicit). It never decides relevance, period membership,
shareability or owner review: the picked request dates, kind fences, title
evidence and the existing review policy still decide what may be shared.

Shape: every typed word or lexicon phrase is one concept (OR of variants).
Concepts are ANDed, like Drive's own multi-word search. Document-type parts
that the requester lists separately ("contracts and invoices") are a union,
and a part may carry standalone alternatives that satisfy it on their own
("MoM" is a whole "meeting notes"). Topic words always AND into every part.
Date phrases are removed from the subject and kept only as a suggestion: the
request's picked dates win.
"""

from __future__ import annotations

import re
from calendar import monthrange
from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

BRAIN_VERSION = 1
MAX_TOPICS = 4
MAX_PARTS = 3
MAX_CONCEPTS = 6
MAX_VARIANTS = 10
MAX_TERM_CHARS = 50
PLAN_VARIANTS = 4

KINDS = ("document", "spreadsheet", "presentation", "pdf", "image", "video", "audio", "folder")


@dataclass(frozen=True)
class Concept:
    canonical: str
    variants: tuple[str, ...]  # priority order; canonical first; casefolded literals

    def as_json(self) -> dict:
        return {"canonical": self.canonical, "variants": list(self.variants)}


@dataclass(frozen=True)
class Standalone:
    phrase: str
    title_only: bool

    def as_json(self) -> dict:
        return {"phrase": self.phrase, "titleOnly": self.title_only}


@dataclass(frozen=True)
class DocPart:
    key: str
    concepts: tuple[Concept, ...]
    standalone: tuple[Standalone, ...] = ()

    def as_json(self) -> dict:
        return {
            "key": self.key,
            "concepts": [concept.as_json() for concept in self.concepts],
            "standalone": [item.as_json() for item in self.standalone],
        }


@dataclass(frozen=True)
class RequestBrain:
    topics: tuple[Concept, ...]
    parts: tuple[DocPart, ...]
    file_kind: str
    suggested_period: dict | None
    corrected: bool

    @property
    def concepts(self) -> tuple[Concept, ...]:
        """Every concept, topics first: Gear 1 lookup and plan compatibility."""
        return (*self.topics, *(concept for part in self.parts for concept in part.concepts))

    @property
    def doc_types(self) -> tuple[str, ...]:
        return tuple(part.key for part in self.parts if part.key != "terms")

    def as_checkpoint(self) -> dict:
        """JSON for the encrypted search checkpoint; never for logs."""
        return {
            "version": BRAIN_VERSION,
            "topics": [concept.as_json() for concept in self.topics],
            "parts": [part.as_json() for part in self.parts],
            "fileKind": self.file_kind,
            "suggestedPeriod": self.suggested_period,
            "corrected": self.corrected,
        }


def brain_from_checkpoint(value: object) -> RequestBrain | None:
    """Rebuild a frozen brain; anything malformed is ignored (legacy compile runs)."""
    if not isinstance(value, dict) or value.get("version") != BRAIN_VERSION:
        return None

    def concept(item) -> Concept:
        variants = tuple(item["variants"])
        if (
            not variants
            or len(variants) > MAX_VARIANTS
            or not all(_valid_literal(term) for term in variants)
            or item["canonical"] != variants[0]
        ):
            raise ValueError("invalid concept")
        return Concept(variants[0], variants)

    try:
        topics = tuple(concept(item) for item in value["topics"])
        parts = tuple(
            DocPart(
                str(part["key"]),
                tuple(concept(item) for item in part["concepts"]),
                tuple(
                    Standalone(item["phrase"], item["titleOnly"] is True)
                    for item in part["standalone"]
                    if _valid_literal(item["phrase"])
                ),
            )
            for part in value["parts"]
        )
        kind = value.get("fileKind", "any")
        if len(topics) > MAX_TOPICS or len(parts) > MAX_PARTS or kind not in {"any", *KINDS}:
            return None
        return RequestBrain(
            topics, parts, kind, value.get("suggestedPeriod"), bool(value.get("corrected"))
        )
    except (KeyError, TypeError, ValueError):
        return None


def _valid_literal(term: object) -> bool:
    return (
        isinstance(term, str)
        and 1 <= len(term.strip()) <= MAX_TERM_CHARS
        and not any(ord(char) < 32 or ord(char) == 127 for char in term)
    )


# ---------------------------------------------------------------------------
# Lexicon. Each entry is one concept: the phrases a requester types, and the
# literal spellings an owner's files use for the same thing.


@dataclass(frozen=True)
class _Entry:
    canonical: str
    triggers: tuple[str, ...]
    variants: tuple[str, ...]
    family: str


_MEETING_NOTE_VARIANTS = ("notes", "note", "minutes", "mom", "transcript", "recap", "summary")
_ENTRIES = (
    # Meeting notes: the request kinds owners use most.
    _Entry(
        "minutes of meeting",
        ("minutes of meeting", "minutes of the meeting", "mom", "moms", "meeting minutes"),
        ("minutes of meeting", "mom", "meeting minutes", "minutes"),
        "meeting_notes",
    ),
    _Entry(
        "notes by gemini",
        ("notes by gemini", "gemini notes", "gemini meeting notes"),
        ("notes by gemini",),
        "meeting_notes",
    ),
    _Entry("minutes", ("minutes",), ("minutes", "mom", "minutes of meeting"), "meeting_notes"),
    _Entry(
        "meeting",
        ("meeting", "meetings", "mtg", "mtgs"),
        ("meeting", "meetings", "standup", "sync", "1:1", "huddle", "call"),
        "meeting",
    ),
    _Entry(
        "standup",
        ("standup", "standups", "stand-up", "stand up", "daily standup", "scrum"),
        ("standup", "stand-up", "stand up", "scrum"),
        "meeting",
    ),
    _Entry(
        "sync",
        ("sync", "syncs", "catch up", "catchup", "catch-up"),
        ("sync", "syncs", "catch up", "catchup"),
        "meeting",
    ),
    _Entry(
        "1:1",
        ("1:1", "1-1", "1on1", "one on one", "one-on-one"),
        ("1:1", "one on one", "one-on-one", "1on1"),
        "meeting",
    ),
    _Entry("notes", ("notes", "note"), ("notes", "note"), "notes"),
    _Entry("transcript", ("transcript", "transcripts"), ("transcript", "transcripts"), "notes"),
    _Entry("recap", ("recap", "recaps"), ("recap", "recaps", "summary"), "notes"),
    # Financial statements.
    _Entry(
        "credit card",
        ("credit card", "credit cards", "card"),
        ("credit card", "card"),
        "card",
    ),
    _Entry("bank", ("bank", "banking", "bank account"), ("bank", "banking"), "bank"),
    _Entry(
        "account",
        ("account", "accounts", "savings account", "current account"),
        ("account", "accounts"),
        "bank",
    ),
    _Entry(
        "statement",
        ("statement", "statements", "e-statement", "estatement", "passbook"),
        ("statement", "statements", "estatement", "e-statement", "passbook"),
        "statement",
    ),
    # Invoices, bills and receipts.
    _Entry(
        "invoice",
        ("invoice", "invoices", "bill", "bills", "tax invoice"),
        ("invoice", "invoices", "bill", "bills", "receipt", "receipts"),
        "invoice",
    ),
    _Entry(
        "receipt",
        ("receipt", "receipts"),
        ("receipt", "receipts", "invoice", "invoices", "bill"),
        "invoice",
    ),
    # Salary.
    _Entry(
        "payslip",
        (
            "payslip",
            "payslips",
            "pay slip",
            "pay slips",
            "salary slip",
            "salary slips",
            "pay stub",
            "pay stubs",
            "paystub",
            "paystubs",
            "salary statement",
            "wage slip",
        ),
        ("payslip", "payslips", "pay slip", "salary slip", "pay stub", "paystub", "salary"),
        "payslip",
    ),
    # Tax.
    _Entry("form 16", ("form 16", "form16", "form-16"), ("form 16", "form16", "form-16"), "tax"),
    _Entry(
        "26as",
        ("26as", "form 26as", "annual tax statement"),
        ("26as", "form 26as", "annual tax statement"),
        "tax",
    ),
    _Entry(
        "itr",
        ("itr", "itrs", "income tax return", "income tax returns", "tax return", "tax returns"),
        ("itr", "income tax return", "tax return", "itr-v"),
        "tax",
    ),
    _Entry(
        "gst", ("gst", "gstr", "gst return", "gst returns"), ("gst", "gstr", "gst return"), "tax"
    ),
    _Entry(
        "tax",
        ("tax", "taxes", "tax document", "tax documents", "income tax"),
        ("tax", "itr", "form 16", "26as", "gst"),
        "tax",
    ),
    # Agreements.
    _Entry(
        "contract",
        ("contract", "contracts", "agreement", "agreements", "msa", "nda", "ndas"),
        ("contract", "contracts", "agreement", "agreements", "msa", "nda"),
        "contract",
    ),
    _Entry(
        "offer letter",
        ("offer letter", "offer letters", "appointment letter", "appointment letters"),
        ("offer letter", "appointment letter", "offer"),
        "offer_letter",
    ),
    # Identity documents.
    _Entry("passport", ("passport", "passports"), ("passport",), "id"),
    _Entry(
        "aadhaar", ("aadhaar", "aadhar", "aadhaar card", "aadhar card"), ("aadhaar", "aadhar"), "id"
    ),
    _Entry("pan card", ("pan card", "pan"), ("pan card", "pan"), "id"),
    _Entry(
        "driving licence",
        ("driving licence", "driving license", "driver license", "drivers license", "dl"),
        ("driving licence", "driving license", "driver license"),
        "id",
    ),
    _Entry("voter id", ("voter id", "voter card", "epic card"), ("voter id", "voter card"), "id"),
    _Entry(
        "identity",
        (
            "id",
            "ids",
            "id proof",
            "id proofs",
            "identity",
            "identity document",
            "identity documents",
            "identity proof",
            "kyc",
            "id card",
            "id cards",
        ),
        ("passport", "aadhaar", "pan card", "driving licence", "voter id", "identity", "kyc"),
        "id",
    ),
    # Insurance.
    _Entry(
        "insurance",
        ("insurance", "insurance policy", "insurance policies", "policy document"),
        ("insurance", "policy schedule", "premium"),
        "insurance",
    ),
    # Reports.
    _Entry("report", ("report", "reports"), ("report", "reports"), "report"),
)

# Which families form one document part, its default kind and alternatives.
_DOC_KINDS = {
    "meeting_notes": "document",
    "contract": "document",
    "offer_letter": "document",
}
_STATEMENT_PARTS = {"bank": "bank_statement", "card": "card_statement"}

_KIND_WORDS = {
    "pdf": "pdf",
    "pdfs": "pdf",
    "doc": "document",
    "docs": "document",
    "document": "document",
    "documents": "document",
    "docx": "document",
    "gdoc": "document",
    "gdocs": "document",
    "sheet": "spreadsheet",
    "sheets": "spreadsheet",
    "spreadsheet": "spreadsheet",
    "spreadsheets": "spreadsheet",
    "excel": "spreadsheet",
    "xlsx": "spreadsheet",
    "xls": "spreadsheet",
    "csv": "spreadsheet",
    "slide": "presentation",
    "slides": "presentation",
    "deck": "presentation",
    "decks": "presentation",
    "presentation": "presentation",
    "presentations": "presentation",
    "ppt": "presentation",
    "pptx": "presentation",
    "powerpoint": "presentation",
    "image": "image",
    "images": "image",
    "photo": "image",
    "photos": "image",
    "picture": "image",
    "pictures": "image",
    "screenshot": "image",
    "screenshots": "image",
    "jpg": "image",
    "jpeg": "image",
    "png": "image",
    "video": "video",
    "videos": "video",
    "recording": "video",
    "recordings": "video",
    "audio": "audio",
    "audios": "audio",
    "folder": "folder",
    "folders": "folder",
}

_STOPWORDS = frozenset(
    """
    a about above across after again all also am an and any are as at be been before
    being between both but by can could did do does doing done each either every for from
    get give given has have having he her here hers him his how i if in into is it its just
    kindly let me mine more most my need needed no nor not of off on once only or other our
    ours out over own please per related relevant regarding same send share shared she should
    show so some such than that the their theirs them then there these they this those through
    till to too under until up upto us very via want was we were what when where which while who
    whom why will with within would you your yours copy copies file files item items stuff thing
    things latest recent recently newest new old older oldest previous last past current next
    every everything entire full whole complete period dated date dates during since
    lot lots bunch set sets list find search look fetch pull grab provide attach upload
    one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty
    hundred thousand first second third fourth fifth
    day days week weeks month months year years quarter quarters fy
    scan scans scanned soft photocopy
    """.split()
)
_COORDINATORS = frozenset({"and", "or", "&", ",", "plus", "/"})

_NUMBER_WORDS = {
    "a": 1,
    "an": 1,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}
_MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_COUNT = r"(?P<count>\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
_RELATIVE = re.compile(
    rf"\b(?:(?:in|for|from|over|during)\s+)?(?:the\s+)?(?:last|past|previous|recent)\s+{_COUNT}\s+"
    r"(?P<unit>days?|weeks?|months?|quarters?|years?)\b"
    r"|\b(?P<count2>\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
    r"\s+(?P<unit2>days?|weeks?|months?|quarters?|years?)\s+(?:ago|old|back)\b",
    re.I,
)
_CALENDAR = re.compile(
    r"\b(?P<which>this|current|last|previous|past)\s+(?P<unit>week|month|quarter|year|fy)\b"
    r"|\b(?P<day>yesterday|today)(?:['’]s)?\b",
    re.I,
)
_QUARTER = re.compile(
    r"\b(?:q(?P<q>[1-4])|(?P<qword>first|second|third|fourth)\s+quarter)"
    r"(?:\s*(?:of\s+)?(?:fy\s*)?(?P<year>(?:19|20)\d{2}))?\b",
    re.I,
)
_MONTH = re.compile(
    r"\b(?P<prep>(?:in|for|of|during|since|from)\s+)?"
    r"(?P<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?"
    r"(?:\s*,?\s*(?P<year>(?:19|20)\d{2}))?",
    re.I,
)
_YEAR = re.compile(
    r"\b(?:fy\s*)?(?P<year>(?:19|20)\d{2})(?:\s*[-/]\s*(?P<end>\d{2}|(?:19|20)\d{2}))?\b"
    r"|\bfy\s*(?P<short>\d{2})\s*[-/]\s*(?P<short_end>\d{2})\b",
    re.I,
)
_QUOTED = re.compile(r"[\"“”]([^\"“”]{2,50})[\"“”]")
_TOKEN = re.compile(r"[^\W_]+(?:[:'’\-][^\W_]+)*|[,&/]", re.UNICODE)
_DOTTED_MOM = re.compile(r"\bm\.\s?o\.\s?m\b\.?", re.I)


def _zone(timezone: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _shift_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def _month_span(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def _strip_dates(text: str, today: date) -> tuple[str, list[tuple[date, date]]]:
    """Remove date phrases from the subject and return the spans they named."""
    spans: list[tuple[date, date]] = []

    def relative(match: re.Match) -> str:
        count_text = (match["count"] or match["count2"]).lower()
        count = _NUMBER_WORDS.get(count_text) or int(count_text)
        unit = (match["unit"] or match["unit2"]).lower().rstrip("s")
        if unit == "day":
            start = today - timedelta(days=count)
        elif unit == "week":
            start = today - timedelta(weeks=count)
        elif unit == "month":
            start = _shift_months(today, -count)
        elif unit == "quarter":
            start = _shift_months(today, -3 * count)
        else:
            start = _shift_months(today, -12 * count)
        spans.append((start, today))
        return " "

    def calendar(match: re.Match) -> str:
        if match["day"]:
            day = today - timedelta(days=1) if match["day"].lower() == "yesterday" else today
            spans.append((day, day))
            return " "
        which = match["which"].lower()
        unit = match["unit"].lower()
        back = which in {"last", "previous", "past"}
        if unit == "week":
            start = today - timedelta(days=today.weekday() + (7 if back else 0))
            spans.append((start, start + timedelta(days=6) if back else today))
        elif unit == "month":
            first = _shift_months(today.replace(day=1), -1 if back else 0)
            spans.append((first, _month_span(first.year, first.month)[1] if back else today))
        elif unit == "quarter":
            first = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
            if back:
                first = _shift_months(first, -3)
                last = _shift_months(first, 3) - timedelta(days=1)
            else:
                last = today
            spans.append((first, last))
        elif unit == "fy":
            # Indian fiscal year: April to March.
            start_year = today.year if today.month >= 4 else today.year - 1
            if back:
                start_year -= 1
            first = date(start_year, 4, 1)
            spans.append((first, date(start_year + 1, 3, 31) if back else today))
        else:
            year = today.year - 1 if back else today.year
            spans.append((date(year, 1, 1), date(year, 12, 31) if back else today))
        return " "

    def quarter(match: re.Match) -> str:
        number = (
            int(match["q"])
            if match["q"]
            else {"first": 1, "second": 2, "third": 3, "fourth": 4}[match["qword"].lower()]
        )
        year = int(match["year"]) if match["year"] else today.year
        first = date(year, 3 * number - 2, 1)
        if not match["year"] and first > today:
            first = date(year - 1, 3 * number - 2, 1)
        spans.append((first, _shift_months(first, 3) - timedelta(days=1)))
        return " "

    def month(match: re.Match) -> str:
        name = match["month"].lower()
        # "may" is also a verb; only a preposition or a year makes it a month.
        if name == "may" and not (match["prep"] or match["year"]):
            return match.group(0)
        number = _MONTHS[name]
        year = int(match["year"]) if match["year"] else today.year
        if not match["year"] and date(year, number, 1) > today:
            year -= 1
        spans.append(_month_span(year, number))
        return " "

    def year(match: re.Match) -> str:
        if match["short"]:
            first_year = 2000 + int(match["short"])
            spans.append((date(first_year, 4, 1), date(first_year + 1, 3, 31)))
            return " "
        first_year = int(match["year"])
        if match["end"]:
            # "2024-25" and "FY 2024-25" are an Indian fiscal year.
            spans.append((date(first_year, 4, 1), date(first_year + 1, 3, 31)))
        else:
            spans.append((date(first_year, 1, 1), date(first_year, 12, 31)))
        return " "

    for pattern, replace in (
        (_RELATIVE, relative),
        (_CALENDAR, calendar),
        (_QUARTER, quarter),
        (_MONTH, month),
        (_YEAR, year),
    ):
        text = pattern.sub(replace, text)
    return text, spans


def _osa(left: str, right: str, limit: int) -> int:
    """Optimal string alignment distance, stopping once it exceeds ``limit``."""
    if abs(len(left) - len(right)) > limit:
        return limit + 1
    previous2: list[int] = []
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i] + [0] * len(right)
        for j, b in enumerate(right, 1):
            cost = 0 if a == b else 1
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if i > 1 and j > 1 and a == right[j - 2] and left[i - 2] == b:
                current[j] = min(current[j], previous2[j - 2] + 1)
        if min(current) > limit:
            return limit + 1
        previous2, previous = previous, current
    return previous[-1]


def _typo_limit(token: str) -> int:
    return 0 if len(token) < 5 else 1 if len(token) < 8 else 2


def _number_variants(word: str) -> tuple[str, ...]:
    """The word and its common singular/plural spelling (Drive fullText is whole-token)."""
    if len(word) < 3 or not word.isalpha() or word.endswith(("ss", "us", "is")):
        return (word,)
    if word.endswith("ies") and len(word) > 4:
        other = word[:-3] + "y"
    elif word.endswith(("xes", "ches", "shes", "sses", "zes")):
        other = word[:-2]
    elif word.endswith("s"):
        other = word[:-1]
    elif word.endswith("y") and len(word) > 3 and word[-2] not in "aeiou":
        other = word[:-1] + "ies"
    elif word.endswith(("x", "ch", "sh", "s", "z")):
        other = word + "es"
    else:
        other = word + "s"
    return (word, other)


_TRIGGERS = sorted(
    ((tuple(trigger.split()), entry) for entry in _ENTRIES for trigger in entry.triggers),
    key=lambda item: -len(item[0]),
)
_LEXICON_WORDS = frozenset(word for words, _ in _TRIGGERS for word in words)
_SINGLE_TRIGGERS = {words[0]: entry for words, entry in reversed(_TRIGGERS) if len(words) == 1}


def _family_words(*families: str) -> list[str]:
    return [words[0] for words, entry in _TRIGGERS if len(words) == 1 and entry.family in families]


# Phrases owners type often enough that one misspelled word (>=5 chars) in
# them is still recognised without an owner vocabulary: "metting notes".
_CORRECTION_PHRASES = sorted(
    {
        *(words for words, _ in _TRIGGERS if len(words) > 1),
        *((left, right) for left in _family_words("meeting") for right in _family_words("notes")),
        *(
            (left, right)
            for left in ("bank", "card", "account", "salary", "credit")
            for right in ("statement", "statements", "slip", "slips", "card")
            if left != right
        ),
    },
    key=lambda words: (-len(words), words),
)


def _tokens(text: str) -> list[str]:
    text = _DOTTED_MOM.sub(" mom ", text)
    return [token.replace("’", "'") for token in _TOKEN.findall(text.casefold())]


def _phrase_correction(tokens: list[str], start: int, words: tuple[str, ...]) -> bool:
    """A multi-word trigger with one misspelled word (>=5 chars) still matches it."""
    window = tokens[start : start + len(words)]
    if len(window) != len(words) or len(words) < 2:
        return False
    misses = [(typed, word) for typed, word in zip(window, words, strict=True) if typed != word]
    if len(misses) != 1:
        return False
    typed, word = misses[0]
    return (
        typed not in _LEXICON_WORDS
        and typed not in _STOPWORDS
        and _typo_limit(typed) > 0
        and _osa(typed, word, _typo_limit(typed)) <= _typo_limit(typed)
    )


def _vocabulary_correction(token: str, vocabulary: Collection[str] | None) -> str | None:
    """Drive-style "did you mean": only toward a word the owner's Drive really has."""
    limit = _typo_limit(token)
    if not vocabulary or limit == 0 or token in vocabulary or not token.isalpha():
        return None
    best = None
    best_distance = limit + 1
    for word in vocabulary:
        if not isinstance(word, str) or len(word) < 4 or abs(len(word) - len(token)) > limit:
            continue
        distance = _osa(token, word, limit)
        if distance < best_distance or distance == best_distance and best and word < best:
            best, best_distance = word, distance
    return best if best_distance <= limit else None


def _unique(values) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for value in values:
        value = " ".join(value.split()).casefold()
        if _valid_literal(value) and value not in seen:
            seen[value] = None
    return tuple(seen)[:MAX_VARIANTS]


@dataclass
class _Unit:
    position: int
    concept: Concept
    family: str | None  # None for a raw topic word


def interpret_request(
    text: str,
    *,
    now: datetime | None = None,
    timezone: str = "UTC",
    vocabulary: Collection[str] | None = None,
) -> RequestBrain:
    """Turn the requester's phrase into concepts, deterministically and offline."""
    if not isinstance(text, str):
        raise ValueError("request text required")
    current = now if isinstance(now, datetime) and now.tzinfo is not None else None
    today = (
        current.astimezone(_zone(timezone)) if current else datetime.now(_zone(timezone))
    ).date()
    quoted = [match.group(1).strip().casefold() for match in _QUOTED.finditer(text)]
    remainder = _QUOTED.sub(" , ", text)
    remainder, spans = _strip_dates(remainder, today)
    tokens = _tokens(remainder)
    kinds: list[str] = []
    units: list[_Unit] = []
    typos: dict[int, str] = {}
    corrected = False
    for start in range(len(tokens)):
        for words in _CORRECTION_PHRASES:
            if _phrase_correction(tokens, start, words):
                # Keep what was typed as a variant; search the fixed phrase.
                for offset, word in enumerate(words):
                    if tokens[start + offset] != word:
                        typos[start + offset] = tokens[start + offset]
                        tokens[start + offset] = word
                corrected = True
                break
    position = 0
    while position < len(tokens):
        token = tokens[position]
        if token in _COORDINATORS:
            units.append(_Unit(position, Concept(",", (",",)), "coordinator"))
            position += 1
            continue
        matched = None
        for words, entry in _TRIGGERS:
            if tuple(tokens[position : position + len(words)]) == words:
                matched = (words, entry)
                break
        if matched is not None:
            words, entry = matched
            typed = [
                typos[index] for index in range(position, position + len(words)) if index in typos
            ]
            variants = _unique((*entry.variants, *typed))
            units.append(_Unit(position, Concept(variants[0], variants), entry.family))
            position += len(words)
            continue
        position += 1
        if token in _KIND_WORDS:
            kinds.append(_KIND_WORDS[token])
            continue
        if token in _STOPWORDS or token.isdigit() or len(token) < 2:
            continue
        variants = list(_number_variants(token))
        fix = _vocabulary_correction(token, vocabulary)
        if fix is not None:
            corrected = True
            entry = _SINGLE_TRIGGERS.get(fix)
            if entry is not None:
                # The owner's corrected word is a known kind: use its synonyms.
                literal = _unique((*entry.variants, token))
                units.append(_Unit(position - 1, Concept(literal[0], literal), entry.family))
                continue
            variants = [fix, *_number_variants(fix)[1:], *variants]
        literal = _unique(variants)
        if literal:
            units.append(_Unit(position - 1, Concept(literal[0], literal), None))
    for phrase in quoted:
        literal = _unique([phrase])
        if literal:
            units.append(_Unit(-1, Concept(literal[0], literal), None))
    return _assemble(units, kinds, spans, corrected)


def _assemble(
    units: list[_Unit], kinds: list[str], spans: list[tuple[date, date]], corrected: bool
) -> RequestBrain:
    # Split document-type words into separately listed parts at coordinators.
    groups: list[list[_Unit]] = [[]]
    topics: list[Concept] = []
    raw_groups: list[list[_Unit]] = [[]]
    for unit in units:
        if unit.family == "coordinator":
            groups.append([])
            raw_groups.append([])
        elif unit.family is None:
            raw_groups[-1].append(unit)
        else:
            groups[-1].append(unit)
    lexical = [group for group in groups if group]
    raw = [unit for group in raw_groups for unit in group]
    if not lexical and len([group for group in raw_groups if group]) > 1:
        # "falcon or eagle": separately listed subjects are a union.
        parts = tuple(
            DocPart("terms", tuple(unit.concept for unit in group)) for group in raw_groups if group
        )[:MAX_PARTS]
    else:
        topics = [unit.concept for unit in raw][:MAX_TOPICS]
        # "meeting notes and minutes": each listed kind is its own alternative.
        parts = tuple(_doc_part(group) for group in lexical)[:MAX_PARTS]
    # Bound the total concept count; topic words are the most specific.
    budget = MAX_CONCEPTS - len(topics)
    bounded = []
    for part in parts:
        concepts = part.concepts[: max(1, budget)]
        budget -= len(concepts)
        bounded.append(DocPart(part.key, concepts, part.standalone))
    parts = tuple(bounded)
    distinct = sorted(set(kinds))
    if len(distinct) == 1:
        file_kind = distinct[0]
    elif distinct:
        file_kind = "any"
    else:
        defaults = {_DOC_KINDS.get(part.key, "any") for part in parts} if parts else {"any"}
        file_kind = defaults.pop() if len(defaults) == 1 else "any"
    period = None
    if spans:
        period = {
            "start": min(start for start, _ in spans).isoformat(),
            "end": max(end for _, end in spans).isoformat(),
        }
    return RequestBrain(tuple(topics), parts, file_kind, period, corrected)


def _doc_part(group: list[_Unit]) -> DocPart:
    families = {unit.family for unit in group}
    concepts = [unit.concept for unit in group]
    generic_notes = {"meeting", "notes"} <= families
    if generic_notes or "meeting_notes" in families:
        concepts = [
            Concept(concept.canonical, _unique((*concept.variants, *_MEETING_NOTE_VARIANTS)))
            if any(unit.family == "notes" and unit.concept == concept for unit in group)
            else concept
            for concept in concepts
        ]
        # Only the generic "meeting + notes" ask is satisfied by each named
        # kind on its own; "Notes by Gemini" or "MoM" stays that specific kind.
        standalone = (
            [
                Standalone("minutes of meeting", False),
                Standalone("notes by gemini", False),
                Standalone("mom", True),
            ]
            if generic_notes
            else []
        )
        key = "meeting_notes"
    elif "statement" in families:
        key = next(
            (_STATEMENT_PARTS[family] for family in ("card", "bank") if family in families),
            "statement",
        )
        standalone = []
    else:
        key = next(iter(sorted(families - {"notes", "meeting"})), None) or (
            "notes" if "notes" in families else "meeting"
        )
        standalone = []
    unique: list[Concept] = []
    for concept in concepts:
        if concept.canonical not in {item.canonical for item in unique}:
            unique.append(concept)
    if 2 <= len(unique) <= 3 and all(
        concept.canonical.replace(" ", "").isalpha() for concept in unique
    ):
        # A compound filename ("MeetingNotes.pdf") hides its words from Drive's
        # word-prefix name match. One title-only alternative finds it.
        compound = "".join(concept.canonical.replace(" ", "") for concept in unique)
        if 4 <= len(compound) <= MAX_TERM_CHARS:
            standalone.append(Standalone(compound, True))
    if len(unique) == 1:
        standalone = [item for item in standalone if item.phrase not in unique[0].variants]
    return DocPart(key, tuple(unique), tuple(standalone))


def suggested_plan(brain: RequestBrain, query: str) -> dict:
    """A LiveSearchPlan-shaped dict; the full concept set stays in the brain."""
    from hushh_mcp.services.drive_suggestion_service import explicitly_requests_file_activity

    concepts = list(brain.concepts)
    terms: list[str] = []
    groups: list[list[str]] = []
    used: set[str] = set()
    for concept in concepts:
        if len(terms) == 3:
            break
        variants = [
            variant
            for variant in concept.variants
            if variant.casefold() not in used and _valid_literal(variant)
        ][:PLAN_VARIANTS]
        if not variants or variants[0] != concept.canonical:
            continue
        terms.append(variants[0])
        groups.append(variants)
        used.update(variant.casefold() for variant in variants)
    file_activity = explicitly_requests_file_activity(query)
    plan: dict = {
        "mode": "find",
        "terms": terms,
        "term_groups": groups,
        "file_kind": brain.file_kind,
        "time_intent": "file_activity" if file_activity else "document_coverage",
        "semantic_intent": "institutional_statement"
        if any(part.key.endswith("statement") for part in brain.parts)
        else "other",
        "subject_scope": "specific_records" if terms else "metadata_listing",
        "subject_complete": True,
    }
    if file_activity and re.search(r"\b(?:created|uploaded|added)\b", query, re.I):
        plan["file_time_field"] = "createdTime"
    if not terms and brain.file_kind == "any":
        plan["sort"] = "recent"
    return plan


def _plain_literal(value: str) -> bool:
    return _valid_literal(value) and bool(re.fullmatch(r"[^\W_]+(?:[ '\-][^\W_]+)*", value))


def full_text_safe(value: str) -> bool:
    """Drive fullText matches whole tokens; punctuation such as ``1:1`` is title-only."""
    return _plain_literal(value)
