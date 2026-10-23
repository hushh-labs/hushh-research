"""Versioned Drive-query match delivery, without document-content assessment.

The model owns the expression. This compiler preserves its complete supported
expression; provider matches establish search membership, never consent or
content verification. Private provenance stays in existing encrypted envelopes.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping

from hushh_mcp.services.drive_request_semantic_plan import (
    MAX_SEMANTIC_QUERY_CHARS,
    SemanticDrivePlan,
    SemanticPlanInputRequired,
    _full_text,
    _identity,
    _metadata_period,
    _quoted,
)

DISCOVERY_DELIVERY_POLICY = "drive_query_matches_v1"


def discovery_delivery(checkpoint: Mapping) -> bool:
    return checkpoint.get("discovery_delivery_policy") == DISCOVERY_DELIVERY_POLICY


def compile_discovery_queries(
    plan,
    *,
    file_kind="any",
    period_start=None,
    period_end=None,
    timezone="UTC",
    shared_with_me=False,
) -> list[dict]:
    """Compile final provider-search membership, not assessor discovery clues."""
    from hushh_mcp.services.drive_live_reader import MIME_CLAUSES
    from hushh_mcp.services.drive_owner_search_service import _request_discovery_clause

    parsed = SemanticDrivePlan.model_validate(plan)
    if parsed.status != "ready" or parsed.date_basis == "content":
        raise SemanticPlanInputRequired("provider_search_scope_required")
    if file_kind == "folder":
        raise SemanticPlanInputRequired("original_files_required")
    if file_kind not in {"any", *MIME_CLAUSES}:
        raise ValueError("invalid file kind")
    alternatives = []
    for clause in parsed.clauses:
        required = []
        for predicate in clause.predicates:
            if predicate.kind == "shared_by":
                raise SemanticPlanInputRequired("provider_search_scope_required")
            if predicate.kind == "owner":
                # An authored display name is not a resolved provider identity.
                expression = f"{_quoted(_identity(predicate, {}))} in owners"
            elif predicate.kind == "title" and predicate.match == "exact":
                expression = f"name = {_quoted(predicate.value)}"
            else:
                # Hints/aliases from the old discovery compiler were not final
                # selection criteria. Preserve the actual authored predicate.
                values = (
                    predicate.value.split() if predicate.match == "token" else [predicate.value]
                )
                atoms = []
                for value in values:
                    title = f"name contains {_quoted(value)}"
                    atoms.append(
                        title
                        if predicate.kind == "title"
                        else f"({title} or fullText contains {_full_text(value, phrase=predicate.match != 'token')})"
                    )
                expression = "(" + " and ".join(atoms) + ")"
            required.append(f"not ({expression})" if predicate.negated else expression)
        alternatives.append("(" + " and ".join(required) + ")")
    clauses = [
        "trashed = false",
        "mimeType != 'application/vnd.google-apps.folder'",
        "mimeType != 'application/vnd.google-apps.shortcut'",
    ]
    if alternatives:
        clauses.insert(0, "(" + " or ".join(alternatives) + ")")
    if shared_with_me:
        clauses.append("sharedWithMe = true")
    if file_kind != "any":
        clauses.append(_request_discovery_clause(file_kind))
    period = _metadata_period(
        start=period_start, end=period_end, timezone=timezone, basis=parsed.date_basis
    )
    if period:
        clauses.append(period)
    query = " and ".join(clauses)
    if len(query) > MAX_SEMANTIC_QUERY_CHARS:
        raise SemanticPlanInputRequired("query_budget_exceeded")
    arguments = {"query": query}
    if "fullText contains" not in query:
        field = "createdTime" if parsed.date_basis == "created" else "modifiedTime"
        arguments["orderBy"] = f"{field} desc"
    return [{"arguments": arguments}]


def discovery_evidence(checkpoint: Mapping, *, user_id, generation, metadata) -> dict:
    """Bind a provider result to its immutable request/query/date policy."""
    queries = checkpoint["queries"]
    query_index = checkpoint["query_index"]
    query = queries[query_index]["arguments"]["query"]
    period_origin = checkpoint.get("period_packet_origin")
    origin = (
        {
            "origin_kind": "period_packet",
            "request_id": period_origin["packet_id"],
            "request_revision": period_origin["revision"],
        }
        if period_origin is not None
        else {
            "request_id": checkpoint["request_origin_id"],
            "request_revision": checkpoint["request_revision"],
        }
    )
    return {
        "policy": DISCOVERY_DELIVERY_POLICY,
        "basis": "drive_query",
        "content_assessment": "not_applicable_by_delivery_policy",
        "owner_user_id": user_id,
        **origin,
        "connection_generation": generation,
        "plan_digest": checkpoint["semantic_plan_digest"],
        "query_index": query_index,
        "query_digest": hashlib.sha256(query.encode()).hexdigest(),
        "date_basis": checkpoint["semantic_plan"]["date_basis"],
        "period": checkpoint["requested_period"],
        "source": {key: metadata[key] for key in ("id", "name", "mimeType")},
    }


def discovery_evidence_matches(file: Mapping, *, user_id, generation, checkpoint=None) -> bool:
    """Validate provenance shape; commit also compares the sealed request binding."""
    evidence = file.get("discoveryEvidence")
    if not isinstance(evidence, dict) or file.get("contentVerified") or file.get("requestEvidence"):
        return False
    try:
        if checkpoint is not None:
            bound = dict(checkpoint, query_index=evidence["query_index"])
            if evidence != discovery_evidence(
                bound, user_id=user_id, generation=generation, metadata=file
            ):
                return False
        period = evidence["period"]
        return (
            evidence["policy"] == DISCOVERY_DELIVERY_POLICY
            and evidence["basis"] == "drive_query"
            and evidence["content_assessment"] == "not_applicable_by_delivery_policy"
            and evidence["owner_user_id"] == user_id
            and evidence["connection_generation"] == generation
            and type(evidence["request_revision"]) is int
            and evidence["request_revision"] >= 0
            and isinstance(evidence["request_id"], str)
            and bool(evidence["request_id"])
            and type(evidence["query_index"]) is int
            and evidence["query_index"] >= 0
            and all(
                isinstance(evidence[k], str)
                and len(evidence[k]) == 64
                and all(c in "0123456789abcdef" for c in evidence[k])
                for k in ("plan_digest", "query_digest")
            )
            and evidence["source"] == {key: file[key] for key in ("id", "name", "mimeType")}
            and evidence["date_basis"] in {"title_created_modified", "created", "modified"}
            and isinstance(period, dict)
            and all(isinstance(period[k], str) and period[k] for k in ("start", "end", "timezone"))
        )
    except (KeyError, TypeError, IndexError):
        return False
