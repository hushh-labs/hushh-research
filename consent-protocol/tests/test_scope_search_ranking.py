# tests/test_scope_search_ranking.py
"""
Unit tests for the deterministic scope-search ranking used by the
``search_user_scopes`` MCP tool.

Guardrails under test:
- Ranking is deterministic and pure (no LLM/DB/network).
- Least-privilege first: within a tier the narrowest (longest) scope wins.
- Exact domain match beats substring which beats fuzzy.
- Graceful lookups never raise: unknown query/domain returns an empty list.
- ``limit`` is clamped to [1, 500].
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
    many = [
        {
            "scope": f"attr.financial.field_{index}",
            "domain": "financial",
            "label": f"Field {index}",
        }
        for index in range(600)
    ]
    assert len(rank_scope_matches(many, limit=999)) == 500


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


# --- One picks, the person confirms (consent lifecycle Contract C4) ----------
# UAT 2026-09-28: "What is Kushal Trivedi's favorite restaurant?" took three
# model calls and showed 100 of 251 raw rows; "restaurant" matched nothing.


def _catalog() -> list[dict]:
    return [
        {"scopeRef": "psr_food", "label": "Food preferences", "domain": "food"},
        {"scopeRef": "psr_goals", "label": "Fitness goals", "domain": "health"},
        {"scopeRef": "psr_sleep", "label": "Sleep", "domain": "health"},
        {"scopeRef": "psr_movies", "label": "Favorite movies", "domain": "entertainment"},
        {
            "scopeRef": "psr_food_all",
            "label": "Food & dining information",
            "domain": "food",
            "wildcard": True,
        },
    ]


def test_favorite_restaurant_proposes_food_preferences():
    from hushh_mcp.consent.scope_matcher import match_scopes

    best = match_scopes(
        _catalog(),
        "What is Kushal Trivedi's favorite restaurant?",
        ignore_words=["Kushal Trivedi"],
    )
    # Narrowest food row first (least privilege), never the movies row that
    # only shares the word "favorite".
    assert [match.entry["scopeRef"] for match in best] == ["psr_food", "psr_food_all"]
    assert best[0].why == '"restaurant" relates to food & dining'


def test_training_proposes_a_fitness_goal():
    from hushh_mcp.consent.scope_matcher import match_scopes

    best = match_scopes(_catalog(), "what is he training for", limit=1)
    assert best[0].entry["scopeRef"] == "psr_goals"
    assert best[0].why == '"training" relates to health & wellness'


def test_unknown_question_matches_nothing_and_falls_back_to_top_domains():
    from hushh_mcp.consent.scope_matcher import fallback_scopes, match_scopes

    assert match_scopes(_catalog(), "blood type") == []
    fallback = fallback_scopes(_catalog(), limit=3)
    # Largest domains first; the whole-domain row represents food.
    assert [match.entry["scopeRef"] for match in fallback] == [
        "psr_food_all",
        "psr_sleep",
        "psr_movies",
    ]
    assert {match.via for match in fallback} == {"fallback"}


def test_negative_control_without_synonyms_restaurant_finds_nothing():
    from hushh_mcp.consent.scope_matcher import match_scopes

    assert match_scopes(_catalog(), "favorite restaurant", use_synonyms=False) == []


@pytest.mark.parametrize(
    ("scope", "stored", "expected"),
    [
        (
            "attr.food.preferences.entities.entities.summary",
            "Preferences Entities Entities Summary",
            "Food preferences",
        ),
        ("attr.food.*", "Food Domain", "Food & dining information"),
        ("attr.health.fitness_goals.*", "Fitness Goals", "Fitness goals"),
        ("attr.professional.employment.entities.entities.title", None, "Employment title"),
        ("attr.ria.*", None, "RIA information"),
        # An authored label is a semantic judgement and is never rewritten.
        ("attr.food.weeknight", "Go-to weeknight spots", "Go-to weeknight spots"),
        # A record's metadata field is domain-qualified, never a bare "Kind"
        # (proposed as a scope on localhost, 2026-09-28); its content fields
        # name the record set; a real attribute outside a collection is kept.
        ("attr.food.preferences.entities._entities.kind", "Kind", "Food preferences kind"),
        ("attr.food.preferences.observations._items", "Observations", "Food preferences"),
        ("attr.professional.employment.status", None, "Employment status"),
        # Localhost acceptance run 4 (S3, U3): machine labels a person read.
        ("attr.tax_record.*", "Tax Record Domain", "Tax record"),
        ("attr.legal_entity.*", "Legal Entity Domain", "Legal entity"),
        ("attr.legal_entity.entity.fein", "Fein", "Federal EIN"),
        ("attr.legal_entity.entity.naics_code", "Naics code", "Industry code (NAICS)"),
        ("attr.legal_entity.entity.trade_name_dba", None, "Trade name (DBA)"),
    ],
)
def test_human_scope_labels(scope, stored, expected):
    from hushh_mcp.consent.scope_labels import human_scope_label

    assert human_scope_label(scope, stored) == expected


def test_field_and_value_labels_match_their_shared_truth_table():
    """The client's secure card reads the same contract ("C_CORP" -> "C corporation")."""
    from hushh_mcp.consent.field_labels import human_value_label, known_field_label
    from hushh_mcp.services.generated_contracts import generated_contract_path

    contract = json.loads(generated_contract_path("consent", "field-labels.v1.json").read_text())
    wrong = [
        case
        for case in contract["cases"]
        if (known_field_label(case["key"]) if "key" in case else human_value_label(case["value"]))
        != case["expected"]
    ]
    assert contract["cases"] and wrong == []


@pytest.mark.parametrize("query", ["tax", "tax return", "refund", "irs", "filing"])
def test_tax_words_find_the_tax_record(query):
    """A3 (localhost run 4): "tax", "tax return" and "refund" found nothing."""
    from hushh_mcp.consent.scope_matcher import search_scope_entries

    catalog = [
        *_catalog(),
        {"scopeRef": "psr_tax", "label": "Tax record", "domain": "tax_record", "wildcard": True},
        {"scopeRef": "psr_port", "label": "Portfolio", "domain": "financial"},
    ]
    found = search_scope_entries(catalog, query)
    assert found and found[0]["scopeRef"] == "psr_tax"


def test_machine_rows_never_reach_the_requester_catalog():
    """A3 (localhost run 4): "Schema", "Holdings is editable", "Last updated"."""
    from hushh_mcp.consent.scope_matcher import presentable_scope_entries

    rows = [
        {"scope": "attr.financial.summary.schema", "domain": "financial", "label": "Schema"},
        {"scope": "attr.financial.summary.last_updated", "domain": "financial", "label": "x"},
        {
            "scope": "attr.financial.portfolio.holdings._items.is_editable",
            "domain": "financial",
            "label": "Holdings is editable",
        },
        {
            "scope": "attr.financial.portfolio.holdings._items.symbol_kind",
            "domain": "financial",
            "label": "Holdings symbol kind",
        },
        {"scope": "attr.financial.summary.connection_count", "domain": "financial", "label": "y"},
        {"scope": "attr.financial.summary.account_count", "domain": "financial", "label": "z"},
        {
            "scope": "attr.financial.portfolio.holdings._items.market_value",
            "domain": "financial",
            "label": "Holdings market value",
        },
    ]
    kept = [row["label"] for row in presentable_scope_entries(rows)]
    assert kept == ["Holdings market value"]
