"""Versioned product-authored financial discovery. No model output or access authority."""

from hushh_mcp.services.drive_request_discovery import compile_discovery_queries
from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

QUERY_VERSION = "financial-records-v1"
QUERY_SOURCE = {"kind": "predefined", "version": QUERY_VERSION, "planner_executed": False}
# Broad retrieval is deliberate. The existing local organizer supplies advisory
# placements later; these terms never decide that a particular file is financial.
TERMS = (
    "statement",
    "financial",
    "bank",
    "brokerage",
    "insurance",
    "invoice",
    "receipt",
    "tax",
    "balance",
    "portfolio",
    "payslip",
    "pnl",
    "cash flow",
    "transaction",
    "premium",
    "investment",
)


def financial_plan():
    return {
        "file_kind": "any",
        "shared_with_me": False,
        "semantic_query": {
            "version": 1,
            "status": "ready",
            "metadata_listing": False,
            "date_basis": "title_created_modified",
            "clarification": None,
            # Typed descriptor. The separately versioned preset owns the OR
            # expression; this is not model-authored output or a model bypass.
            "clauses": [
                {
                    "predicates": [
                        {
                            "id": "financial_packet",
                            "kind": "semantic",
                            "value": "financial records",
                            "match": "phrase",
                            "negated": False,
                            "discovery_terms": [],
                        }
                    ]
                }
            ],
        },
    }


def financial_queries(*, period_start=None, period_end=None, timezone="UTC"):
    """The fixed product template, using the existing compiler's literal rules.

    Custom model-authored grammar bounds and AND/OR semantics are unchanged.
    Metadata/title date precedence remains a discovery post-filter, as before.
    """
    from hushh_mcp.services.drive_request_semantic_plan import _full_text, _quoted

    plan = financial_plan()["semantic_query"]
    base = compile_discovery_queries(
        {**plan, "metadata_listing": True, "clauses": []},
        period_start=period_start,
        period_end=period_end,
        timezone=timezone,
    )[0]["arguments"]["query"]
    alternatives = [
        f"(name contains {_quoted(term)} or fullText contains {_full_text(term, phrase=True)})"
        for term in TERMS
    ]
    return [{"arguments": {"query": "(" + " or ".join(alternatives) + ") and " + base}}]


def validate_predefined(checkpoint):
    """A source marker is provenance, never a way around arbitrary-query validation."""
    source = checkpoint.get("query_source")
    if source is None:
        return
    plan = financial_plan()["semantic_query"]
    period = checkpoint.get("requested_period", {})
    if (
        source != QUERY_SOURCE
        or not (checkpoint.get("period_packet_origin") or checkpoint.get("provider_packet"))
        or checkpoint.get("semantic_model_binding") is not None
        or checkpoint.get("semantic_plan") != plan
        or checkpoint.get("semantic_plan_digest") != semantic_plan_digest(plan)
        or checkpoint.get("queries")
        != financial_queries(
            period_start=period.get("start"),
            period_end=period.get("end"),
            timezone=period.get("timezone", "UTC"),
        )
    ):
        raise ValueError("invalid predefined financial query")
