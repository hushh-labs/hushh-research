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
    SemanticPlanInputRequired,
    _full_text,
    _identity,
    _metadata_period,
    _quoted,
    parse_semantic_plan,
    semantic_plan_digest,
)

DISCOVERY_DELIVERY_POLICY = "drive_query_matches_v1"
DISCOVERY_PROVIDER_RESULTS_POLICY = "drive_query_results_v2"
DISCOVERY_ACTIVITY_UNION_POLICY = "drive_activity_union_v1"


def activity_union(checkpoint: Mapping) -> bool:
    return checkpoint.get("discovery_delivery_policy") == DISCOVERY_ACTIVITY_UNION_POLICY


def discovery_delivery(checkpoint: Mapping) -> bool:
    return checkpoint.get("discovery_delivery_policy") in {
        DISCOVERY_DELIVERY_POLICY,
        DISCOVERY_PROVIDER_RESULTS_POLICY,
        DISCOVERY_ACTIVITY_UNION_POLICY,
    }


def provider_results_only(checkpoint: Mapping) -> bool:
    """A sealed new policy preserves Google membership without host narrowing."""
    return checkpoint.get("discovery_delivery_policy") in {
        DISCOVERY_PROVIDER_RESULTS_POLICY,
        DISCOVERY_ACTIVITY_UNION_POLICY,
    }


def semantic_checkpoint(
    plan, *, binding, policy, purpose, delivery, provider_results, activity_dates=False
) -> dict:
    """Freeze the model's plan and the selected delivery policy together."""
    if plan is None:
        return {}
    return {
        "semantic_plan": plan,
        "semantic_plan_digest": semantic_plan_digest(plan),
        "semantic_assessment_policy": policy,
        **({"semantic_model_binding": binding} if binding is not None else {}),
        **(
            {
                "discovery_delivery_policy": DISCOVERY_ACTIVITY_UNION_POLICY
                if activity_dates
                else DISCOVERY_PROVIDER_RESULTS_POLICY
                if provider_results
                else DISCOVERY_DELIVERY_POLICY
            }
            if delivery
            else {}
        ),
        **({"activity_fallback_decision": None} if activity_dates else {}),
        "semantic_pending": [],
        "semantic_seen": [],
        "semantic_purpose": purpose,
    }


def provider_date_coverage(enabled: bool, plan: Mapping | None) -> dict:
    if enabled and plan is not None and plan.get("version") == 2:
        return {
            "dateBasis": "activity_union",
            "dateEventBasis": plan["date_basis"],
            "datePolicy": DISCOVERY_ACTIVITY_UNION_POLICY,
            "dateGateApplied": True,
            "datePushdown": plan["date_basis"]
            if plan["date_basis"] in {"created", "modified"}
            else "not_expressed",
            "fallbackActivated": False,
        }
    if not enabled or plan is None:
        return {}
    basis = plan["date_basis"]
    return {
        "dateBasis": "provider_query",
        "datePushdown": basis if basis in {"created", "modified"} else "not_expressed",
    }


def candidate_metadata(checkpoint, match, source, *, resource_key, shareability, evidence) -> dict:
    """Project exact provider metadata into the existing sealed result shape."""
    return {
        "id": match["file_id"],
        "name": match["name"],
        "mimeType": match["mime_type"],
        "modifiedTime": match["modified_time"],
        "createdTime": match["created_time"],
        **{
            key: source[key]
            for key in (
                "modifiedByMeTime",
                "sharedWithMeTime",
                "viewedByMeTime",
                "imageMediaMetadata",
            )
            if key in source
        },
        **(
            {"sourceContentIdentity": source["sourceContentIdentity"]}
            if isinstance(source.get("sourceContentIdentity"), dict)
            else {}
        ),
        **(
            {
                "sourceVersion": str(source.get("version", "")),
                **{key: source[key] for key in ("owners", "sharingUser") if key in source},
            }
            if checkpoint.get("semantic_plan") is not None
            else {}
        ),
        **({"shortcutName": match["shortcut_name"]} if match.get("shortcut_name") else {}),
        **({"resourceKey": resource_key} if resource_key else {}),
        "openUrl": match["open_url"],
        **shareability,
        **evidence,
    }


def _compile_discovery_query(
    plan,
    *,
    file_kind="any",
    period_start=None,
    period_end=None,
    timezone="UTC",
    shared_with_me=False,
    fallback=False,
) -> dict:
    """Compile final provider-search membership, not assessor discovery clues."""
    from hushh_mcp.services.drive_live_reader import MIME_CLAUSES
    from hushh_mcp.services.drive_owner_search_service import _request_discovery_clause

    parsed = parse_semantic_plan(plan)
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
                joiner = (
                    " or "
                    if fallback and getattr(predicate, "sparse_fallback_any_token", False)
                    else " and "
                )
                expression = "(" + joiner.join(atoms) + ")"
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
    return {"arguments": arguments}


def compile_discovery_queries(plan, **kwargs) -> list[dict]:
    """Freeze primary and explicitly authored fallback before any provider read."""
    parsed = parse_semantic_plan(plan)
    primary = _compile_discovery_query(parsed, **kwargs)
    if parsed.version == 1:
        return [primary]
    queries = [dict(primary, role="primary")]
    if any(
        getattr(p, "sparse_fallback_any_token", False) for c in parsed.clauses for p in c.predicates
    ):
        fallback = _compile_discovery_query(parsed, fallback=True, **kwargs)
        if fallback != primary:
            queries.append(dict(fallback, role="frozen_fallback"))
    return queries


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
        "policy": checkpoint.get("discovery_delivery_policy", DISCOVERY_DELIVERY_POLICY),
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
        **(
            {"date_evidence": metadata["activityDateEvidence"]}
            if activity_union(checkpoint)
            else {}
        ),
    }


def discovery_evidence_matches(file: Mapping, *, user_id, generation, checkpoint=None) -> bool:
    """Validate provenance shape; commit also compares the sealed request binding."""
    evidence = file.get("discoveryEvidence")
    if not isinstance(evidence, dict) or file.get("contentVerified") or file.get("requestEvidence"):
        return False
    try:
        if checkpoint is not None:
            bound = dict(checkpoint, query_index=evidence["query_index"])
            if (
                activity_union(bound)
                and bound["queries"][evidence["query_index"]].get("role") == "frozen_fallback"
                and (bound.get("activity_fallback_decision") or {}).get("armed") is not True
            ):
                return False
            if evidence != discovery_evidence(
                bound, user_id=user_id, generation=generation, metadata=file
            ):
                return False
        period = evidence["period"]
        if evidence["policy"] == DISCOVERY_ACTIVITY_UNION_POLICY:
            from hushh_mcp.services.drive_date_ontology import match_activity_dates

            frozen = file.get("activityDateEvidence")
            if (
                frozen != match_activity_dates(dict(file), period, basis=evidence["date_basis"])
                or frozen.get("matched") is not True
                or evidence.get("date_evidence") != frozen
            ):
                return False
        elif "date_evidence" in evidence or "activityDateEvidence" in file:
            return False
        return (
            evidence["policy"]
            in {
                DISCOVERY_DELIVERY_POLICY,
                DISCOVERY_PROVIDER_RESULTS_POLICY,
                DISCOVERY_ACTIVITY_UNION_POLICY,
            }
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
            and evidence["date_basis"]
            in {"title_created_modified", "created", "modified", "activity_union"}
            and isinstance(period, dict)
            and all(isinstance(period[k], str) and period[k] for k in ("start", "end", "timezone"))
        )
    except (KeyError, TypeError, IndexError, ValueError):
        return False


def request_diagnostics(checkpoint):
    """Private, owner-authenticated request GET only; never an operational log."""
    if not activity_union(checkpoint):
        return None
    decision = checkpoint.get("activity_fallback_decision")
    if decision is not None:
        if (
            not isinstance(decision, dict)
            or type(decision.get("first_page_valid_distinct_count")) is not int
            or not 0 <= decision["first_page_valid_distinct_count"] <= 1000
            or type(decision.get("armed")) is not bool
            or decision["armed"] != (decision["first_page_valid_distinct_count"] < 3)
        ):
            raise ValueError("invalid_fallback_decision")
    queries = []
    for index, item in enumerate(checkpoint["queries"]):
        query = item["arguments"]["query"]
        if (
            item.get("role") not in {"primary", "frozen_fallback"}
            or len(query) > MAX_SEMANTIC_QUERY_CHARS
        ):
            raise ValueError("invalid_frozen_query")
        queries.append(
            {
                "index": index,
                "role": item["role"],
                "query": query,
                "queryDigest": hashlib.sha256(query.encode()).hexdigest(),
                "enabled": item["role"] == "primary"
                or isinstance(decision, dict)
                and decision.get("armed") is True,
            }
        )
    if not 1 <= len(queries) <= 2:
        raise ValueError("invalid_frozen_query")
    return {
        "policy": DISCOVERY_ACTIVITY_UNION_POLICY,
        "planDigest": checkpoint["semantic_plan_digest"],
        "planVersion": 2,
        "dateBasis": checkpoint["semantic_plan"]["date_basis"],
        "period": checkpoint["requested_period"],
        "fallbackDecision": (
            {
                "armed": decision["armed"],
                "first_page_valid_distinct_count": decision["first_page_valid_distinct_count"],
            }
            if isinstance(decision, dict)
            else None
        ),
        "queries": queries,
    }
