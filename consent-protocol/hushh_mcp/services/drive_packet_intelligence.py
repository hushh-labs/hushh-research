"""Manifest-backed facts, canonical packets and a separate evidence checker.

No provider, persistence, permission or payment effects are available here.
The caller supplies current, consented, version-bound evidence and owns leases.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
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
    validate_page_citations,
)
from hushh_mcp.services.drive_request_package_assessment import _interpret

MAX_INPUT_BYTES = 160 * 1024
FACTS_SCHEMA_VERSION = "document-facts-v6-record-status"
logger = logging.getLogger(__name__)
MAX_VALIDATION_ATTEMPTS = 2


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


def _require_distinct_member_content(documents, selected):
    """Equal provider checksums identify one original; facts similarity does not."""
    groups = {}
    for item in documents:
        digest = item.get("content_digest")
        if item["document_id"] in selected and digest:
            groups.setdefault(digest, []).append(item["document_id"])
    duplicates = sorted({member for ids in groups.values() if len(ids) > 1 for member in ids})
    if duplicates:
        raise EvidenceValidationError(
            "model_membership_invalid",
            issues=[{"field": "selected_document_ids", "duplicate_content": duplicates[:8]}],
        )


def _requested_packet_statuses(selected_facts):
    return [
        (facts.get("record_status") or {}).get("status")
        for facts in selected_facts
        if isinstance(facts, dict) and isinstance(facts.get("record_status"), dict)
    ]


def _check_requested_event_claims(packet, selected_facts):
    """Validate typed scope; the authored checker assesses wording and meaning."""
    statuses = _requested_packet_statuses(selected_facts)
    if not any(status in {"requested", "pending"} for status in statuses):
        return
    request_only = len(statuses) == len(selected_facts) and all(
        status in {"requested", "pending"} for status in statuses
    )
    if packet.state != "ready" and not request_only:
        return
    if packet.temporal_scope not in {"no_period_claim", "unknown"}:
        raise ValueError("requested event is not a snapshot")
    if not request_only:
        raise ValueError("mixed requested packet evidence")


def _model_view(item):
    """Keep provider context free of host-only file timestamps."""
    if not isinstance(item, dict):
        return item
    return {key: value for key, value in item.items() if key != "created_time"}


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
        selected_facts = [item["facts"] for item in documents if item["document_id"] in selected]
        _check_requested_event_claims(result, selected_facts)
        if result.state == "ready":
            _require_distinct_member_content(documents, selected)
        if result.state == "ready" and not complete:
            raise ValueError("unfinished assembly cannot be ready")

    return await _ask(
        "canonical_packet",
        {
            "canonical_key": key,
            "documents": [_model_view(item) for item in documents],
            "previous_packet": previous,
            "all_members_observed": complete,
            "owner_pricing_preferences": owner_preferences,
            "owner_identity": owner,
        },
        PacketProposal,
        user_id=user_id,
        interpret=interpret,
        validate=validate,
    )


async def verify_packet(
    *, user_id, packet, documents, complete, batch_scope=None, owner=None, interpret=_interpret
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
            if scope_mode in {"complete_compact_summary", "complete_current_request_packet"}:
                selected_facts = [
                    item.get("facts") if isinstance(item.get("facts"), dict) else item
                    for item in documents
                    if item["document_id"] in set(selected)
                ]
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
                if scope_mode == "complete_compact_summary" and not any(
                    facts.get("facts") or facts.get("periods") for facts in selected_facts
                ):
                    # Type, subject and event/metadata dates alone cannot make
                    # an automatically prepared packet useful to a buyer.
                    # Source facts and periods were citation-checked at indexing.
                    raise ValueError("unsupported standalone packet evidence")

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
            "document_facts": [_model_view(item) for item in documents],
            "all_evidence_current_and_complete": complete,
            "batch_scope": batch_scope,
            "owner_identity": owner,
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
