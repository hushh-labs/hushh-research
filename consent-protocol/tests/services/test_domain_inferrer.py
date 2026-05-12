"""Behavioral contract tests for DomainInferrer rule engine.

DomainInferrer auto-categorizes attribute keys into domains using a keyword +
regex-pattern scoring engine. The class and its singleton factory are pure
(no DB, network, or LLM required), making them ideal for hermetic unit tests.

Canonical attach point:
  hushh_mcp.services.domain_inferrer.DomainInferrer.infer
  -> get_domain_inferrer() singleton
  -> Owner: hushh_mcp.services.domain_inferrer (pure utility, no route dependency)
  -> Consumed by attribute classification callers that import get_domain_inferrer()

Coverage:
- DomainInferrer.infer -- keyword match, pattern match, value_hint, ambiguous,
  no-match fallback, empty/whitespace input, None-safe value_hint
- DomainInferrer.infer_with_confidence -- domain + (0.0-1.0) confidence
- DomainInferrer.get_domain_metadata -- display_name, icon, color fields
- DomainInferrer.add_rule -- new domain, keyword merge, pattern compile and match
- DomainInferrer.list_domains -- all known keys present
- get_domain_inferrer -- singleton identity
- TestDomainInferrerCanonicalServiceProof -- confirms the service is importable,
  callable, and the rule engine is active in the current owner path
"""

from __future__ import annotations

import inspect

import pytest

from hushh_mcp.services.domain_inferrer import DomainInferrer, get_domain_inferrer


@pytest.fixture
def inferrer() -> DomainInferrer:
    """Fresh inferrer with default DOMAIN_RULES for each test."""
    return DomainInferrer()


# ---------------------------------------------------------------------------
# infer -- domain classification
# ---------------------------------------------------------------------------


class TestInfer:
    def test_portfolio_key_inferred_as_financial(self, inferrer):
        assert inferrer.infer("portfolio_value") == "financial"

    def test_stock_ticker_key_inferred_as_financial(self, inferrer):
        assert inferrer.infer("stock_ticker") == "financial"

    def test_subscription_key_inferred_as_subscriptions(self, inferrer):
        assert inferrer.infer("netflix_subscription") == "subscriptions"

    def test_health_key_inferred_as_health(self, inferrer):
        assert inferrer.infer("fitness_tracker") == "health"

    def test_travel_key_inferred_as_travel(self, inferrer):
        assert inferrer.infer("flight_booking") == "travel"

    def test_food_key_inferred_as_food(self, inferrer):
        # "dietary_meal" matches both food keywords and the r".*_meal$" pattern
        assert inferrer.infer("dietary_meal") == "food"

    def test_professional_key_inferred_as_professional(self, inferrer):
        assert inferrer.infer("job_title") == "professional"

    def test_entertainment_key_inferred_as_entertainment(self, inferrer):
        assert inferrer.infer("gaming_hours") == "entertainment"

    def test_shopping_key_inferred_as_shopping(self, inferrer):
        assert inferrer.infer("purchase_history") == "shopping"

    def test_social_key_inferred_as_social(self, inferrer):
        assert inferrer.infer("twitter_followers") == "social"

    def test_location_key_inferred_as_location(self, inferrer):
        assert inferrer.infer("home_address") == "location"

    def test_unrecognized_key_returns_general(self, inferrer):
        assert inferrer.infer("zzz_completely_unknown_xyz") == "general"

    def test_key_matching_is_case_insensitive(self, inferrer):
        assert inferrer.infer("Portfolio_VALUE") == "financial"

    def test_value_hint_breaks_ambiguous_tie(self, inferrer):
        # "plan" appears in subscriptions keywords; value_hint reinforces it
        result = inferrer.infer("user_plan", value_hint="monthly streaming service")
        assert result == "subscriptions"

    def test_none_value_hint_does_not_crash(self, inferrer):
        assert inferrer.infer("stock_portfolio", value_hint=None) == "financial"

    def test_empty_value_hint_does_not_crash(self, inferrer):
        assert inferrer.infer("stock_portfolio", value_hint="") == "financial"

    def test_pattern_match_on_ticker_suffix(self, inferrer):
        # r".*_ticker$" in financial patterns
        assert inferrer.infer("company_ticker") == "financial"

    def test_pattern_match_on_portfolio_substring(self, inferrer):
        # r".*_portfolio.*" in financial patterns
        assert inferrer.infer("my_portfolio_snapshot") == "financial"

    def test_hyphenated_key_normalized_before_scoring(self, inferrer):
        # hyphens -> spaces before keyword matching
        assert inferrer.infer("stock-ticker") == "financial"


# ---------------------------------------------------------------------------
# infer_with_confidence
# ---------------------------------------------------------------------------


class TestInferWithConfidence:
    def test_returns_tuple(self, inferrer):
        result = inferrer.infer_with_confidence("portfolio_value")
        assert isinstance(result, tuple) and len(result) == 2

    def test_domain_matches_infer(self, inferrer):
        domain, _ = inferrer.infer_with_confidence("stock_ticker")
        assert domain == "financial"

    def test_confidence_in_range_0_to_1(self, inferrer):
        _, confidence = inferrer.infer_with_confidence("netflix_subscription")
        assert 0.0 <= confidence <= 1.0

    def test_strong_match_has_higher_confidence_than_weak(self, inferrer):
        # "portfolio_investment_stock_ticker_shares" -- many financial keywords
        _, strong_conf = inferrer.infer_with_confidence("portfolio_investment_stock_ticker")
        _, weak_conf = inferrer.infer_with_confidence("asset")  # single keyword
        assert strong_conf >= weak_conf

    def test_no_match_returns_general_with_zero_confidence(self, inferrer):
        domain, confidence = inferrer.infer_with_confidence("zzz_completely_unknown_xyz")
        assert domain == "general"
        assert confidence == 0.0

    def test_confidence_not_greater_than_one(self, inferrer):
        # Even an extremely keyword-dense key must not exceed 1.0
        long_key = "_".join(["portfolio", "stock", "investment", "equity", "ticker", "shares"])
        _, confidence = inferrer.infer_with_confidence(long_key)
        assert confidence <= 1.0


# ---------------------------------------------------------------------------
# get_domain_metadata
# ---------------------------------------------------------------------------


class TestGetDomainMetadata:
    def test_financial_domain_has_display_name(self, inferrer):
        meta = inferrer.get_domain_metadata("financial")
        assert meta["display_name"] == "Financial"

    def test_returns_all_required_keys(self, inferrer):
        meta = inferrer.get_domain_metadata("subscriptions")
        assert {"display_name", "icon", "color"} <= set(meta.keys())

    def test_unknown_domain_returns_defaults(self, inferrer):
        meta = inferrer.get_domain_metadata("nonexistent_domain")
        # str.title() preserves underscores: "nonexistent_domain" -> "Nonexistent_Domain"
        assert meta["display_name"] == "Nonexistent_Domain"
        assert meta["icon"] == "folder"
        assert meta["color"] == "#6B7280"

    def test_health_domain_metadata(self, inferrer):
        meta = inferrer.get_domain_metadata("health")
        assert "Health" in meta["display_name"]

    def test_color_is_hex_string(self, inferrer):
        for domain in inferrer.list_domains():
            color = inferrer.get_domain_metadata(domain)["color"]
            assert color.startswith("#"), f"domain {domain!r} color {color!r} is not hex"


# ---------------------------------------------------------------------------
# add_rule
# ---------------------------------------------------------------------------


class TestAddRule:
    def test_new_domain_added_and_inferrable(self, inferrer):
        inferrer.add_rule("crypto", keywords=["bitcoin", "ethereum", "defi"])
        assert inferrer.infer("bitcoin_wallet") == "crypto"

    def test_existing_domain_keywords_merged(self, inferrer):
        inferrer.add_rule("financial", keywords=["defi", "staking"])
        assert "defi" in inferrer.rules["financial"]["keywords"]
        assert "staking" in inferrer.rules["financial"]["keywords"]

    def test_new_pattern_compiled_and_matches(self, inferrer):
        inferrer.add_rule("crypto", patterns=[r".*_crypto$"])
        assert inferrer.infer("my_holding_crypto") == "crypto"

    def test_display_name_updated(self, inferrer):
        inferrer.add_rule("financial", display_name="Wealth Management")
        assert inferrer.get_domain_metadata("financial")["display_name"] == "Wealth Management"

    def test_icon_updated(self, inferrer):
        inferrer.add_rule("financial", icon="piggy-bank")
        assert inferrer.get_domain_metadata("financial")["icon"] == "piggy-bank"

    def test_color_updated(self, inferrer):
        inferrer.add_rule("financial", color="#AABBCC")
        assert inferrer.get_domain_metadata("financial")["color"] == "#AABBCC"

    def test_new_domain_default_metadata_set(self, inferrer):
        inferrer.add_rule("testdomain", keywords=["testword"])
        meta = inferrer.get_domain_metadata("testdomain")
        assert meta["icon"] == "folder"
        assert meta["color"] == "#6B7280"


# ---------------------------------------------------------------------------
# list_domains
# ---------------------------------------------------------------------------


class TestListDomains:
    def test_all_builtin_domains_present(self, inferrer):
        domains = inferrer.list_domains()
        expected = {
            "financial",
            "subscriptions",
            "health",
            "travel",
            "food",
            "professional",
            "entertainment",
            "shopping",
            "social",
            "location",
        }
        assert expected <= set(domains)

    def test_returns_list(self, inferrer):
        assert isinstance(inferrer.list_domains(), list)

    def test_added_domain_appears_in_list(self, inferrer):
        inferrer.add_rule("custom_domain", keywords=["foo"])
        assert "custom_domain" in inferrer.list_domains()


# ---------------------------------------------------------------------------
# get_domain_inferrer -- singleton
# ---------------------------------------------------------------------------


class TestGetDomainInferrer:
    def test_returns_domain_inferrer_instance(self):
        assert isinstance(get_domain_inferrer(), DomainInferrer)

    def test_repeated_calls_return_same_object(self):
        a = get_domain_inferrer()
        b = get_domain_inferrer()
        assert a is b


# ---------------------------------------------------------------------------
# Canonical service proof
# ---------------------------------------------------------------------------


class TestDomainInferrerCanonicalServiceProof:
    """
    Prove the DomainInferrer rule engine is reachable through the current
    owner path.

    Canonical attach point:
      hushh_mcp.services.domain_inferrer.DomainInferrer.infer
      -> get_domain_inferrer() singleton factory
      -> Owner: hushh_mcp.services.domain_inferrer (pure, no external deps)
      -> Consumed by attribute classification callers via get_domain_inferrer()

    Note: the architecture compliance suite (test_architecture_compliance.py)
    explicitly enforces that PersonalKnowledgeModelService does NOT import
    domain_inferrer (legacy guard). The canonical entry point is therefore
    get_domain_inferrer() itself, callable from any attribute classification
    surface that needs rule-based domain labeling.
    """

    def test_get_domain_inferrer_is_importable(self):
        """The singleton factory must be importable without any external deps."""
        from hushh_mcp.services.domain_inferrer import get_domain_inferrer as gdi

        assert callable(gdi)

    def test_singleton_exercises_rule_engine(self):
        """get_domain_inferrer() must return a live DomainInferrer whose infer() works."""
        di = get_domain_inferrer()
        result = di.infer("portfolio_value")
        assert result == "financial", (
            "Rule engine not active in singleton -- get_domain_inferrer() is broken"
        )

    def test_singleton_infer_with_confidence_works(self):
        """infer_with_confidence on the singleton must return a valid (domain, float) pair."""
        di = get_domain_inferrer()
        domain, confidence = di.infer_with_confidence("stock_ticker")
        assert domain == "financial"
        assert 0.0 < confidence <= 1.0

    def test_singleton_list_domains_non_empty(self):
        """Singleton must expose at least the core domain set."""
        di = get_domain_inferrer()
        domains = di.list_domains()
        assert len(domains) >= 10, "Core domain set must have at least 10 entries"
        assert "financial" in domains

    def test_singleton_add_rule_extends_live_engine(self):
        """add_rule on the singleton must extend the live rule engine."""
        di = get_domain_inferrer()
        # Use a unique domain name so state from other tests does not interfere
        di.add_rule("_test_canonical_proof", keywords=["canonical_proof_kw"])
        assert "_test_canonical_proof" in di.list_domains()
        assert di.infer("canonical_proof_kw_attr") == "_test_canonical_proof"

    def test_domain_inferrer_module_is_self_contained(self):
        """domain_inferrer.py must not import from routes or external services."""
        import hushh_mcp.services.domain_inferrer as mod

        src = inspect.getsource(mod)
        assert "from api.routes" not in src, (
            "DomainInferrer must not import from api.routes"
        )
        assert "import fastapi" not in src.lower(), (
            "DomainInferrer must remain a pure utility without FastAPI dependency"
        )

    def test_infer_returns_string_for_any_input(self):
        """infer() must never raise - it must always return a domain string."""
        di = get_domain_inferrer()
        for key in ("", "   ", "abc", "portfolio", "xyzzy_unknown_9999"):
            result = di.infer(key)
            assert isinstance(result, str), f"infer({key!r}) did not return a string"
