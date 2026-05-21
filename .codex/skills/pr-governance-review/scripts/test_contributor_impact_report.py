#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("contributor_impact_report.py")
SPEC = importlib.util.spec_from_file_location("contributor_impact_report", SCRIPT)
assert SPEC and SPEC.loader
report = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = report
SPEC.loader.exec_module(report)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _fake_pr(
    number: int,
    author: str,
    title: str,
    *,
    merged: bool = False,
    comments: list[dict[str, object]] | None = None,
    reviews: list[dict[str, object]] | None = None,
    merged_by: str | None = None,
    files: list[str] | None = None,
) -> dict[str, object]:
    return {
        "number": number,
        "title": title,
        "author": {"login": author},
        "url": f"https://github.com/hushh-labs/hushh-research/pull/{number}",
        "createdAt": "2026-05-14T00:00:00Z",
        "closedAt": "2026-05-14T01:00:00Z",
        "mergedAt": "2026-05-14T01:00:00Z" if merged else None,
        "mergedBy": {"login": merged_by} if merged_by else None,
        "additions": 12,
        "deletions": 4,
        "changedFiles": 1,
        "labels": [],
        "files": [{"path": path} for path in (files or ["hushh-webapp/components/app-ui/top-app-bar.tsx"])],
        "comments": comments
        if comments is not None
        else [{"body": "Closed as superseded after maintainer harvest."}],
        "reviews": reviews or [],
        "latestReviews": reviews or [],
    }


def test_harvested_source_gets_internal_credit() -> None:
    records = report._analysis(
        [_fake_pr(808, "imsharukhan", "fix: improve TopAppBar back button touch target")]
    )

    item = records[0]
    _assert(item["lifecycle"] == "harvested_source", "source PR must be a harvest lifecycle")
    _assert(item["author"] == "imsharukhan", "source author must keep credit")
    _assert(item["harvestedInto"] == 1013, "source PR must link to maintainer landing PR")
    _assert(item["score"] > 0, "harvested source must receive positive internal impact")

    leaderboard = report._leaderboard(records)
    _assert(leaderboard[0]["harvested"] == 1, "leaderboard must count harvest credits")


def test_harvest_attribution_names_external_ledger_boundary() -> None:
    records = report._analysis(
        [_fake_pr(808, "imsharukhan", "fix: improve TopAppBar back button touch target")]
    )

    lines = "\n".join(report._harvest_attribution_lines(records))
    _assert(
        "co-authored on the harvest replay follow-up once it lands" in lines,
        "harvest report must name the external GitHub attribution path",
    )
    _assert(
        "does not change #1013's original merge authorship or original additions/deletions" in lines,
        "harvest report must not imply original merge history changed",
    )


def test_maintainer_patch_dual_credits_source_and_operator() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2001,
                "feature-author",
                "fix: strengthen consent token validation",
                merged=True,
                merged_by="kushaltrivedi5",
                comments=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "body": "### Maintainer Patch\nAccepted value was normalized into the canonical consent path.",
                    }
                ],
            )
        ]
    )

    item = records[0]
    _assert(item["author"] == "feature-author", "source author must remain unchanged")
    _assert(item["source_impact_score"] > 0, "source score must remain positive")
    _assert(item["operator_impact_score"] > 0, "maintainer operator score must be added")
    _assert(
        item["composite_impact_score"] == item["source_impact_score"] + item["operator_impact_score"],
        "composite score must equal source plus operator score",
    )
    _assert(item["balanced_impact_score"] < item["composite_impact_score"], "balanced score must discount raw operator activity")
    _assert(item["balanced_operator_impact_score"] > 0, "balanced maintainer support must remain visible")

    source = report._leaderboard(records, mode="source")
    operator = report._leaderboard(records, mode="operator")
    composite = {row["author"]: row for row in report._leaderboard(records, mode="composite")}
    _assert(source[0]["author"] == "feature-author", "source leaderboard must credit the contributor")
    _assert(operator[0]["author"] == "kushaltrivedi5", "operator leaderboard must credit maintainer work")
    _assert(composite["feature-author"]["source_score"] > 0, "composite must preserve contributor source score")
    _assert(composite["kushaltrivedi5"]["operator_score"] > 0, "composite must include maintainer operator score")


def test_duplicate_closure_dual_credits_source_and_operator() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2002,
                "feature-author",
                "feat: duplicate profile privacy widget",
                comments=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "body": "## Closed: duplicate\nThis is superseded by the canonical profile privacy surface.",
                    }
                ],
            )
        ]
    )

    item = records[0]
    _assert(item["lifecycle"] == "closed_duplicate", "duplicate closure must be classified")
    _assert(item["source_impact_score"] > 0, "source author keeps source impact")
    _assert(item["operator_impact_score"] > 0, "maintainer closure must receive operator impact")
    operator = report._leaderboard(records, mode="operator")
    _assert(operator[0]["author"] == "kushaltrivedi5", "closure operator must be visible")


def test_balanced_leaderboard_limits_routine_operator_dominance() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2101,
                "source-architect",
                "feat: add One agent pathway for portfolio consent vault import",
                merged=True,
                files=[
                    "hushh-webapp/app/kai/import/page.tsx",
                    "consent-protocol/hushh_mcp/agents/one_agent.py",
                ],
            ),
            _fake_pr(
                2102,
                "small-author",
                "docs: update governance note",
                merged=True,
                merged_by="kushaltrivedi5",
                comments=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "body": "Long review context explaining the queue state, governance note, and release tradeoff for this small change.",
                    }
                ],
                reviews=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "state": "APPROVED",
                        "body": "Approved after review.",
                    }
                ],
                files=["docs/reference/operations/ci.md"],
            ),
        ]
    )

    balanced = report._leaderboard(records, mode="balanced")
    composite = {row["author"]: row for row in report._leaderboard(records, mode="composite")}
    balanced_index = {row["author"]: row for row in balanced}
    _assert(balanced[0]["author"] == "source-architect", "high-value source work should lead balanced ranking")
    _assert(
        balanced_index["kushaltrivedi5"]["score"] < composite["kushaltrivedi5"]["score"],
        "balanced ranking must not use raw operator volume",
    )
    _assert(
        balanced_index["kushaltrivedi5"]["balanced_operator_score"] < balanced_index["kushaltrivedi5"]["operator_score"],
        "maintainer support must be capped below raw activity",
    )


def test_product_surfaces_and_category_bonus_are_visible() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2103,
                "product-author",
                "fix: make RIA onboarding responsive before Plaid portfolio import",
                merged=True,
                files=[
                    "hushh-webapp/app/ria/onboarding/page.tsx",
                    "hushh-webapp/app/kai/import/page.tsx",
                    "hushh-webapp/components/morphy/button.tsx",
                ],
            )
        ]
    )

    item = records[0]
    _assert("ria/advisor" in item["vectors"], "RIA surface must be detected")
    _assert("onboarding/profile" in item["vectors"], "onboarding/profile surface must be detected")
    _assert("portfolio/import" in item["vectors"], "portfolio import surface must be detected")
    _assert("frontend/design" in item["vectors"], "frontend/design surface must be detected")
    _assert(item["source_product_bonus"] > 0, "product category bonus must be applied")
    product = report._product_breakdown(records)
    _assert(product["RIA and advisor workflows"]["prs"] == 1, "RIA area must be reported")
    _assert(product["portfolio import / Plaid / statements"]["prs"] == 1, "portfolio area must be reported")


def test_report_and_json_expose_dual_credit_sections() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2003,
                "feature-author",
                "fix: harden Kai vault export",
                merged=True,
                merged_by="kushaltrivedi5",
                comments=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "body": "### Maintainer Patch\nBounded patch merged after review.",
                    }
                ],
            )
        ]
    )
    window = report.Window("last 14 days", report.date(2026, 5, 1), report.date(2026, 5, 14))
    github_insights = {
        "total_prs": 1,
        "open_prs": 0,
        "closed_prs": 1,
        "merged_prs": 1,
        "closed_unmerged_prs": 0,
        "included_resolved_prs": 1,
        "fetch_limit": report.PR_FETCH_LIMIT,
    }
    text = report._report_text(
        report.DEFAULT_REPO,
        window,
        records,
        window,
        records,
        window,
        records,
        window,
        records,
        github_insights,
    )
    payload = report._json_payload(
        report.DEFAULT_REPO,
        window,
        records,
        window,
        records,
        window,
        records,
        window,
        records,
        github_insights,
    )

    _assert("## How This Is Counted" in text, "report must explain accounting")
    _assert("### Balanced Impact Leaders" in text, "report must include balanced leaders")
    _assert("### Source Contribution Leaders" in text, "report must include source leaders")
    _assert("### Maintainer Support Leaders" in text, "report must include maintainer support leaders")
    _assert("## Product Area Impact" in text, "report must include product area impact")
    _assert("Source Impact credits the PR author" in text, "glossary must use plain language")
    _assert("Balanced Impact is the default ranking" in text, "glossary must name default ranking")
    _assert("GitHub Credit is separate" in text, "glossary must separate GitHub attribution")
    _assert("source_leaderboard" in payload, "JSON must expose source leaderboard")
    _assert("operator_leaderboard" in payload, "JSON must expose operator leaderboard")
    _assert("balanced_leaderboard" in payload, "JSON must expose balanced leaderboard")
    _assert(
        payload["records"][0]["composite_impact_score"]
        == payload["records"][0]["source_impact_score"] + payload["records"][0]["operator_impact_score"],
        "JSON record must expose valid score fields",
    )
    _assert(
        "balanced_impact_score" in payload["records"][0],
        "JSON record must expose balanced score",
    )


if __name__ == "__main__":
    test_harvested_source_gets_internal_credit()
    test_harvest_attribution_names_external_ledger_boundary()
    test_maintainer_patch_dual_credits_source_and_operator()
    test_duplicate_closure_dual_credits_source_and_operator()
    test_balanced_leaderboard_limits_routine_operator_dominance()
    test_product_surfaces_and_category_bonus_are_visible()
    test_report_and_json_expose_dual_credit_sections()
    print("contributor impact tests passed")
