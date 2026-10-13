"""Manifest-backed facts, canonical packets and a separate evidence checker.

No provider, persistence, permission or payment effects are available here.
The caller supplies current, consented, version-bound evidence and owns leases.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_packet_contract import (
    DocumentFacts,
    DocumentPageFacts,
    PacketAssessment,
    PacketRequestMatch,
    PacketVerification,
    validate_page_citations,
)
from hushh_mcp.services.drive_request_package_assessment import _interpret

MAX_INPUT_BYTES = 160 * 1024
FACTS_SCHEMA_VERSION = "document-facts-v2"


def facts_policy_version() -> str:
    manifest = Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml"
    contract = Path(__file__).with_name("drive_packet_contract.py")
    model = resolve_fleet_model_name("gemini-default")
    return (
        FACTS_SCHEMA_VERSION
        + ":"
        + hashlib.sha256(
            manifest.read_bytes()
            + b"\0"
            + contract.read_bytes()
            + b"\0"
            + model.encode()
            + b"\0"
            + FACTS_SCHEMA_VERSION.encode()
        ).hexdigest()
    )


async def _ask(mode, payload, schema, *, user_id, interpret=_interpret):
    prompt = json.dumps({"package_mode": mode, **payload}, ensure_ascii=False)
    if len(prompt.encode()) > MAX_INPUT_BYTES:
        raise ValueError("evidence_batch_budget_exceeded")
    result = await interpret(prompt=prompt, user_id=user_id, output_schema=schema)
    return schema.model_validate(result)


async def extract_page_facts(*, user_id, pages, interpret=_interpret):
    page_text = {int(page["page"]): page["text"] for page in pages}
    if len(page_text) != len(pages) or not page_text:
        raise ValueError("invalid extraction pages")
    result = await _ask(
        "page_facts",
        {"untrusted_pages": pages},
        DocumentPageFacts,
        user_id=user_id,
        interpret=interpret,
    )
    validate_page_citations(
        result, page_text, {int(p["page"]): p.get("unit_kind", "page") for p in pages}
    )
    return result


def _citations(facts):
    records = [
        facts.document_type,
        facts.issuer,
        facts.subject,
        facts.account,
        *facts.periods,
        *facts.topics,
        *facts.facts,
    ]
    return {(c.page, c.unit_kind, c.quote) for fact in records if fact for c in fact.citations}


async def consolidate_facts(*, user_id, previous, page_facts, complete, interpret=_interpret):
    """Bounded fold of observed facts. Original pages remain separately persisted."""
    previous = DocumentFacts.model_validate(previous) if previous is not None else None
    observations = [DocumentPageFacts.model_validate(x) for x in page_facts]
    allowed = set().union(*(_citations(item) for item in observations))
    if previous:
        allowed |= _citations(previous)
    result = await _ask(
        "document_facts",
        {
            "previous_facts": previous.model_dump() if previous else None,
            "page_observations": [item.model_dump() for item in observations],
            "all_pages_observed": complete,
        },
        DocumentFacts,
        user_id=user_id,
        interpret=interpret,
    )
    if not _citations(result) <= allowed:
        raise ValueError("unsupported consolidated evidence")
    if not complete and result.canonical_packets:
        raise ValueError("unprocessed pages cannot establish canonical packets")
    return result


async def construct_packet(
    *,
    user_id,
    key,
    documents,
    complete,
    previous=None,
    owner_preferences=None,
    interpret=_interpret,
):
    result = await _ask(
        "canonical_packet",
        {
            "canonical_key": key,
            "documents": documents,
            "previous_packet": previous,
            "all_members_observed": complete,
            "owner_pricing_preferences": owner_preferences,
        },
        PacketAssessment,
        user_id=user_id,
        interpret=interpret,
    )
    allowed = {item["document_id"] for item in documents}
    if previous:
        allowed |= set(previous["selected_document_ids"])
    if not set(result.selected_document_ids) <= allowed:
        raise ValueError("invented packet member")
    if result.state == "ready" and not complete:
        raise ValueError("unfinished assembly cannot be ready")
    return result


async def verify_packet(
    *, user_id, packet, documents, complete, batch_scope=None, interpret=_interpret
):
    result = await _ask(
        "packet_verification",
        {
            "proposed_packet": packet,
            "document_facts": documents,
            "all_evidence_current_and_complete": complete,
            "batch_scope": batch_scope,
        },
        PacketVerification,
        user_id=user_id,
        interpret=interpret,
    )
    if result.state == "ready" and not complete:
        raise ValueError("incomplete evidence cannot verify ready")
    selected = packet.get("selected_document_ids", packet.get("selected_document_refs"))
    proposed_state = packet.get("state", packet.get("decision"))
    if result.state == "ready" and (not selected or proposed_state != "ready"):
        raise ValueError("nonready proposal cannot verify ready")
    return result


async def match_request_packet(*, user_id, request, packets, interpret=_interpret):
    result = await _ask(
        "packet_request_match",
        {"document_request": request, "packets": packets},
        PacketRequestMatch,
        user_id=user_id,
        interpret=interpret,
    )
    if result.packet_id is not None and (result.packet_id, result.version) not in {
        (item["packet_id"], item["version"]) for item in packets
    }:
        raise ValueError("invented packet match")
    return result
