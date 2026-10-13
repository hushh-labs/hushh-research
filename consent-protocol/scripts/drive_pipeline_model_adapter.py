"""Opt-in original-byte benchmark adapter using production semantic functions.

Receives only original inputs from eval_drive_pipeline; no reference labels.
Provider search, permissions, payments and delivery are deliberately unobserved.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
from datetime import date
from pathlib import Path

from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_packet_contract import DocumentFacts
from hushh_mcp.services.drive_packet_intelligence import (
    consolidate_facts,
    extract_page_facts,
    facts_policy_version,
    verify_packet,
)
from hushh_mcp.services.drive_request_package_assessment import (
    assess_document_batch,
    assess_package,
)
from hushh_mcp.services.drive_request_package_service import indexed_evidence_source

_FACTS_CACHE: dict[tuple, dict] = {}


def normalize_coverage_gaps(gaps: list[str]) -> list:
    """Serialize one explicit ISO date range per gap; never infer missing dates.

    Production gaps are explanatory strings; this benchmark's range labels are
    two-item arrays. Unparseable, ambiguous and invalid claims stay as strings
    so exact grading still fails. This does not repair a wrong model interval.
    """
    result = []
    iso_date_pattern = r"(?<![0-9])([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])"
    interval = re.compile(iso_date_pattern + r"\s*(?:to|through|[–—])\s*" + iso_date_pattern)
    for gap in gaps:
        dates = re.findall(iso_date_pattern, gap)
        match = interval.search(gap)
        if len(dates) != 2 or match is None:
            result.append(gap)
            continue
        start, end = match.groups()
        try:
            if date.fromisoformat(start) > date.fromisoformat(end):
                raise ValueError("reversed interval")
        except ValueError:
            result.append(gap)
            continue
        result.append([start, end])
    return result


async def evaluate(*, case, extraction):
    started = time.monotonic()
    documents, sources, flat_facts, reused = [], [], {}, 0
    for document in case["documents"]:
        ref = document["ref"]
        extracted = extraction[ref]
        key = (
            document["sha256"],
            facts_policy_version(),
            extracted["profile"],
            json.dumps(extracted["engine_versions"], sort_keys=True),
        )
        if key in _FACTS_CACHE:
            folded = _FACTS_CACHE[key]
            reused += 1
        else:
            folded = None
            pages = extracted["pages"]
            for start in range(0, len(pages), 4):
                observations = await extract_page_facts(
                    user_id="synthetic-pipeline-eval",
                    pages=[
                        {
                            "page": page["page_number"],
                            "text": page["text"],
                            "unit_kind": "page",
                            "status": page["status"],
                            "quality": page["quality"],
                        }
                        for page in pages[start : start + 4]
                    ],
                )
                facts = await consolidate_facts(
                    user_id="synthetic-pipeline-eval",
                    previous=folded,
                    page_facts=[observations.model_dump()],
                    complete=start + 4 >= len(pages),
                )
                folded = facts.model_dump()
            if folded is None:
                raise ValueError("no_original_pages")
            if len(_FACTS_CACHE) < 100:
                _FACTS_CACHE[key] = folded
        facts = DocumentFacts.model_validate(folded)
        complete = extracted["complete"] and not extracted["has_gaps"]
        indexed = {
            "document_id": ref,
            "source_version": document["source_version"],
            "facts_version": hashlib.sha256(
                json.dumps(folded, sort_keys=True).encode()
            ).hexdigest(),
            "metadata": {"name": ref, **document.get("source_metadata", {})},
            "facts": folded,
            "complete": complete,
        }
        documents.append(indexed)
        sources.append(indexed_evidence_source(document_ref=ref, document=indexed))
        flat_facts[ref] = {
            "issuer": facts.issuer.value if facts.issuer else None,
            "document_type": facts.document_type.value if facts.document_type else None,
            "account": facts.account.value if facts.account else None,
            "subject": facts.subject.value if facts.subject else None,
            "period_start": min((p.start for p in facts.periods), default=None),
            "period_end": max((p.end for p in facts.periods), default=None),
        }
    facts_ms = round((time.monotonic() - started) * 1000)
    assessments = []
    for start in range(0, len(sources), 6):
        batch = await assess_document_batch(
            request=case["request"],
            retrieved={"untrusted_external_content": sources[start : start + 6]},
            user_id="synthetic-pipeline-eval",
        )
        assessments.extend(batch.documents)
    unreadable = [d["document_id"] for d in documents if not d["complete"]]
    packet = await assess_package(
        request=case["request"],
        assessments=assessments,
        user_id="synthetic-pipeline-eval",
        unreadable=unreadable,
        retrieval_counts={"scope": "all_supplied_fixture_documents", "count": len(documents)},
    )
    checker = await verify_packet(
        user_id="synthetic-pipeline-eval",
        packet={"request": case["request"], **packet.model_dump()},
        documents=documents,
        complete=not unreadable,
        batch_scope={"kind": "final_summary", "total_members": len(documents)},
    )
    periods = sorted(
        {
            (p.period_start, p.period_end)
            for item in assessments
            if item.document_ref in packet.selected_document_refs
            for p in item.covered_periods
        }
    )
    status = {
        "ready": "ready",
        "partial": "incomplete",
        "no_match": "unable_to_verify",
        "insufficient_evidence": "unable_to_verify",
    }[packet.decision]
    root = Path(__file__).resolve().parents[1]
    manifest = root / "hushh_mcp/agents/documents/agent.yaml"
    schema = root / "hushh_mcp/services/drive_packet_contract.py"
    return {
        "observation": {
            "status": "completed",
            "discovered_refs": [d["ref"] for d in case["documents"]],
            "selected_refs": packet.selected_document_refs,
            "packet_status": status,
            "document_decisions": {
                item.document_ref: "unknown" if item.decision == "uncertain" else item.decision
                for item in assessments
            },
            "document_facts": flat_facts,
            "coverage": {
                "status": packet.coverage_status,
                "periods": [list(p) for p in periods],
                # Unknown evidence makes no missing-period assertion.
                "gaps": []
                if packet.coverage_status == "unknown"
                else normalize_coverage_gaps(packet.gaps),
            },
            "coverage_gap_claims": packet.gaps,
            "evaluator_accept": checker.state == "ready",
            "suggested_price_cents": packet.suggested_price_cents,
            "usage": {"input_tokens": None, "output_tokens": None, "cost_usd": None},
            "stage_latency_ms": {
                "facts": facts_ms,
                "semantic_total": round((time.monotonic() - started) * 1000),
            },
            "reused_documents": reused,
        },
        "runtime": {
            "code_sha": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip(),
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "schema_sha256": hashlib.sha256(schema.read_bytes()).hexdigest(),
            "provider_model_version": resolve_fleet_model_name("gemini-default"),
            "extraction_version": next(iter(extraction.values()))["profile"],
        },
    }
