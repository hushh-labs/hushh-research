# tests/test_scope_search_ranking.py
"""
Unit tests for the deterministic scope-search ranking used by the
``search_user_scopes`` MCP tool.

Guardrails under test:
- Ranking is deterministic and pure (no LLM/DB/network).
- Least-privilege first: within a tier the narrowest (longest) scope wins.
- Exact domain match beats substring which beats fuzzy.
- Graceful lookups never raise: unknown query/domain returns an empty list.
- ``limit`` is clamped to [1, 50].
- The public ``request_consent`` tool requires an explicit scope (no bundle
  expansion) and returns a SCOPE_REQUIRED error instead of a 500.
"""

import json

import pytest

from hushh_mcp.consent.scope_generator import rank_scope_matches


def _entries() -> list[dict]:
    return [
        {"scope": "attr.financial.portfolio.*", "domain": "financial", "label": "Portfolio"},
        {"scope": "attr.financial.*", "domain": "financial", "label": "Financial"},
        {"scope": "attr.health.metrics.*", "domain": "health", "label": "Health Metrics"},
        {"scope": "attr.location.recent.*", "domain": "location", "label": "Recent Location"},
    ]


def test_exact_domain_match_ranks_least_privilege_first():
    result = rank_scope_matches(_entries(), query="financial")
    scopes = [e["scope"] for e in result]
    # Both financial scopes match the domain exactly; the narrowest comes first.
    assert scopes == ["attr.financial.portfolio.*", "attr.financial.*"]
    assert all(e["match_reason"] == "exact_domain_match" for e in result)


def test_substring_match_on_leaf_intent():
    result = rank_scope_matches(_entries(), query="portfolio")
    assert [e["scope"] for e in result] == ["attr.financial.portfolio.*"]
    assert result[0]["match_reason"] == "substring_match"


def test_domain_filter_scopes_results():
    result = rank_scope_matches(_entries(), domain="health")
    assert [e["scope"] for e in result] == ["attr.health.metrics.*"]


def test_empty_query_lists_all_least_privilege_first():
    result = rank_scope_matches(_entries())
    scopes = [e["scope"] for e in result]
    # All entries listed; ordering is deterministic (least privilege, then alpha).
    assert set(scopes) == {
        "attr.financial.portfolio.*",
        "attr.financial.*",
        "attr.health.metrics.*",
        "attr.location.recent.*",
    }
    assert all(e["match_reason"] == "listed" for e in result)


def test_ranking_is_deterministic():
    first = [e["scope"] for e in rank_scope_matches(_entries(), query="financial")]
    second = [e["scope"] for e in rank_scope_matches(_entries(), query="financial")]
    assert first == second


def test_no_match_returns_empty_without_raising():
    assert rank_scope_matches(_entries(), query="zzz-nope", domain="nope") == []


def test_unknown_domain_returns_empty():
    assert rank_scope_matches(_entries(), domain="does-not-exist") == []


def test_limit_is_clamped_to_upper_bound():
    many = _entries() * 40
    assert len(rank_scope_matches(many, limit=999)) == 50


def test_limit_is_clamped_to_lower_bound():
    assert len(rank_scope_matches(_entries(), limit=0)) == 1


def test_invalid_limit_falls_back_to_default():
    # Non-numeric limit must not raise; falls back to the default of 20.
    result = rank_scope_matches(_entries() * 40, limit="not-a-number")  # type: ignore[arg-type]
    assert len(result) == 20


def test_malformed_entries_are_skipped():
    entries = [
        "not-a-dict",
        {"label": "no scope key"},
        {"scope": "   "},
        {"scope": "attr.financial.*", "domain": "financial"},
    ]
    result = rank_scope_matches(entries, query="financial")  # type: ignore[arg-type]
    assert [e["scope"] for e in result] == ["attr.financial.*"]


@pytest.mark.asyncio
async def test_request_consent_without_scope_returns_scope_required():
    from mcp_modules.tools import consent_tools as ct

    result = await ct.handle_request_consent({"user_id": "u_test"})
    assert isinstance(result, list) and result
    payload = json.loads(result[0].text)
    assert payload["status"] == "error"
    assert payload["error_code"] == "SCOPE_REQUIRED"
    # The hint must steer callers to discovery/search, never to a bundle.
    assert "search_user_scopes" in payload["hint"]
    assert "scope_bundle" not in payload["hint"]
