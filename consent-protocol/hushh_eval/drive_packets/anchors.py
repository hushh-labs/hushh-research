"""Anchor panel: fixed, burned (dev-only) sources re-graded on every batch.

Expectations are private (they live in the workdir, never in git): a type pattern,
labeled content periods, the expected temporal scope, and optional record-status
rules (a request must not read as executed; a draft must say it is a draft).
Stages mirror the earlier seven-source acceptance: extraction, facts, packet,
each pass / fail / unknown. Packets are formed among the anchors only.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

from hushh_eval.drive_packets.deterministic import execution_claims

ANCHOR_SCHEMA = "dpe.anchor.v1"
DRAFT = re.compile(r"\b(draft|unsigned|unexecuted|not executed|not signed|not finalized)\b", re.I)
CHECKS = (
    "correct_subject_and_account",
    "correct_issuer_and_type",
    "correct_coverage",
    "correct_record_status",
    "correct_standalone_value",
    "no_unrelated_inclusions",
    "no_unexplained_omissions",
)


def load_anchors(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if data.get("schema_version") != ANCHOR_SCHEMA:
        raise ValueError("unsupported_anchor_schema")
    return data["anchors"]


def verdict(status: str, reason: str) -> dict:
    return {"status": status, "reason": reason}


def _pairs(items) -> list[tuple[str, str]]:
    return sorted({(str(item["start"]), str(item["end"])) for item in items})


def grade_extraction(expect: dict, extraction: dict | None) -> dict:
    if not extraction:
        return verdict("unknown", "extraction_missing")
    if not extraction.get("complete"):
        return verdict("unknown", "extraction_incomplete")
    if extraction.get("has_gaps") or extraction.get("total_pages") != expect["pages"]:
        return verdict("fail", "extraction_gap_or_page_mismatch")
    return verdict("pass", "complete_gap_free_original_page_count")


def grade_facts(expect: dict, facts: dict | None) -> dict:
    if not facts:
        return verdict("unknown", "facts_missing")
    kind = (facts.get("document_type") or {}).get("value") or ""
    if not re.search(expect["type_pattern"], kind, re.I):
        return verdict("fail", "fact_type_disagrees_with_label")
    if _pairs(facts.get("periods", [])) != sorted(tuple(item) for item in expect["periods"]):
        return verdict("fail", "fact_period_disagrees_with_label")
    status = (facts.get("record_status") or {}).get("status")
    allowed = expect.get("record_status")
    if allowed and status not in allowed:
        return verdict("fail", "fact_record_status_disagrees_with_label")
    requested = {tuple(item) for item in expect.get("requested_dates", [])}
    if requested:
        roles = [
            item.get("role")
            for item in facts.get("date_evidence", [])
            if (item.get("start"), item.get("end")) in requested
        ]
        if "as_of" in roles:
            return verdict("fail", "requested_date_labeled_as_snapshot")
        if "planned_action" not in roles:
            return verdict("fail", "requested_date_not_planned_action")
    return verdict("pass", "classification_period_status_match_label")


def grade_packet(
    expect: dict, document_id: str, packets: list[dict], labeled: dict[str, dict]
) -> dict:
    """``packets`` are replayed packet finals containing this document."""
    if not packets:
        return verdict("unknown", "canonical_packet_key_abstained")
    outcomes = [_grade_one(expect, document_id, packet, labeled) for packet in packets]
    if any(item["status"] == "pass" for item in outcomes):
        return verdict("pass", "ready_labeled_packet")
    if any(item["status"] == "unknown" for item in outcomes):
        return next(item for item in outcomes if item["status"] == "unknown")
    return outcomes[0]


def _grade_one(expect: dict, document_id: str, packet: dict, labeled: dict[str, dict]) -> dict:
    final = packet.get("final") or {}
    assessment = final.get("assessment") or {}
    checked = final.get("verification") or {}
    if final.get("state") != "ready":
        return verdict("fail", "packet_not_ready")
    if (
        assessment.get("standalone_value") != "supported"
        or assessment.get("gaps")
        or not all(checked.get(key) is True for key in CHECKS)
        or checked.get("issues")
    ):
        return verdict("fail", "packet_readiness_or_checker_failed")
    if not re.search(expect["type_pattern"], assessment.get("title", ""), re.I):
        return verdict("fail", "packet_title_disagrees_with_label")
    if assessment.get("temporal_scope") != expect["temporal_scope"]:
        return verdict("fail", "packet_temporal_scope_disagrees_with_label")
    selected = set(assessment.get("selected_document_ids", []))
    if document_id not in selected:
        return verdict("fail", "target_not_selected")
    if selected - labeled.keys():
        return verdict("unknown", "selected_source_without_label")
    if any(labeled[item]["group"] != expect["group"] for item in selected):
        return verdict("fail", "packet_selected_unrelated_group")
    expected = sorted({tuple(period) for item in selected for period in labeled[item]["periods"]})
    if _pairs(assessment.get("periods", [])) != expected:
        return verdict("fail", "packet_periods_disagree_with_labels")
    visible = [
        assessment.get("title", ""),
        assessment.get("description", ""),
        assessment.get("coverage_summary", ""),
        assessment.get("utility_rationale") or "",
        (assessment.get("pricing") or {}).get("rationale", ""),
    ]
    if expect.get("forbid_execution_claim") and any(execution_claims(value) for value in visible):
        return verdict("fail", "request_execution_overclaim")
    if expect.get("require_draft_disclosure") and not DRAFT.search(" ".join(visible)):
        return verdict("fail", "draft_not_disclosed")
    return verdict("pass", "ready_labeled_packet")


def counts(results: list[dict]) -> dict:
    return {
        stage: dict(Counter(result[stage]["status"] for result in results))
        for stage in ("extraction", "facts", "packet")
    }


def severities(results: list[dict]) -> dict[str, str | None]:
    """S1 per anchor for the deploy gate: wrong period, scope or an execution claim."""
    s1 = {
        "packet_periods_disagree_with_labels",
        "packet_temporal_scope_disagrees_with_label",
        "request_execution_overclaim",
        "fact_period_disagrees_with_label",
        "requested_date_labeled_as_snapshot",
    }
    return {
        result["anchor_id"]: "S1"
        if result["facts"]["reason"] in s1 or result["packet"]["reason"] in s1
        else None
        for result in results
    }
