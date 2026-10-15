"""Manifest-backed facts, canonical packets and a separate evidence checker.

No provider, persistence, permission or payment effects are available here.
The caller supplies current, consented, version-bound evidence and owns leases.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import unicodedata
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_citation_references import (
    ReferencedDocumentFacts,
    ReferencedPageFacts,
    fact_references,
    page_references,
    resolve_references,
)
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
from hushh_mcp.services.drive_packet_contract import (
    DocumentFacts,
    DocumentPageFacts,
    PacketProposal,
    PacketRequestMatch,
    PacketVerificationProposal,
    evidence_digest,
    validate_page_citations,
)
from hushh_mcp.services.drive_request_package_assessment import _interpret

MAX_INPUT_BYTES = 160 * 1024
FACTS_SCHEMA_VERSION = "document-facts-v6-record-status"
logger = logging.getLogger(__name__)
MAX_VALIDATION_ATTEMPTS = 2
MONTHS = {
    name: number
    for number, names in enumerate(
        (
            ("january", "jan"),
            ("february", "feb"),
            ("march", "mar"),
            ("april", "apr"),
            ("may",),
            ("june", "jun"),
            ("july", "jul"),
            ("august", "aug"),
            ("september", "sept", "sep"),
            ("october", "oct"),
            ("november", "nov"),
            ("december", "dec"),
        ),
        start=1,
    )
    for name in names
}
_MONTH_WORD = "|".join(sorted(MONTHS, key=len, reverse=True))
_YEAR = re.compile(r"\b(\d{4})\b")
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b")
_ISO_MONTH = re.compile(r"\b(\d{4})[./-](\d{1,2})\b")
_MONTH_YEAR = re.compile(r"\b(\d{1,2})[./-](\d{4})\b")
_NAMED_MONTH_YEAR = re.compile(
    rf"\b({_MONTH_WORD})\.?\s+(?:\d{{1,2}}(?:st|nd|rd|th)?,?\s+)?(\d{{4}})\b", re.I
)
_DAY_NAMED_MONTH_YEAR = re.compile(rf"\b\d{{1,2}}\s+({_MONTH_WORD})\.?,?\s+(\d{{4}})\b", re.I)
_MONTH_NAME = re.compile(rf"\b({_MONTH_WORD})\b", re.I)
ACCOUNT_MISMATCH = "Documents name different accounts"
HOLDER_MISMATCH = "Documents name different account holders"
DIFFERENT_PERSON = "Document names a different person"
OWNER_UNCONFIRMED = "Owner name on file cannot confirm the account holder"


class EvidenceValidationError(ValueError):
    """Privacy-safe model failure; rejected evidence is never persisted as facts."""

    def __init__(self, code, *, issues=None):
        self.code = code
        self.issues = issues or []
        super().__init__(code)


def _validation_code(error):
    if isinstance(error, EvidenceValidationError):
        return error.code
    if isinstance(error, ValidationError):
        if any(
            item["loc"] and item["loc"][0] == "periods"
            for item in error.errors(include_input=False, include_context=False)
        ):
            return "model_period_invalid"
        return "model_schema_invalid"
    return {
        "unsupported fact citation": "model_citation_invalid",
        "unknown citation reference": "model_citation_invalid",
        "unsupported consolidated evidence": "model_citation_invalid",
        "citation location kind differs from extraction": "model_citation_invalid",
        "unaccounted extraction pages": "model_pages_unaccounted",
        "unprocessed pages cannot establish canonical packets": "model_readiness_invalid",
        "invented packet member": "model_membership_invalid",
        "unaccounted packet member": "model_membership_invalid",
        "invalid packet exclusion": "model_membership_invalid",
        "unfinished assembly cannot be ready": "model_readiness_invalid",
        "incomplete evidence cannot verify ready": "model_readiness_invalid",
        "nonready proposal cannot verify ready": "model_readiness_invalid",
        "unsupported standalone packet evidence": "model_readiness_invalid",
        "invented packet match": "model_membership_invalid",
        "unsupported content period": "model_period_invalid",
        "unsupported snapshot scope": "model_period_invalid",
        "requested event is not a snapshot": "model_period_invalid",
        "mixed requested packet evidence": "model_readiness_invalid",
        "requested packet wording mismatch": "model_readiness_invalid",
    }.get(str(error))


def facts_policy_version() -> str:
    manifest = Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml"
    contract = Path(__file__).with_name("drive_packet_contract.py")
    references = Path(__file__).with_name("drive_citation_references.py")
    model = resolve_fleet_model_name("gemini-default")
    return (
        FACTS_SCHEMA_VERSION
        + ":"
        + hashlib.sha256(
            manifest.read_bytes()
            + b"\0"
            + contract.read_bytes()
            + b"\0"
            + references.read_bytes()
            + b"\0"
            + model.encode()
            + b"\0"
            + FACTS_SCHEMA_VERSION.encode()
            + b"\0"
            + EXTRACTION_PROFILE.encode()
        ).hexdigest()
    )


def _schema_issues(error, schema):
    """Return schema coordinates and numeric bounds, never rejected values."""
    names = set()

    def collect(node):
        if isinstance(node, dict):
            names.update(node.get("properties", {}))
            for child in node.values():
                collect(child)
        elif isinstance(node, list):
            for child in node:
                collect(child)

    collect(schema.model_json_schema())
    issues = []
    for item in error.errors(include_input=False, include_context=True)[:8]:
        issue = {
            "path": [
                part if isinstance(part, int) or part in names else "unknown_field"
                for part in item["loc"]
            ],
            "type": item["type"],
        }
        bounds = {
            key: value
            for key, value in (item.get("ctx") or {}).items()
            if key in {"min_length", "max_length", "ge", "gt", "le", "lt", "actual_length"}
            and type(value) in {int, float}
        }
        if bounds:
            issue["bounds"] = bounds
        issues.append(issue)
    return issues


async def _ask(
    mode, payload, schema, *, user_id, interpret=_interpret, validate=None, resolve=None
):
    # A malformed first answer is recoverable. Regenerate once from the same
    # evidence with a host-owned code; never repair citations by guessing text.
    feedback = None
    rejected_answer = None
    for attempt in range(1, MAX_VALIDATION_ATTEMPTS + 1):
        request = {"package_mode": mode, **payload}
        if feedback:
            request["validation_feedback"] = {**feedback, "attempt": attempt}
            request["untrusted_rejected_answer"] = rejected_answer
        prompt = json.dumps(request, ensure_ascii=False)
        if len(prompt.encode()) > MAX_INPUT_BYTES and rejected_answer is not None:
            # Keep all original evidence. The optional failed proposal must not
            # crowd it out, and an omitted proposal is explicit in the retry.
            request.pop("untrusted_rejected_answer")
            request["validation_feedback"]["previous_answer_omitted"] = "input_budget"
            prompt = json.dumps(request, ensure_ascii=False)
        if len(prompt.encode()) > MAX_INPUT_BYTES:
            raise ValueError("evidence_batch_budget_exceeded")
        started = time.monotonic()
        answer = None
        try:
            answer = await interpret(prompt=prompt, user_id=user_id, output_schema=schema)
            result = schema.model_validate(answer)
            if resolve:
                result = resolve(result)
            if validate:
                validate(result)
            return result
        except ValueError as error:
            code = _validation_code(error)
            if code is None:
                raise
            logger.warning(
                "drive_packet_model_validation mode=%s code=%s attempt=%d elapsed_ms=%d",
                mode,
                code,
                attempt,
                round((time.monotonic() - started) * 1000),
            )
            issues = (
                _schema_issues(error, schema)
                if isinstance(error, ValidationError)
                else getattr(error, "issues", [])
            )
            if attempt == MAX_VALIDATION_ATTEMPTS:
                raise EvidenceValidationError(code, issues=issues) from None
            feedback = {"code": code}
            rejected_answer = answer
            if issues:
                feedback["issues"] = issues


def _citation_issues(facts, accepted):
    """Locate rejected citations without returning document or model text."""
    issues = []
    for field in (
        "document_type",
        "issuer",
        "subject",
        "account",
        "record_status",
        "periods",
        "date_evidence",
        "topics",
        "facts",
    ):
        value = getattr(facts, field)
        records = value if isinstance(value, list) else [value]
        for item, record in enumerate(records):
            if record is None:
                continue
            for index, citation in enumerate(record.citations):
                if not accepted(citation):
                    issues.append(
                        {"field": field, "item": item, "citation": index, "page": citation.page}
                    )
                    if len(issues) == 8:
                        return issues
    return issues


async def extract_page_facts(*, user_id, pages, interpret=_interpret):
    page_text = {int(page["page"]): page["text"] for page in pages}
    if len(page_text) != len(pages) or not page_text:
        raise ValueError("invalid extraction pages")
    unit_kinds = {int(p["page"]): p.get("unit_kind", "page") for p in pages}
    encoded_pages, references = page_references(pages)

    def validate(result):
        try:
            validate_page_citations(result, page_text, unit_kinds)
        except ValueError as error:
            issues = _citation_issues(
                result,
                lambda c: (
                    c.page in page_text
                    and c.quote in page_text[c.page]
                    and c.unit_kind == unit_kinds[c.page]
                ),
            )
            raise EvidenceValidationError(_validation_code(error), issues=issues) from None

    return await _ask(
        "page_facts",
        {"untrusted_pages": encoded_pages},
        ReferencedPageFacts,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
        resolve=lambda result: resolve_references(result, references),
    )


def _citations(facts):
    records = [
        facts.document_type,
        facts.issuer,
        facts.subject,
        facts.account,
        facts.record_status,
        *facts.periods,
        *facts.date_evidence,
        *facts.topics,
        *facts.facts,
    ]
    return {(c.page, c.unit_kind, c.quote) for fact in records if fact for c in fact.citations}


def _require_source_periods(periods, source_periods, *, citations=True):
    """Preserve the classified interval, not just a quote containing some date.

    Keep each source window explicit. Combining windows in prose is a model
    decision checked separately; the typed evidence must retain actual bounds.
    """
    for period in periods:
        matches = [
            source
            for source in source_periods
            if (source["start"], source["end"]) == (period["start"], period["end"])
        ]
        if not matches:
            raise ValueError("unsupported content period")
        if citations:
            allowed = {
                (c["page"], c.get("unit_kind", "page"), c["quote"])
                for source in matches
                for c in source["citations"]
            }
            if any(
                (c["page"], c.get("unit_kind", "page"), c["quote"]) not in allowed
                for c in period["citations"]
            ):
                raise ValueError("unsupported content period")


def _quoted_dates(quote):
    """(year, month) pairs, bare month names and bare years a quote states.

    Other digits are not dates. A month name with a year beside it is a pair,
    not a bare month, so last year's month cannot date this year's window.
    """
    pairs, dated_names = set(), set()
    for match in _NUMERIC_DATE.finditer(quote):
        first, second, year = (int(part) for part in match.groups())
        year = year + (2000 if year < 70 else 1900) if year < 100 else year
        pairs.update((year, part) for part in (first, second) if 1 <= part <= 12)
    for pattern, year_group, month_group in ((_ISO_MONTH, 1, 2), (_MONTH_YEAR, 2, 1)):
        for match in pattern.finditer(quote):
            year, month = int(match.group(year_group)), int(match.group(month_group))
            if 1 <= month <= 12:
                pairs.add((year, month))
    for pattern in (_NAMED_MONTH_YEAR, _DAY_NAMED_MONTH_YEAR):
        for match in pattern.finditer(quote):
            pairs.add((int(match.group(2)), MONTHS[match.group(1).casefold()]))
            dated_names.add(match.span(1))
    months = {
        MONTHS[match.group(1).casefold()]
        for match in _MONTH_NAME.finditer(quote)
        if match.span(1) not in dated_names
    }
    years = {int(match.group(1)) for match in _YEAR.finditer(quote)}
    return pairs, months, years


def _period_dated(period):
    """A quote dates a period when its month falls inside the window.

    A window longer than one month is also dated by a quote stating one of
    its years (a tax year, a quarter). One month is not: an edit-month window
    citing a line dated in another month, or only a year, is undated.
    """
    start, end = (date.fromisoformat(period[key]) for key in ("start", "end"))
    first, last = (start.year, start.month), (end.year, end.month)
    span = (last[0] - first[0]) * 12 + last[1] - first[1]
    for citation in period["citations"]:
        pairs, months, years = _quoted_dates(citation["quote"])
        if any(first <= pair <= last for pair in pairs):
            return True
        if any((month - first[1]) % 12 <= span for month in months):
            return True
        if span and any(first[0] <= year <= last[0] for year in years):
            return True
    return False


def _require_dated_periods(periods):
    """A Ready coverage window needs a quote dated inside it.

    A period supported only by undated text (a title, an account line), or by
    a line dated in another month, can come from the file's edit date instead
    of the document. The feedback names the period and what it lacks.
    """
    issues = [
        {"field": "periods", "item": index, "missing": "dated_citation"}
        for index, period in enumerate(periods)
        if not _period_dated(period)
    ]
    if issues:
        raise EvidenceValidationError("model_period_invalid", issues=issues[:8])


def _member_content_keys(item):
    """What identifies a member's content: the provider's checksum of the
    original bytes, and a digest of its full extracted facts (carried as
    facts_digest when only compact evidence is supplied). Identical facts
    count only when they identify a record (an account, a period or dated
    evidence); a shared header alone cannot tell two originals apart, and
    compact summaries are never compared because sparse extractions compact
    alike. The model checker's own duplicate review still applies."""
    keys = []
    if item.get("content_digest"):
        keys.append(("content", item["content_digest"]))
    facts = item.get("facts")
    evidence = facts if isinstance(facts, dict) else item
    digest = evidence_digest(facts) if isinstance(facts, dict) else item.get("facts_digest")
    if digest and any(evidence.get(key) for key in ("account", "periods", "date_evidence")):
        keys.append(("facts", digest))
    return keys


def _require_distinct_member_content(documents, selected):
    """Selected members with one content digest, or one set of extracted
    facts, are one source. The feedback names them; the model keeps one and
    excludes the others as its duplicates."""
    groups = {}
    for item in documents:
        if item["document_id"] not in selected:
            continue
        for key in _member_content_keys(item):
            groups.setdefault(key, []).append(item["document_id"])
    duplicates = sorted({member for ids in groups.values() if len(ids) > 1 for member in ids})
    if duplicates:
        raise EvidenceValidationError(
            "model_membership_invalid",
            issues=[{"field": "selected_document_ids", "duplicate_content": duplicates[:8]}],
        )


def _requested_packet_copy(selected_facts):
    types = []
    for facts in selected_facts:
        if not isinstance(facts, dict):
            continue
        value = facts.get("document_type")
        if isinstance(value, dict):
            value = value.get("value")
        if isinstance(value, str):
            types.append(value.casefold())
    if types and all("wire" in value and "transfer" in value for value in types):
        title = "Wire transfer requests"
        description = "Documents requesting a wire transfer; execution is unverified."
    elif types and all("transfer" in value for value in types):
        title = "Transfer requests"
        description = "Documents requesting a transfer; execution is unverified."
    else:
        title = "Request documents"
        description = "Documents recording requests; completion is unverified."
    return {
        "title": title,
        "description": description,
        "coverage_summary": "Request records only; no completed action or reporting period verified.",
        "pricing_rationale": "Estimate for request documents only; completion is unverified.",
        "utility_rationale": "Request documents are useful as records; completion is unverified.",
    }


def _requested_packet_statuses(selected_facts):
    return [
        (facts.get("record_status") or {}).get("status")
        for facts in selected_facts
        if isinstance(facts, dict) and isinstance(facts.get("record_status"), dict)
    ]


def _request_only_evidence(statuses, selected_facts):
    return (
        bool(statuses)
        and len(statuses) == len(selected_facts)
        and all(status in {"requested", "pending"} for status in statuses)
    )


def _normalize_requested_packet_copy(packet, selected_facts):
    """Every version of a request-only packet carries host-owned copy, Ready or not."""
    statuses = _requested_packet_statuses(selected_facts)
    if not _request_only_evidence(statuses, selected_facts):
        return
    copy = _requested_packet_copy(selected_facts)
    packet.title = copy["title"]
    packet.description = copy["description"]
    packet.coverage_summary = copy["coverage_summary"]
    packet.pricing.rationale = copy["pricing_rationale"]
    packet.utility_rationale = copy["utility_rationale"]


def _check_requested_event_claims(packet, selected_facts):
    """Request-only evidence carries host-owned visible claims and no period, at any state."""
    statuses = _requested_packet_statuses(selected_facts)
    if not any(status in {"requested", "pending"} for status in statuses):
        return
    request_only = _request_only_evidence(statuses, selected_facts)
    if not request_only and packet.state != "ready":
        # A completed record beside the request may evidence execution; only
        # a Ready packet rejects the mix below.
        return
    if packet.temporal_scope not in {"no_period_claim", "unknown"}:
        raise ValueError("requested event is not a snapshot")
    if not request_only:
        raise ValueError("mixed requested packet evidence")
    copy = _requested_packet_copy(selected_facts)
    if (
        packet.title != copy["title"]
        or packet.description != copy["description"]
        or packet.coverage_summary != copy["coverage_summary"]
        or packet.pricing.rationale != copy["pricing_rationale"]
        or packet.utility_rationale != copy["utility_rationale"]
    ):
        raise ValueError("requested packet wording mismatch")


def _fact_value(facts, key):
    """Read one extracted fact from full facts or the checker's compact evidence."""
    value = facts.get(key) if isinstance(facts, dict) else None
    if isinstance(value, dict):
        value = value.get("value")
    return value if isinstance(value, str) and value.strip() else None


def _account_identifier(value):
    """The last four digits of a full or masked account number, else nothing."""
    digits = re.findall(r"\d", value or "")
    return "".join(digits[-4:]) if len(digits) >= 4 else None


_NAME_CONNECTORS = frozenset({"and", "or", "of", "the"})


def _holder_name(value):
    words = re.sub(r"[\W_]+", " ", value or "").casefold().split()
    return frozenset(words) - _NAME_CONNECTORS or None


def _holders_agree(holders):
    """One listing can name the others. A holder is named by a listing when
    its words are a subset of it (a joint listing, a middle name) or share two
    words with it (an initial beside a joint listing). A name sharing at most
    one word with every listing is a different holder."""
    return any(
        all(holder <= listing or len(holder & listing) >= 2 for holder in holders)
        for listing in holders
    )


def _account_mismatch(selected_facts):
    """Read the extracted account facts deterministically; never guess which is right.

    Members with no account fact are left to the model checker. The facts
    contract carries no owner identity or aliases, so a holder name that no
    listing names is reported, not reconciled.
    """
    accounts = [facts for facts in selected_facts if _fact_value(facts, "account")]
    identifiers = {
        identifier
        for facts in accounts
        if (identifier := _account_identifier(_fact_value(facts, "account")))
    }
    if len(identifiers) > 1:
        return ACCOUNT_MISMATCH
    holders = {
        holder
        for facts in (selected_facts if accounts else [])
        if (holder := _holder_name(_fact_value(facts, "subject")))
    }
    if len(holders) > 1 and not _holders_agree(holders):
        return HOLDER_MISMATCH
    return None


_NAME_TITLES = frozenset(
    {"mr", "mrs", "ms", "miss", "mx", "dr", "prof", "jr", "sr", "ii", "iii", "iv"}
)


def _name_words(value):
    """Case, punctuation and accent folded words of a name, in order, with
    titles, suffixes and connectors dropped."""
    folded = unicodedata.normalize("NFKD", value or "")
    folded = "".join(char for char in folded if not unicodedata.combining(char))
    words = re.sub(r"[\W_]+", " ", folded).casefold().split()
    return [word for word in words if word not in _NAME_CONNECTORS | _NAME_TITLES]


def _owner_names(owner):
    """The owner's usable names on file: a spelled-out first and last word each.

    A single word, an initial or a blank cannot confirm whom a record names.
    """
    names = owner.get("names") if isinstance(owner, dict) else None
    usable = []
    for value in names if isinstance(names, list) else []:
        words = _name_words(value) if isinstance(value, str) else []
        if len(words) >= 2 and len(words[0]) >= 2 and len(words[-1]) >= 2:
            usable.append(words)
    return usable


def _names_owner(listing, owner_words):
    """A listing names the owner when it spells the owner's last name and the
    first name or its initial. Middle names, titles, order and the other
    holders of a joint listing are tolerated; a shared surname alone is not.
    Words are compared as a set, so a joint listing's initials are not bound
    to their surnames; the model checker still reads the listing itself."""
    words = set(_name_words(listing))
    first, last = owner_words[0], owner_words[-1]
    return last in words and (first in words or first[0] in words)


def _owner_mismatch(selected_facts, owner):
    """Compare whom each source names with the Drive owner's name on file.

    An account record's subject is its holder (extraction establishes
    ownership before filling it), so one naming someone else closes the
    packet, as does any record naming the owner's surname with another first
    name. The facts contract models no business, trust or alias the owner is
    named on, so those are not guessed Ready either; other subjects are
    topics and stay with the model checker. With no usable name on file an
    account record naming anyone is unconfirmed, never a match. A caller that
    passes no listing at all (the offline eval replay) is not checked; the
    packet worker always passes one.
    """
    if owner is None:
        return None
    names = _owner_names(owner)
    named = [
        (subject, bool(_fact_value(facts, "account")))
        for facts in selected_facts
        if (subject := _fact_value(facts, "subject"))
    ]
    if not names:
        return OWNER_UNCONFIRMED if any(account for _, account in named) else None
    for subject, account in named:
        if any(_names_owner(subject, words) for words in names):
            continue
        if account or any(words[-1] in _name_words(subject) for words in names):
            return DIFFERENT_PERSON
    return None


def _close_source_mismatch(packet, selected_facts, owner):
    """Ready cannot rest on the model checker when the sources disagree about
    the account or name someone other than the owner.

    The packet closes as Incomplete with the reason visible; the host does not
    pick a member and the model is not asked to guess again.
    """
    reason = _account_mismatch(selected_facts) or _owner_mismatch(selected_facts, owner)
    if reason is None:
        return
    packet.state = "incomplete"
    packet.gaps = [*packet.gaps[:63], reason]


async def consolidate_facts(
    *, user_id, previous, page_facts, complete, canonical_context=None, interpret=_interpret
):
    """Bounded fold of observed facts. Original pages remain separately persisted."""
    previous = DocumentFacts.model_validate(previous) if previous is not None else None
    observations = [DocumentPageFacts.model_validate(x) for x in page_facts]
    allowed = set().union(*(_citations(item) for item in observations))
    if previous:
        allowed |= _citations(previous)
    encoded_previous, encoded_observations, references = fact_references(previous, observations)

    def validate(result):
        if not _citations(result) <= allowed:
            raise EvidenceValidationError(
                "model_citation_invalid",
                issues=_citation_issues(
                    result, lambda c: (c.page, c.unit_kind, c.quote) in allowed
                ),
            )
        if not complete and result.canonical_packets:
            raise ValueError("unprocessed pages cannot establish canonical packets")
        source_periods = [
            period.model_dump()
            for source in [*observations, *([previous] if previous else [])]
            for period in source.periods
        ]
        _require_source_periods([period.model_dump() for period in result.periods], source_periods)

    return await _ask(
        "document_facts",
        {
            "previous_facts": encoded_previous,
            "page_observations": encoded_observations,
            "citation_evidence": [{"ref": ref, **citation} for ref, citation in references.items()],
            "all_pages_observed": complete,
            "existing_canonical_packets": canonical_context,
        },
        ReferencedDocumentFacts,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
        resolve=lambda result: resolve_references(result, references, document=True),
    )


async def construct_packet(
    *,
    user_id,
    key,
    documents,
    complete,
    previous=None,
    owner_preferences=None,
    owner=None,
    interpret=_interpret,
):
    allowed = {item["document_id"] for item in documents}
    previous_ids = set(previous["selected_document_ids"]) if previous else set()
    if previous:
        allowed |= previous_ids
        allowed |= {item["document_id"] for item in previous.get("excluded_documents", [])}

    def validate(result):
        selected = set(result.selected_document_ids)
        if not selected <= allowed:
            raise ValueError("invented packet member")
        excluded = {item.document_id for item in result.excluded_documents}
        if not excluded <= allowed:
            raise ValueError("invented packet member")
        if selected | excluded != allowed:
            raise ValueError("unaccounted packet member")
        # Source periods have already passed page and consolidation validation.
        # Prior period citations lack document identities, so reuse them only
        # while every prior selected member remains selected. A later batch may
        # replace an earlier copy using its own selected source evidence.
        # This checks provenance; the model still decides what each period means.
        periods = [
            period
            for item in documents
            if item["document_id"] in selected
            for period in item["facts"].get("periods", [])
        ]
        if previous and previous_ids <= selected:
            periods.extend(previous.get("periods", []))
        citations = {
            (citation["page"], citation.get("unit_kind", "page"), citation["quote"])
            for period in periods
            for citation in period["citations"]
        }
        issues = [
            {"field": "periods", "item": item, "citation": index, "page": citation.page}
            for item, period in enumerate(result.periods)
            for index, citation in enumerate(period.citations)
            if (citation.page, citation.unit_kind, citation.quote) not in citations
        ]
        if issues:
            raise EvidenceValidationError("model_citation_invalid", issues=issues[:8])
        _require_source_periods([period.model_dump() for period in result.periods], periods)
        if result.temporal_scope == "as_of_snapshot":
            current_snapshot = any(
                date.get("role") == "as_of" and date.get("start") is not None
                for item in documents
                if item["document_id"] in selected
                for date in item["facts"].get("date_evidence", [])
            )
            prior_snapshot = (
                previous
                and previous_ids <= selected
                and previous.get("temporal_scope") == "as_of_snapshot"
            )
            if not (current_snapshot or prior_snapshot):
                raise ValueError("unsupported snapshot scope")
        # The owner sees an Incomplete version's copy too, so the request-only
        # wording and period fences hold at every state, not only for Ready.
        selected_facts = [item["facts"] for item in documents if item["document_id"] in selected]
        _normalize_requested_packet_copy(result, selected_facts)
        _check_requested_event_claims(result, selected_facts)
        if result.state == "ready":
            _require_distinct_member_content(documents, selected)
            _require_dated_periods([period.model_dump() for period in result.periods])
            if not complete:
                raise ValueError("unfinished assembly cannot be ready")
            _close_source_mismatch(result, selected_facts, owner)

    return await _ask(
        "canonical_packet",
        {
            "canonical_key": key,
            "documents": documents,
            "previous_packet": previous,
            "all_members_observed": complete,
            "owner_pricing_preferences": owner_preferences,
        },
        PacketProposal,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
    )


async def verify_packet(
    *,
    user_id,
    packet,
    documents,
    complete,
    batch_scope=None,
    owner=None,
    interpret=_interpret,
):
    scope_mode = batch_scope.get("mode") if isinstance(batch_scope, dict) else batch_scope

    def validate(result):
        if result.state == "ready" and not complete:
            raise ValueError("incomplete evidence cannot verify ready")
        selected = packet.get("selected_document_ids", packet.get("selected_document_refs"))
        proposed_state = packet.get("state", packet.get("decision"))
        if result.state == "ready" and (not selected or proposed_state != "ready"):
            raise ValueError("nonready proposal cannot verify ready")
        if result.state == "ready" and "selected_document_ids" in packet:
            accounted = set(selected or []) | {
                item["document_id"] for item in packet.get("excluded_documents", [])
            }
            supplied = {item["document_id"] for item in documents}
            if not supplied <= accounted:
                raise ValueError("unaccounted packet member")
            if (
                scope_mode in {"complete_compact_summary", "complete_current_request_packet"}
                and accounted != supplied
            ):
                raise ValueError("invented packet member")
            # Legacy purchase manifests are read elsewhere. A new ready verdict
            # must validate the new proposal, including its temporal/pricing scope.
            proposal = PacketProposal.model_validate(
                {key: value for key, value in packet.items() if key != "document_request"}
            )
            selected_facts = [
                item.get("facts") if isinstance(item.get("facts"), dict) else item
                for item in documents
                if item["document_id"] in set(selected)
            ]
            if scope_mode in {"complete_compact_summary", "complete_current_request_packet"}:
                _require_source_periods(
                    [period.model_dump() for period in proposal.periods],
                    [
                        period
                        for facts in selected_facts
                        for period in facts.get("periods", facts.get("content_periods", []))
                    ],
                    citations=False,
                )
                if proposal.temporal_scope == "as_of_snapshot" and not any(
                    date.get("role") == "as_of" and date.get("start") is not None
                    for facts in selected_facts
                    for date in facts.get("date_evidence", [])
                ):
                    raise ValueError("unsupported snapshot scope")
                _check_requested_event_claims(proposal, selected_facts)
                _require_distinct_member_content(documents, set(selected))
                _require_dated_periods([period.model_dump() for period in proposal.periods])
                if scope_mode == "complete_compact_summary" and not any(
                    facts.get("facts") or facts.get("periods") for facts in selected_facts
                ):
                    # Type, subject and event/metadata dates alone cannot make
                    # an automatically prepared packet useful to a buyer.
                    # Source facts and periods were citation-checked at indexing.
                    raise ValueError("unsupported standalone packet evidence")
            reason = _account_mismatch(selected_facts) or _owner_mismatch(selected_facts, owner)
            if reason is not None:
                # A batch or final checker that certifies members naming different
                # accounts, or someone other than the owner on file, is overruled
                # by the extracted facts, with the reason kept.
                result.state = "incomplete"
                result.correct_subject_and_account = False
                result.issues = [*result.issues, reason][:64]
        if (
            result.state != "ready"
            and "selected_document_ids" in packet
            and scope_mode in {"complete_compact_summary", "complete_current_request_packet"}
        ):
            selected_facts = [
                item.get("facts") if isinstance(item.get("facts"), dict) else item
                for item in documents
                if item["document_id"] in set(selected or [])
            ]
            if any(
                status in {"requested", "pending"}
                for status in _requested_packet_statuses(selected_facts)
            ):
                # An Incomplete verdict still leaves this copy visible to the
                # owner: the request-only fences hold whatever the verdict says.
                _check_requested_event_claims(
                    PacketProposal.model_validate(
                        {key: value for key, value in packet.items() if key != "document_request"}
                    ),
                    selected_facts,
                )

    return await _ask(
        "packet_verification",
        {
            "proposed_packet": packet,
            "document_facts": documents,
            "all_evidence_current_and_complete": complete,
            "batch_scope": batch_scope,
        },
        PacketVerificationProposal,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
    )


async def match_request_packet(*, user_id, request, packets, interpret=_interpret):
    allowed = {(item["packet_id"], item["version"]) for item in packets}

    def validate(result):
        if result.packet_id is not None and (result.packet_id, result.version) not in allowed:
            raise ValueError("invented packet match")

    return await _ask(
        "packet_request_match",
        {"document_request": request, "packets": packets},
        PacketRequestMatch,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
    )
