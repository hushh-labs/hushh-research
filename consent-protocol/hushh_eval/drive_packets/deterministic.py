"""Deterministic packet, delivery and charge checks. They run before any model
judge; a failure here is final and costs no model call.

Severity: S1 wrong person, account or period, or a request shown as executed;
S2 claimed complete but incomplete (gaps, duplicates, fabricated citations,
unauthorized or missing delivery); S3 wording or price-cell problems.
These checks are eval-owned and deliberately independent of the runtime gene.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from hushh_mcp.services.drive_packet_contract import (
    PacketProposal,
    PacketVerificationProposal,
)

CONFIG = Path(__file__).with_name("config")
REQUESTED = {"requested", "pending"}
MONTHS = {
    name: index
    for index, names in enumerate(
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
_ISO = re.compile(r"\b(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?\b")
_US = re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b")
_NAMED = re.compile(rf"\b({_MONTH_WORD})\.?\s+(?:\d{{1,2}}(?:st|nd|rd|th)?,?\s+)?(\d{{4}})\b", re.I)
_DAY_NAMED = re.compile(rf"\b\d{{1,2}}\s+({_MONTH_WORD})\.?,?\s+(\d{{4}})\b", re.I)
_MONTH_ONLY = re.compile(rf"\b({_MONTH_WORD})\b", re.I)
EXECUTION_CLAIM = re.compile(
    r"\b(executed|completed|settled|settlement|posted|processed|transferred|paid|fulfilled|"
    r"wired|moved|cleared|succeeded|successful|confirmed|debited|credited|remitted|"
    r"remittance|arrived|went\s+through)\b",
    re.I,
)
NEGATORS = {"not", "never", "no", "without", "unverified", "unconfirmed", "awaiting", "pending"}
REQUEST_QUALIFIER = re.compile(
    r"\b(request|requests|requested|requesting|pending|unexecuted)\b", re.I
)


@dataclass(frozen=True)
class Finding:
    check: str
    severity: str
    code: str


def load_rubric(path: Path | None = None) -> dict:
    rubric = json.loads((path or CONFIG / "price-rubric.v1.json").read_text())
    if rubric.get("schema_version") != "dpe.price-rubric.v1":
        raise ValueError("unsupported_price_rubric")
    return rubric


def _year(value: str) -> int:
    year = int(value)
    if year < 100:
        year += 2000 if year < 70 else 1900
    return year


def quoted_months(text: str) -> tuple[set[tuple[int, int]], set[int]]:
    """(year, month) pairs and bare month numbers mentioned by a source quote."""
    pairs: set[tuple[int, int]] = set()
    for match in _ISO.finditer(text):
        year, month = int(match.group(1)), int(match.group(2))
        if 1 <= month <= 12:
            pairs.add((year, month))
    for match in _US.finditer(text):
        month, year = int(match.group(1)), _year(match.group(3))
        if 1 <= month <= 12:
            pairs.add((year, month))
    for pattern in (_NAMED, _DAY_NAMED):
        for match in pattern.finditer(text):
            pairs.add((int(match.group(2)), MONTHS[match.group(1).casefold()]))
    bare = {MONTHS[match.group(1).casefold()] for match in _MONTH_ONLY.finditer(text)}
    return pairs, bare


def _month(value: str | None) -> tuple[int, int] | None:
    if not value or len(value) < 7:
        return None
    try:
        parsed = date.fromisoformat(value[:10])
    except ValueError:
        return None
    return parsed.year, parsed.month


def date_source_trap(period: dict, metadata: dict) -> bool:
    """A period equal to the file's modified/created month with no supporting quote."""
    endpoints = {_month(period.get("start")), _month(period.get("end"))} - {None}
    file_months = {
        _month(metadata.get(key))
        for key in ("modifiedTime", "createdTime", "modified_time", "created_time")
    } - {None}
    if not endpoints & file_months:
        return False
    for citation in period.get("citations", []):
        pairs, bare = quoted_months(citation.get("quote", ""))
        if pairs & endpoints or bare & {month for _, month in endpoints}:
            return False
    return True


def execution_claims(text: str) -> list[str]:
    """Un-negated execution words. Negation counts only inside the same clause."""
    claims = []
    for match in EXECUTION_CLAIM.finditer(text or ""):
        clause = re.split(r"[,.;:!?]", text[: match.start()])[-1]
        words = re.findall(r"[a-z]+", clause.casefold())[-3:]
        if not NEGATORS & set(words):
            claims.append(match.group(1).casefold())
    return claims


def _account_last4(fact) -> str | None:
    value = fact.get("value") if isinstance(fact, dict) else fact
    digits = re.findall(r"\d", str(value or ""))
    return "".join(digits[-4:]) if len(digits) >= 4 else None


def _facts(member: dict) -> dict:
    return member.get("facts") or {}


def _status(member: dict) -> str | None:
    record = _facts(member).get("record_status")
    return record.get("status") if isinstance(record, dict) else None


def check_packet(
    packet: dict,
    members: list[dict],
    *,
    verification: dict | None = None,
    rubric: dict | None = None,
) -> list[Finding]:
    findings: list[Finding] = []
    try:
        PacketProposal.model_validate(packet)
    except ValidationError:
        findings.append(Finding("schema", "S2", "packet_schema_invalid"))
    if verification is not None:
        try:
            PacketVerificationProposal.model_validate(verification)
        except ValidationError:
            findings.append(Finding("schema", "S2", "verification_schema_invalid"))
    state = packet.get("state")
    selected_ids = list(packet.get("selected_document_ids") or [])
    excluded = list(packet.get("excluded_documents") or [])
    excluded_ids = [item.get("document_id") for item in excluded]
    member_ids = {member["document_id"] for member in members}
    if (
        len(set(selected_ids)) != len(selected_ids)
        or set(selected_ids) & set(excluded_ids)
        or set(selected_ids) | set(excluded_ids) != member_ids
    ):
        findings.append(Finding("member_accounting", "S2", "member_accounting_invalid"))
    by_id = {member["document_id"]: member for member in members}
    selected = [by_id[item] for item in selected_ids if item in by_id]
    pricing = packet.get("pricing") or {}
    if state == "ready":
        if not selected_ids or packet.get("gaps"):
            findings.append(Finding("ready_invariants", "S2", "ready_with_gaps"))
        if pricing.get("coverage") != "complete" or pricing.get("quality") != "verified":
            findings.append(Finding("ready_invariants", "S2", "ready_without_complete_pricing"))
        if packet.get("standalone_value") != "supported":
            findings.append(Finding("ready_invariants", "S3", "ready_without_standalone_value"))
        if any(item.get("reason") == "unverifiable" for item in excluded):
            findings.append(Finding("ready_invariants", "S2", "ready_hides_unverifiable_member"))
        if any(not member.get("complete", False) for member in selected):
            findings.append(Finding("ready_invariants", "S2", "ready_with_extraction_gap"))
        if verification is not None and verification.get("state") != "ready":
            findings.append(Finding("ready_invariants", "S2", "ready_without_checker_ready"))
    member_periods = {
        (period.get("start"), period.get("end"))
        for member in selected
        for period in _facts(member).get("periods", [])
    }
    for period in packet.get("periods") or []:
        if (period.get("start"), period.get("end")) not in member_periods:
            findings.append(Finding("periods_traced", "S1", "period_not_traced_to_member"))
            break
    for member in selected:
        pages = member.get("pages")
        if pages:
            for record in _citation_records(_facts(member)):
                for citation in record.get("citations", []):
                    text = pages.get(citation.get("page")) or pages.get(str(citation.get("page")))
                    if text is None or citation.get("quote", "") not in text:
                        findings.append(Finding("exact_citations", "S2", "citation_not_exact"))
                        break
        metadata = member.get("metadata") or {}
        if any(date_source_trap(period, metadata) for period in _facts(member).get("periods", [])):
            findings.append(Finding("date_source_trap", "S1", "period_from_file_date"))
    statuses = [_status(member) for member in selected]
    if any(status in REQUESTED for status in statuses):
        if packet.get("temporal_scope") != "no_period_claim":
            findings.append(Finding("requested_event", "S1", "request_shown_as_period"))
        visible = [
            packet.get("title", ""),
            packet.get("description", ""),
            packet.get("coverage_summary", ""),
            pricing.get("rationale", ""),
            packet.get("utility_rationale") or "",
            *[str(gap) for gap in packet.get("gaps") or []],
        ]
        if any(execution_claims(value) for value in visible):
            findings.append(Finding("requested_event", "S1", "request_shown_executed"))
        if not all(REQUEST_QUALIFIER.search(value or "") for value in visible[:2]):
            findings.append(Finding("requested_event", "S3", "request_status_missing"))
    hashes = [member.get("content_sha256") for member in selected if member.get("content_sha256")]
    if any(count > 1 for count in Counter(hashes).values()):
        findings.append(Finding("duplicate_content", "S2", "duplicate_member_content"))
    accounts = {
        last4
        for member in selected
        if (last4 := _account_last4(_facts(member).get("account"))) is not None
    }
    if len(accounts) > 1:
        findings.append(Finding("account_consistency", "S1", "mixed_account_members"))
    findings.extend(check_price(packet, rubric or load_rubric()))
    return findings


def _citation_records(facts: dict) -> list[dict]:
    records = []
    for key in ("document_type", "issuer", "subject", "account", "record_status"):
        if isinstance(facts.get(key), dict):
            records.append(facts[key])
    for key in ("periods", "date_evidence", "topics", "facts"):
        records.extend(item for item in facts.get(key, []) if isinstance(item, dict))
    return records


def check_price(packet: dict, rubric: dict) -> list[Finding]:
    pricing = packet.get("pricing") or {}
    price = pricing.get("suggested_price_cents")
    low, high = rubric["bounds_cents"]
    if type(price) is not int or not low <= price <= high:
        return [Finding("price", "S2", "price_out_of_bounds")]
    cell = rubric["cells"].get(pricing.get("useful_scope"), {}).get(pricing.get("quality"))
    if cell is None:
        return [Finding("price", "S3", "price_rubric_cell_unknown")]
    findings = []
    if not cell[0] <= price <= cell[1]:
        findings.append(Finding("price", "S3", "price_outside_rubric_cell"))
    if packet.get("temporal_scope") in {"as_of_snapshot", "no_period_claim"} and pricing.get(
        "useful_scope"
    ) in {"period", "multi_period"}:
        findings.append(Finding("price", "S3", "snapshot_priced_as_period"))
    return findings


def check_delivery(receipt: dict) -> list[Finding]:
    """Only observed receipts count; simulated receipts must say so."""
    if not receipt.get("observed"):
        return [Finding("delivery", "S3", "delivery_not_observed")]
    delivered = list(receipt.get("delivered_ids") or [])
    approved = set(receipt.get("approved_ids") or [])
    paid = set(receipt.get("paid_ids") or [])
    findings = []
    if set(delivered) - approved or set(delivered) - paid:
        findings.append(Finding("delivery", "S1", "unauthorized_delivery"))
    if len(set(delivered)) != len(delivered):
        findings.append(Finding("delivery", "S1", "duplicate_delivery"))
    if approved != paid or (approved & paid) - set(delivered):
        findings.append(Finding("delivery", "S2", "incomplete_delivery"))
    return findings


def check_charges(charges: list[dict]) -> list[Finding]:
    succeeded = Counter(
        (charge.get("buyer_ref"), charge.get("packet_key"), charge.get("version"))
        for charge in charges
        if charge.get("status") == "succeeded"
    )
    if any(count > 1 for count in succeeded.values()):
        return [Finding("charges", "S1", "duplicate_charge")]
    return []


def check_cross_selection(selections: list[dict]) -> list[Finding]:
    """The same original content sold in two different selections (incident class)."""
    owners: dict[str, str] = {}
    for selection in selections:
        for digest in set(selection.get("content_sha256s") or []):
            other = owners.setdefault(digest, selection["selection_id"])
            if other != selection["selection_id"]:
                return [Finding("cross_selection", "S2", "same_content_in_two_selections")]
    return []


def worst(findings: list[Finding]) -> str | None:
    order = {"S1": 0, "S2": 1, "S3": 2}
    return min((item.severity for item in findings), key=order.__getitem__, default=None)
