"""Deterministic request brain: a Drive request phrase becomes search concepts.

No model call. The brain proposes discovery literals the way an owner would
type them into the Google Drive search box (with Drive's synonym and typo help
made explicit). Discovery spellings only find candidates. A concept's evidence
spellings are narrower: what the requester typed, its inflections and exact
synonyms ("pay slip" for "payslip"). Only those can serve as automatic-sharing
title evidence; loose clues ("salary", "call", "premium") and spelling fixes,
built-in or taken from the owner's own Drive, never authorize a grant. The
picked request dates, kind fences, title evidence and the existing review
policy still decide what may be shared.

A word left out of the subject that may still name it ("one" in "Google One
receipts", "12" in "Flat 12 maintenance bills") is recorded as dropped, and
that search keeps the owner's review: like a failed planner's stand-in plan,
the brain never shares on a subject it could not hold the request to.

Shape: every typed word or lexicon phrase is one concept (OR of variants).
Concepts are ANDed, like Drive's own multi-word search. Document-type parts
that the requester lists separately ("contracts and invoices") are a union,
and a part may carry standalone alternatives that satisfy it on their own
("minutes of meeting" is a whole "meeting notes"). Topic words always AND into
every part; separately listed topics ("Acme or Globex invoices") are one
either-or topic. Date phrases inside the picked dates are removed from the
subject and kept only as a suggestion: the request's picked dates win.

A request with no subject word left is searched only when it explicitly asks
for a listing ("all files", "September documents"); otherwise planning fails
closed instead of listing the whole Drive.
"""

from __future__ import annotations

import re
from calendar import monthrange
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

BRAIN_VERSION = 2
MAX_TOPICS = 4
MAX_PARTS = 3
MAX_CONCEPTS = 6
MAX_VARIANTS = 10
MAX_EVIDENCE = 16
MAX_TERM_CHARS = 50
MAX_EXACT_TITLE_CHARS = 200
MAX_RESULT_LIMIT = 1000
PLAN_VARIANTS = 4

KINDS = ("document", "spreadsheet", "presentation", "pdf", "image", "video", "audio", "folder")


@dataclass(frozen=True)
class Concept:
    canonical: str
    variants: tuple[str, ...]  # discovery spellings; priority order; canonical first
    # Spellings that count as automatic-sharing title evidence. A cased one
    # ("MoM") must match its case: lowercased it is an ordinary word.
    evidence: tuple[str, ...] = ()

    @property
    def title_evidence(self) -> tuple[str, ...]:
        return self.evidence or (self.canonical,)

    def as_json(self) -> dict:
        return {
            "canonical": self.canonical,
            "variants": list(self.variants),
            "evidence": list(self.title_evidence),
        }


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
    # An explicit listing ("all files from last week"): no subject words.
    listing: bool = False
    # An explicit count ("latest 3 payslips"): the newest N matches only.
    result_limit: int | None = None
    # A literal file name ("Contract.pdf"): the title must equal it.
    exact_title: str | None = None
    # Request words left out of the subject that may still name it: "one" in
    # "Google One", "12" in "Flat 12", topic words past the bound. The search
    # cannot hold the request to them, so it keeps the owner's review.
    dropped: tuple[str, ...] = ()

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
            "listing": self.listing,
            "resultLimit": self.result_limit,
            "exactTitle": self.exact_title,
            "dropped": list(self.dropped),
        }


def brain_from_checkpoint(value: object) -> RequestBrain | None:
    """Rebuild a frozen brain; anything malformed is ignored (legacy compile runs)."""
    if not isinstance(value, dict) or value.get("version") != BRAIN_VERSION:
        return None

    def concept(item) -> Concept:
        variants = tuple(item["variants"])
        evidence = tuple(item["evidence"])
        if (
            not variants
            or len(variants) > MAX_VARIANTS
            or not all(_valid_literal(term) for term in variants)
            or item["canonical"] != variants[0]
            or not evidence
            or len(evidence) > MAX_EVIDENCE
            or not all(_valid_literal(term) for term in evidence)
        ):
            raise ValueError("invalid concept")
        return Concept(variants[0], variants, evidence)

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
        listing = value.get("listing", False)
        limit = value.get("resultLimit")
        exact = value.get("exactTitle")
        dropped = value.get("dropped", [])
        if (
            len(topics) > MAX_TOPICS
            or len(parts) > MAX_PARTS
            or kind not in {"any", *KINDS}
            or type(listing) is not bool
            or limit is not None
            and (type(limit) is not int or not 1 <= limit <= MAX_RESULT_LIMIT)
            or exact is not None
            and not _valid_exact_title(exact)
            or type(dropped) is not list
            or len(dropped) > MAX_EVIDENCE
            or not all(_valid_literal(word) for word in dropped)
        ):
            return None
        return RequestBrain(
            topics,
            parts,
            kind,
            value.get("suggestedPeriod"),
            bool(value.get("corrected")),
            listing,
            limit,
            exact,
            tuple(dropped),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _valid_literal(term: object) -> bool:
    return (
        isinstance(term, str)
        and 1 <= len(term.strip()) <= MAX_TERM_CHARS
        and not any(ord(char) < 32 or ord(char) == 127 for char in term)
    )


def _valid_exact_title(term: object) -> bool:
    return (
        isinstance(term, str)
        and 1 <= len(term.strip()) <= MAX_EXACT_TITLE_CHARS
        and not any(ord(char) < 32 or ord(char) == 127 for char in term)
    )


# ---------------------------------------------------------------------------
# Lexicon. Each entry is one concept: the phrases a requester types, and the
# literal spellings an owner's files use for the same thing. ``strict`` lists
# the exact synonyms that are title evidence whichever trigger was typed; the
# typed trigger itself (and its plural/singular) always is. Other variants are
# discovery clues only. ``cased`` is evidence that must match its case.


@dataclass(frozen=True)
class _Entry:
    canonical: str
    triggers: tuple[str, ...]
    variants: tuple[str, ...]
    family: str
    strict: tuple[str, ...] = ()
    cased: tuple[str, ...] = ()


_MEETING_NOTE_VARIANTS = ("notes", "note", "minutes", "transcript", "recap", "summary")
_MEETING_NOTE_EVIDENCE = ("notes", "note", "minutes")
# "MoM" (minutes of meeting) is "mom" once casefolded: lowercase it is never
# title evidence, only the cased abbreviation is.
_MOM_CASED = ("MoM", "MOM", "M.O.M")
_CASED_ONLY = frozenset({"mom", "moms"})
_ENTRIES = (
    # Meeting notes: the request kinds owners use most.
    _Entry(
        "minutes of meeting",
        ("minutes of meeting", "minutes of the meeting", "mom", "moms", "meeting minutes"),
        ("minutes of meeting", "mom", "meeting minutes", "minutes"),
        "meeting_notes",
        strict=("minutes of meeting", "meeting minutes", "minutes"),
        cased=_MOM_CASED,
    ),
    _Entry(
        "notes by gemini",
        ("notes by gemini", "gemini notes", "gemini meeting notes"),
        ("notes by gemini",),
        "meeting_notes",
        strict=("notes by gemini",),
    ),
    _Entry(
        "minutes",
        ("minutes",),
        ("minutes", "minutes of meeting"),
        "meeting_notes",
        strict=("minutes", "minutes of meeting"),
    ),
    _Entry(
        "meeting",
        ("meeting", "meetings", "mtg", "mtgs"),
        ("meeting", "meetings", "mtg", "mtgs", "standup", "sync", "1:1", "huddle", "call"),
        "meeting",
        strict=("meeting", "mtg"),
    ),
    _Entry(
        "standup",
        ("standup", "standups", "stand-up", "stand up", "daily standup", "scrum"),
        ("standup", "stand-up", "stand up", "scrum"),
        "meeting",
        strict=("standup", "stand-up", "stand up"),
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
        ("1:1", "1-1", "one on one", "one-on-one", "1on1"),
        "meeting",
        strict=("1:1", "1-1", "one on one", "one-on-one", "1on1"),
    ),
    _Entry("notes", ("notes", "note"), ("notes", "note"), "notes", strict=("notes",)),
    _Entry(
        "transcript",
        ("transcript", "transcripts"),
        ("transcript", "transcripts"),
        "notes",
        strict=("transcript",),
    ),
    _Entry(
        "recap", ("recap", "recaps"), ("recap", "recaps", "summary"), "notes", strict=("recap",)
    ),
    # Financial statements.
    _Entry(
        "credit card",
        ("credit card", "credit cards", "card"),
        ("credit card", "card"),
        "card",
    ),
    _Entry(
        "bank",
        ("bank", "banking", "bank account"),
        ("bank", "banking"),
        "bank",
        strict=("bank", "banking"),
    ),
    _Entry(
        "account",
        ("account", "accounts", "savings account", "current account"),
        ("account", "accounts"),
        "bank",
        strict=("account",),
    ),
    _Entry(
        "statement",
        ("statement", "statements", "e-statement", "estatement", "passbook"),
        ("statement", "statements", "estatement", "e-statement", "passbook"),
        "statement",
        strict=("statement", "estatement", "e-statement"),
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
        strict=("receipt",),
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
            "wage slips",
        ),
        (
            "payslip",
            "payslips",
            "pay slip",
            "salary slip",
            "pay stub",
            "paystub",
            "wage slip",
            "salary",
        ),
        "payslip",
        strict=("payslip", "pay slip", "salary slip", "pay stub", "paystub", "wage slip"),
    ),
    # Tax.
    _Entry(
        "form 16",
        ("form 16", "form16", "form-16"),
        ("form 16", "form16", "form-16"),
        "tax",
        strict=("form 16", "form16", "form-16"),
    ),
    _Entry(
        "26as",
        ("26as", "form 26as", "annual tax statement"),
        ("26as", "form 26as", "annual tax statement"),
        "tax",
        strict=("26as", "form 26as", "annual tax statement"),
    ),
    _Entry(
        "itr",
        ("itr", "itrs", "income tax return", "income tax returns", "tax return", "tax returns"),
        ("itr", "income tax return", "tax return", "itr-v"),
        "tax",
        strict=("itr", "income tax return", "tax return", "itr-v"),
    ),
    _Entry(
        "gst",
        ("gst", "gstr", "gst return", "gst returns"),
        ("gst", "gstr", "gst return"),
        "tax",
        strict=("gst", "gstr", "gst return"),
    ),
    _Entry(
        "tax",
        ("tax", "taxes", "tax document", "tax documents", "income tax"),
        ("tax", "itr", "form 16", "26as", "gst"),
        "tax",
        strict=("tax",),
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
    _Entry("passport", ("passport", "passports"), ("passport",), "id", strict=("passport",)),
    _Entry(
        "aadhaar",
        ("aadhaar", "aadhar", "aadhaar card", "aadhar card"),
        ("aadhaar", "aadhar"),
        "id",
        strict=("aadhaar", "aadhar"),
    ),
    _Entry("pan card", ("pan card", "pan"), ("pan card", "pan"), "id", strict=("pan card",)),
    _Entry(
        "driving licence",
        ("driving licence", "driving license", "driver license", "drivers license", "dl"),
        ("driving licence", "driving license", "driver license"),
        "id",
        strict=("driving licence", "driving license", "driver license"),
    ),
    _Entry(
        "voter id",
        ("voter id", "voter card", "epic card"),
        ("voter id", "voter card"),
        "id",
        strict=("voter id", "voter card"),
    ),
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
        strict=("insurance",),
    ),
    # Reports.
    _Entry("report", ("report", "reports"), ("report", "reports"), "report", strict=("report",)),
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
# File-type words that are also ordinary nouns. Before another subject word
# they modify it ("photo ID", "video production invoice") and stay search
# words; only at the head of a phrase ("receipt photos") are they a file type.
_NOUN_KINDS = frozenset(
    """
    sheet sheets excel slide slides deck decks image images photo photos picture pictures
    screenshot screenshots video videos recording recordings audio audios
    """.split()
)
# Named documents whose head is a file-type word: "Balance Sheet FY24.pdf" is
# a balance sheet whatever its type, so both words stay search words.
_KIND_COMPOUNDS = frozenset(
    {
        *(
            (left, "sheet")
            for left in "balance term cheat rate fact time data date mark cost spec call tally".split()
        ),
        *((left, "deck") for left in "pitch slide investor sales board".split()),
    }
)
_DOCUMENT_WORDS = frozenset({"doc", "docs", "document", "documents"})

_STOPWORDS = frozenset(
    """
    a about above across after again all also am an and any are as at be been before
    being between both but by can could did do does doing done each either every for from
    get give given has have having he her here hers him his how i if in into is it its just
    kindly let me mine more most my need needed no nor not of off on once only or other our
    ours out over own please per related relevant regarding same send share shared she should
    show so some such than that the their theirs them then there these they this those through
    till to too under until up upto us very via want was we were what when where which while who
    whom why with within would you your yours copy copies file files item items stuff thing
    things latest recent recently newest new old older oldest previous last past current next
    every everything entire full whole complete period dated date dates during since
    lot lots bunch set sets find search look fetch pull grab provide attach upload
    one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty
    hundred thousand first second third fourth fifth
    day days week weeks month months year years quarter quarters fy
    scanned soft photocopy
    hi hello hey dear thanks thank thankyou thx ty pls plz asap urgent urgently
    request requests requesting requested require required requires available
    drive drives gdrive email emails mail may might must shall regards sir madam
    """.split()
)
# Stopwords that can also name the subject or issuer: "Google One", "Royal
# Mail", "hard drive". They stay out of the search like other filler, but a
# request that used one keeps the owner's review (``RequestBrain.dropped``).
_SUBJECT_STOPWORDS = frozenset({"one", "email", "emails", "mail", "drive", "drives"})
# "your Google Drive", "shared drives": where the files live, not a subject.
_DRIVE_LOCATION = frozenset({"google", "my", "your", "our", "his", "her", "their", "the", "shared"})
# "Google Drive", "Google Docs", "Google Sheets": the files' home or type.
_GOOGLE_PRODUCTS = frozenset({"drive", "drives", *_KIND_WORDS})
# Nouns a number identifies rather than counts: "Flat 302", "invoice 2001",
# "policy no 12" ("#12" reads as "no 12").
_IDENTIFIER_NOUNS = frozenset(
    """
    no num number id ref flat apartment apt unit house villa plot room block tower wing
    building floor shop office suite door lot sector phase site ward bed seat gate
    account acct invoice bill receipt policy folio order ticket case claim
    """.split()
)
_COORDINATORS = frozenset({"and", "or", "&", ",", "plus", "/"})
# Words that make a subject-free request an explicit listing.
_LISTING_CUES = frozenset({"all", "every", "everything", "entire", "whole", "anything"})
_FILE_NOUNS = frozenset({"file", "files", "item", "items", *_KIND_WORDS})
# A trailing "for <purpose>" clause is context, not a search requirement:
# "bank statements for visa application", "payslips for home loan processing".
_PURPOSE_WORDS = frozenset(
    """
    visa visas loan loans mortgage audit audits auditing verification reimbursement
    reimbursements claim claims filing renewal onboarding admission admissions immigration
    application applications processing submission records reference approval compliance
    purpose purposes
    """.split()
)
_PURPOSE_MODIFIERS = frozenset(
    """
    home car auto vehicle personal education student business tourist travel work job bank tax
    income uk usa schengen canada australia
    """.split()
)

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
# An explicit file count: "latest 3 payslips", "2 invoices". "Form 16 docs"
# and "1:1 notes" are names, not counts.
_COUNT_NUMBER = r"\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve"
_TIME_UNIT = r"(?:days?|weeks?|months?|quarters?|years?)\b"
_FILE_COUNT = re.compile(
    rf"\b(?:latest|last|recent|newest|first|top)\s+(?P<lead>{_COUNT_NUMBER})\b(?![:\-/.]\d)"
    rf"(?!\s+{_TIME_UNIT})"
    rf"|(?<!form )(?<!form-)(?<!gstr )(?<![:/.\-])\b(?P<bare>{_COUNT_NUMBER})\s+(?!{_TIME_UNIT})"
    r"(?=(?:[^\W\d_]+\s+)?[^\W\d_]{2,}s\b)",
    re.I,
)
_QUOTED = re.compile(r"[\"“”]([^\"“”]{2,50})[\"“”]")
_FILE_EXTENSION = r"\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|jpe?g|png)"
_FILE_NAME = re.compile(rf"[^\s\"“”,;()]+{_FILE_EXTENSION}(?![\w.])", re.I)
# "AT&T", "H&M" and "P&G" are one name; only a spaced "&" lists subjects.
_TOKEN = re.compile(r"[^\W_]+(?:[:'’\-&][^\W_]+)*|[,&/]", re.UNICODE)
_DOTTED_MOM = re.compile(r"\bm\.\s?o\.\s?m\b\.?", re.I)
_NUMBER_SIGN = re.compile(r"#\s*(?=\d)")
_WORD = re.compile(r"[^\W_]+")


def _identifies(before: str) -> bool:
    """The number right after this text names a record: "Flat 302", "invoice no 12"."""
    words = _WORD.findall(before[-40:])
    return bool(words) and words[-1].casefold() in _IDENTIFIER_NOUNS


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


def _strip_dates(
    text: str, today: date, picked: tuple[date, date] | None = None
) -> tuple[str, list[tuple[date, date]]]:
    """Remove date phrases from the subject and return the spans they named.

    picked: the request's picked dates. A month or quarter wholly outside them
    names something ("Project June roadmap", "Q3 board deck") and stays in the
    subject as a search word.
    """
    spans: list[tuple[date, date]] = []

    def names_something(span: tuple[date, date]) -> bool:
        return picked is not None and (span[1] < picked[0] or span[0] > picked[1])

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
        span = (first, _shift_months(first, 3) - timedelta(days=1))
        if names_something(span):
            return match.group(0)
        spans.append(span)
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
        span = _month_span(year, number)
        if names_something(span):
            return match.group(0)
        spans.append(span)
        return " "

    def year(match: re.Match) -> str:
        first_year = 2000 + int(match["short"]) if match["short"] else int(match["year"])
        if match["short"] or match["end"]:
            # "2024-25" and "FY 2024-25" are an Indian fiscal year.
            span = (date(first_year, 4, 1), date(first_year + 1, 3, 31))
        else:
            span = (date(first_year, 1, 1), date(first_year, 12, 31))
        # A year outside the picked dates, a future one, or a number after an
        # identifier noun ("HDFC 2045 statement", "invoice 2001") names
        # something and stays a search word.
        if names_something(span) or span[0] > today or _identifies(match.string[: match.start()]):
            return match.group(0)
        spans.append(span)
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


def _strip_count(text: str) -> tuple[str, int | None]:
    """Remove one explicit file count from the subject and return it."""
    for match in _FILE_COUNT.finditer(text):
        if match["bare"] and _identifies(text[: match.start()]):
            # "Flat 302 maintenance bills": the number names the flat. Only
            # a count cue ("latest 3") makes a number after such a noun a count.
            continue
        value = (match["lead"] or match["bare"]).lower()
        count = _NUMBER_WORDS.get(value) or int(value)
        if not 1 <= count <= MAX_RESULT_LIMIT:
            return text, None
        return text[: match.start()] + " " + text[match.end() :], count
    return text, None


def _literal_file_name(text: str) -> str | None:
    """A literal file name the requester typed, as Drive shows it.

    A quoted name with a file extension, or one unquoted name such as
    "send me Contract.pdf" (the words right before the extension belong to
    it). Mixed with other subject words it is ambiguous and stays a search.
    """
    for match in _QUOTED.finditer(text):
        name = " ".join(match.group(1).split())
        if re.search(rf"{_FILE_EXTENSION}$", name, re.I) and _valid_exact_title(name):
            return name
    found = list(_FILE_NAME.finditer(text))
    if len(found) != 1:
        return None
    match = found[0]
    words = text[: match.start()].split()
    run: list[str] = []
    while words and words[-1][-1:].isalnum():
        word = words[-1]
        folded = word.casefold()
        if folded in _STOPWORDS or folded in _COORDINATORS or folded in _KIND_WORDS:
            break
        run.insert(0, words.pop())
    name = " ".join([*run, match.group(0)])
    rest = " ".join([*words, text[match.end() :]])
    leftover = [
        token
        for token in _tokens(rest)
        if token not in _STOPWORDS
        and token not in _COORDINATORS
        and token not in _KIND_WORDS
        and not token.isdigit()
    ]
    return name if not leftover and _valid_exact_title(name) else None


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


def _word_variants(word: str) -> tuple[str, ...]:
    """A typed word's own spellings: plural/singular, or a month's short forms."""
    if word in _MONTHS:
        return (word, *(name for name, number in _MONTHS.items() if number == _MONTHS[word]))
    return _number_variants(word)


def _phrase_forms(phrase: str) -> tuple[str, ...]:
    """A typed phrase with its last word's plural/singular spelling."""
    words = phrase.split()
    if not words:
        return ()
    return tuple(" ".join([*words[:-1], form]) for form in _number_variants(words[-1]))


def _singular(word: str) -> str:
    forms = _number_variants(word)
    return forms[1] if word.endswith("s") and len(forms) > 1 else word


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


def _bare(token: str) -> str:
    """A possessive is its owner's name: "rahul's" searches "rahul"."""
    return token[:-2] if token.endswith("'s") and len(token) > 2 else token


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


def _unique(values: Iterable[str], limit: int = MAX_VARIANTS) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for value in values:
        value = " ".join(value.split()).casefold()
        if _valid_literal(value) and value not in seen:
            seen[value] = None
    return tuple(seen)[:limit]


def _evidence(values: Iterable[str]) -> tuple[str, ...]:
    """Evidence spellings: casefolded and unique, except cased abbreviations."""
    values = list(values)
    cased = [value for value in values if value != value.casefold() and _valid_literal(value)]
    plain = _unique((value for value in values if value == value.casefold()), MAX_EVIDENCE)
    return (*plain, *dict.fromkeys(cased))[:MAX_EVIDENCE]


def _word_concept(word: str) -> Concept:
    literal = _unique(_word_variants(word))
    return Concept(literal[0], literal, _evidence(literal))


def _entry_concept(entry: _Entry, words: tuple[str, ...]) -> Concept:
    """A lexicon concept: the typed trigger is always searched and is evidence."""
    typed = [form for form in _phrase_forms(" ".join(words)) if form not in _CASED_ONLY]
    covered = {form for variant in entry.variants for form in _phrase_forms(variant)}
    # "dl", "mtg" or "epic card" as typed reaches files named that way.
    searched = [
        form
        for form in typed
        if not _DOCUMENT_WORDS & set(form.split()) and not covered & set(_phrase_forms(form))
    ]
    first = entry.canonical if entry.canonical in entry.variants else entry.variants[0]
    variants = _unique((first, *searched, *entry.variants))
    evidence = _evidence((*typed, *entry.strict, *entry.cased))
    return Concept(variants[0], variants, evidence)


def _typo_concept(spelled: str, fixed: Iterable[str]) -> Concept:
    """A built-in spelling fix only discovers, like an owner-vocabulary fix.

    What was typed stays the concept and its only title evidence. The fixed
    spelling and its kind's variants find candidates, never a grant: "fleeting
    notes" is not "meeting notes" and "blank statements" are not bank ones.
    """
    forms = _phrase_forms(spelled)
    literal = _unique((*forms[:1], *fixed))
    return Concept(literal[0], literal, _evidence(forms))


def _content_token(token: str) -> bool:
    return not (
        token in _STOPWORDS
        or token in _COORDINATORS
        or token in _KIND_WORDS
        or token.isdigit()
        or len(token) < 2
    )


def _purpose_clause(tokens: list[str]) -> set[int]:
    """Token positions of "for <purpose>" clauses: context, never search words."""
    skipped: set[int] = set()
    for index, word in enumerate(tokens):
        if word != "for":
            continue
        clause = []
        for position in range(index + 1, len(tokens)):
            if tokens[position] in _COORDINATORS:
                break
            clause.append(position)
        words = [tokens[position] for position in clause if tokens[position] not in _STOPWORDS]
        if (
            words
            and len(words) <= 4
            and all(word in _PURPOSE_WORDS or word in _PURPOSE_MODIFIERS for word in words)
            and any(word in _PURPOSE_WORDS for word in words)
        ):
            skipped.update(clause)
    return skipped


def _explained_drop(word: str, previous: str | None) -> bool:
    """A word left out of the subject that cannot name it.

    Closed filler, politeness, date and count words qualify, and so does the
    Drive location ("from your Google Drive"). Anything else may name the
    subject or issuer the search no longer requires: "one" in "Google One", a
    short identifier ("Flat 12") or a single letter ("Plan B").
    """
    if word in {"drive", "drives"}:
        return previous in _DRIVE_LOCATION
    if word in _SUBJECT_STOPWORDS:
        return False
    if word.isdigit() or word in _NUMBER_WORDS and word not in {"a", "an"}:
        return previous not in _IDENTIFIER_NOUNS
    return word in _STOPWORDS or word == "s"  # "invoice(s)"


@dataclass
class _Unit:
    position: int
    concept: Concept
    family: str | None  # None for a raw topic word
    # A spelling fix: its concept is what was typed and only discovers.
    corrected: bool = False


def interpret_request(
    text: str,
    *,
    now: datetime | None = None,
    timezone: str = "UTC",
    vocabulary: Collection[str] | None = None,
    picked_period: tuple[date, date] | None = None,
) -> RequestBrain:
    """Turn the requester's phrase into concepts, deterministically and offline.

    vocabulary: the owner's title words. A spelling fix toward one of them is
    a discovery variant only; the typed word stays the concept and evidence.
    picked_period: the request's picked dates (see ``_strip_dates``).
    """
    if not isinstance(text, str):
        raise ValueError("request text required")
    current = now if isinstance(now, datetime) and now.tzinfo is not None else None
    today = (
        current.astimezone(_zone(timezone)) if current else datetime.now(_zone(timezone))
    ).date()
    exact_title = _literal_file_name(text)
    quoted = [match.group(1).strip().casefold() for match in _QUOTED.finditer(text)]
    remainder = _NUMBER_SIGN.sub(" no ", _QUOTED.sub(" , ", text))
    remainder, spans = _strip_dates(remainder, today, picked_period)
    remainder, result_limit = _strip_count(remainder)
    tokens = _tokens(remainder)
    kinds: list[str] = []
    units: list[_Unit] = []
    typos: dict[int, str] = {}
    dropped: list[str] = []
    corrected = False
    for start in range(len(tokens)):
        for words in _CORRECTION_PHRASES:
            if _phrase_correction(tokens, start, words):
                # The fixed phrase gives the kind and discovery spellings;
                # what was typed stays the concept and evidence (_typo_concept).
                for offset, word in enumerate(words):
                    if tokens[start + offset] != word:
                        typos[start + offset] = tokens[start + offset]
                        tokens[start + offset] = word
                corrected = True
                break
    skipped = _purpose_clause(tokens)
    position = 0
    while position < len(tokens):
        token = tokens[position]
        if position in skipped:
            position += 1
            continue
        if token in _COORDINATORS:
            units.append(_Unit(position, Concept(",", (",",)), "coordinator"))
            position += 1
            continue
        following = tokens[position + 1] if position + 1 < len(tokens) else None
        if following is not None and (token, _singular(following)) in _KIND_COMPOUNDS:
            # "balance sheet", "pitch deck": a named document, not a file type.
            units.append(_Unit(position, _word_concept(token), None))
            units.append(_Unit(position + 1, _word_concept(following), None))
            position += 2
            continue
        matched = None
        for words, entry in _TRIGGERS:
            if tuple(tokens[position : position + len(words)]) == words:
                matched = (words, entry)
                break
        if matched is not None:
            words, entry = matched
            window = range(position, position + len(words))
            if any(index in typos for index in window):
                spelled = " ".join(typos.get(index, tokens[index]) for index in window)
                concept = _typo_concept(spelled, (" ".join(words), *entry.variants))
                units.append(_Unit(position, concept, entry.family, corrected=True))
            else:
                units.append(_Unit(position, _entry_concept(entry, words), entry.family))
            if _DOCUMENT_WORDS & set(words):
                # "tax documents" consumed the document noun: still documents.
                kinds.append("document")
            position += len(words)
            continue
        position += 1
        if token in _KIND_WORDS:
            if (
                token in _NOUN_KINDS
                and following is not None
                and position not in skipped
                and _content_token(following)
            ):
                # "photo ID", "video production invoice": a modifier stays a word.
                units.append(_Unit(position - 1, _word_concept(token), None))
            else:
                kinds.append(_KIND_WORDS[token])
            continue
        word = _bare(token)
        if position - 1 in typos:
            # A spelling fix that names no lexicon kind ("credt statements").
            concept = _typo_concept(_bare(typos[position - 1]), _word_variants(word))
            units.append(_Unit(position - 1, concept, None, corrected=True))
            continue
        if word == "google" and following in _GOOGLE_PRODUCTS:
            # "Google Drive", "Google Docs": the files' home or type. Anywhere
            # else ("Google invoices") Google is an issuer and a search word.
            continue
        if word in _STOPWORDS or len(word) < 2 or word.isdigit() and len(word) < 3:
            # One- and two-digit numbers are counts or dates; longer ones
            # (account, invoice and form numbers) narrow the search.
            if not _explained_drop(word, tokens[position - 2] if position >= 2 else None):
                dropped.append(word)
            continue
        variants = list(_word_variants(word))
        evidence = _evidence(variants)
        fix = _vocabulary_correction(word, vocabulary)
        if fix is not None:
            corrected = True
            entry = _SINGLE_TRIGGERS.get(fix)
            if entry is not None:
                # The owner's word is a known kind: search its spellings too.
                literal = _unique((word, *entry.variants))
                concept = Concept(literal[0], literal, evidence)
                units.append(_Unit(position - 1, concept, entry.family, corrected=True))
                continue
            variants = [*variants, fix, *_number_variants(fix)[1:]]
        literal = _unique(variants)
        if literal:
            units.append(_Unit(position - 1, Concept(literal[0], literal, evidence), None))
    for phrase in quoted:
        literal = _unique([phrase])
        if literal:
            units.append(_Unit(-1, Concept(literal[0], literal, literal), None))
    if exact_title is not None:
        # The literal file name is the whole subject: its title must equal it.
        units = []
        dropped = []
    # "all files", "September documents", "latest 5 files": a listing on
    # purpose. Words dropped as a purpose clause still carry a subject.
    listing_cue = (
        exact_title is None
        and not skipped
        and (
            any(token in _LISTING_CUES for token in tokens)
            or (bool(spans) or result_limit is not None)
            and any(token in _FILE_NOUNS for token in tokens)
        )
    )
    return _assemble(
        units,
        kinds,
        spans,
        corrected,
        listing_cue=listing_cue,
        result_limit=result_limit,
        exact_title=exact_title,
        dropped=dropped,
    )


def _either(concepts: list[Concept]) -> Concept:
    """Separately listed topics ("Acme or Globex") as one either-or concept."""
    variants = _unique(
        (
            *(concept.canonical for concept in concepts),
            *(variant for concept in concepts for variant in concept.variants),
        )
    )
    evidence = _evidence(literal for concept in concepts for literal in concept.title_evidence)
    return Concept(variants[0], variants, evidence)


def _most_specific(concepts: list[Concept]) -> list[Concept]:
    """At most MAX_TOPICS topics: numbers and longer words first, in typed order."""
    if len(concepts) <= MAX_TOPICS:
        return concepts
    ranked = sorted(
        range(len(concepts)),
        key=lambda index: (
            not any(character.isdigit() for character in concepts[index].canonical),
            -len(concepts[index].canonical),
            index,
        ),
    )
    return [concepts[index] for index in sorted(ranked[:MAX_TOPICS])]


def _assemble(
    units: list[_Unit],
    kinds: list[str],
    spans: list[tuple[date, date]],
    corrected: bool,
    *,
    listing_cue: bool = False,
    result_limit: int | None = None,
    exact_title: str | None = None,
    dropped: Iterable[str] = (),
) -> RequestBrain:
    dropped = list(dropped)
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
    listed = [group for group in raw_groups if group]
    if not lexical and len(listed) > 1:
        # "falcon or eagle": separately listed subjects are a union.
        parts = tuple(DocPart("terms", tuple(unit.concept for unit in group)) for group in listed)[
            :MAX_PARTS
        ]
    else:
        if len(listed) > 1 and all(len(group) == 1 for group in listed):
            # "Acme or Globex invoices": (Acme OR Globex) AND invoices.
            raw = [_either([group[0].concept for group in listed])]
        else:
            raw = [unit.concept for group in listed for unit in group]
        topics = _most_specific(raw)
        # Topic words past the bound are subjects the search no longer requires.
        dropped.extend(concept.canonical for concept in raw if concept not in topics)
        # "meeting notes and minutes": each listed kind is its own alternative.
        parts = tuple(_doc_part(group) for group in lexical)[:MAX_PARTS]
    # Bound the total concept count; topic words are the most specific.
    budget = MAX_CONCEPTS - len(topics)
    bounded = []
    for part in parts:
        concepts = part.concepts[: max(1, budget)]
        dropped.extend(concept.canonical for concept in part.concepts[len(concepts) :])
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
    return RequestBrain(
        tuple(topics),
        parts,
        file_kind,
        period,
        corrected,
        listing=bool(listing_cue and not topics and not parts),
        result_limit=result_limit,
        exact_title=exact_title,
        dropped=tuple(dict.fromkeys(dropped))[:MAX_EVIDENCE],
    )


def _doc_part(group: list[_Unit]) -> DocPart:
    families = {unit.family for unit in group}
    concepts = [unit.concept for unit in group]
    # Title evidence and the generic alternatives come only from words typed
    # as they are: a spelling fix ("fleeting notes") only discovers.
    typed = [unit for unit in group if not unit.corrected]
    typed_families = {unit.family for unit in typed}
    # Only the literal generic ask ("meeting notes", "mtg notes") is satisfied
    # by each named kind on its own; "standup notes" stays standups, and
    # "Notes by Gemini" or "MoM" stays that specific kind.
    generic_notes = "notes" in typed_families and any(
        unit.family == "meeting" and unit.concept.canonical == "meeting" for unit in typed
    )
    if "meeting" in families and "notes" in families or "meeting_notes" in families:
        widen = (
            "meeting" in typed_families
            and "notes" in typed_families
            or "meeting_notes" in typed_families
        )
        concepts = [
            Concept(
                unit.concept.canonical,
                _unique((*unit.concept.variants, *_MEETING_NOTE_VARIANTS)),
                _evidence((*unit.concept.title_evidence, *_MEETING_NOTE_EVIDENCE))
                if widen and not unit.corrected
                else unit.concept.title_evidence,
            )
            if unit.family == "notes"
            else unit.concept
            for unit in group
        ]
        standalone = (
            [Standalone("minutes of meeting", False), Standalone("notes by gemini", False)]
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
    """A LiveSearchPlan-shaped dict; the full concept set stays in the brain.

    A brain with no subject is a complete plan only as an explicit listing
    or a literal file name; anything else is left incomplete (invalid).
    """
    from hushh_mcp.services.drive_suggestion_service import explicitly_requests_file_activity

    terms: list[str] = []
    groups: list[list[str]] = []
    used: set[str] = set()
    for concept in [] if brain.exact_title else list(brain.concepts):
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
        "subject_scope": "specific_records" if terms or brain.exact_title else "metadata_listing",
        "subject_complete": bool(terms or brain.exact_title or brain.listing),
    }
    if brain.exact_title:
        plan["exact_title"] = brain.exact_title
    if file_activity and re.search(r"\b(?:created|uploaded|added)\b", query, re.I):
        plan["file_time_field"] = "createdTime"
    if brain.result_limit is not None:
        # "latest 3 payslips": only the newest N matches are selected.
        plan["result_limit"] = brain.result_limit
        plan["sort"] = "recent"
    elif not terms and not brain.exact_title and brain.file_kind == "any":
        plan["sort"] = "recent"
    return plan


def _plain_literal(value: str) -> bool:
    return _valid_literal(value) and bool(re.fullmatch(r"[^\W_]+(?:[ '\-][^\W_]+)*", value))


def full_text_safe(value: str) -> bool:
    """Drive fullText matches whole tokens; punctuation such as ``1:1`` is title-only."""
    return _plain_literal(value)
