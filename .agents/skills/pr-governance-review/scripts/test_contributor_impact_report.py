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
    base_ref: str = "integration/pr-train",
    head_ref: str = "feature/test-branch",
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
        "baseRefName": base_ref,
        "headRefName": head_ref,
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
                        "html_url": "https://github.com/hushh-labs/hushh-research/pull/2001#issuecomment-1",
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
    _assert(
        item["operator_events"][0]["url"].endswith("#issuecomment-1"),
        "operator event must retain source maintainer record URL",
    )
    evidence = "\n".join(report._maintainer_support_evidence_lines(records))
    _assert("[record](https://github.com/hushh-labs/hushh-research/pull/2001#issuecomment-1)" in evidence, "support evidence must render maintainer record link")

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


def test_duplicate_prs_are_deduped_before_scoring() -> None:
    duplicate_closed = _fake_pr(2294, "author-a", "fix: duplicate closed record", merged=False)
    duplicate_merged = _fake_pr(2294, "author-a", "fix: duplicate merged record", merged=True)
    unique = _fake_pr(2299, "author-b", "fix: unique record", merged=True)

    deduped = report._dedupe_prs([duplicate_closed, duplicate_merged, unique, duplicate_merged])

    _assert([item["number"] for item in deduped].count(2294) == 1, "duplicate PR number must be collapsed")
    _assert(len(deduped) == 2, "dedupe must keep only unique PR numbers")
    _assert(
        next(item for item in deduped if item["number"] == 2294)["mergedAt"],
        "dedupe must prefer the merged record when duplicate state records overlap",
    )


def test_skipped_github_audit_does_not_render_fake_zeroes() -> None:
    window = report.Window("last 14 days (all-time fetch skipped)", report.date(2026, 5, 1), report.date(2026, 5, 14))
    lines = "\n".join(
        report._github_audit_lines(
            {
                "total_prs": 0,
                "open_prs": 0,
                "closed_prs": 0,
                "merged_prs": 0,
                "closed_unmerged_prs": 0,
                "included_resolved_prs": 2,
                "fetch_limit": report.PR_FETCH_LIMIT,
                "audit_skipped": True,
                "partial_reason": "all-time history fetch skipped",
            },
            window,
        )
    )

    _assert("| GitHub PRs discovered | Skipped |" in lines, "skipped audit must not render discovered count as zero")
    _assert("| Closed PRs | Skipped |" in lines, "skipped audit must not render closed count as zero")
    _assert("| Resolved PRs included in overall score | 2 |" in lines, "included report count must remain visible")


def test_timeline_uses_report_timezone_without_invalid_date_range() -> None:
    records = report._analysis(
        [
            {
                **_fake_pr(2310, "author-a", "fix: late utc merge", merged=True),
                "createdAt": "2026-07-06T01:00:00Z",
                "closedAt": "2026-07-06T02:00:00Z",
                "mergedAt": "2026-07-06T02:00:00Z",
            }
        ]
    )
    lines = "\n".join(report._timeline_graph_lines(records))

    _assert("Jul 6-5" not in lines, "timeline must never render an inverted date range")
    _assert("Jun 29-Jul 5, 2026" in lines, "late UTC merge must bucket into the PT reporting week")


def test_records_in_window_uses_report_timezone() -> None:
    records = report._analysis(
        [
            {
                **_fake_pr(2311, "author-a", "fix: included pt day", merged=True),
                "closedAt": "2026-07-06T02:00:00Z",
                "mergedAt": "2026-07-06T02:00:00Z",
            },
            {
                **_fake_pr(2312, "author-b", "fix: excluded later pt day", merged=True),
                "closedAt": "2026-07-06T08:00:00Z",
                "mergedAt": "2026-07-06T08:00:00Z",
            },
        ]
    )
    window = report.Window("pt day", report.date(2026, 7, 5), report.date(2026, 7, 5))
    filtered = report._records_in_window(records, window)

    _assert([item["number"] for item in filtered] == [2311], "window filtering must use PT report dates")


def test_rolling_windows_use_exact_inclusive_day_count() -> None:
    weekly = report._rolling_window("last 7 days", 7, report.date(2026, 7, 5))
    two_week = report._rolling_window("last 14 days", 14, report.date(2026, 7, 5))

    _assert(weekly.since == report.date(2026, 6, 29), "7-day window must include exactly 7 PT dates")
    _assert(weekly.until == report.date(2026, 7, 5), "7-day window must end on the report date")
    _assert(two_week.since == report.date(2026, 6, 22), "14-day window must include exactly 14 PT dates")
    _assert(two_week.until == report.date(2026, 7, 5), "14-day window must end on the report date")


def test_records_for_window_filters_github_utc_overfetch_back_to_pt_window() -> None:
    original_use_search_fetch = report.USE_SEARCH_FETCH
    original_query = report._query_resolved_prs_graphql
    original_enrich = report._enrich_discussions

    def fake_query(_repo: str, _window: report.Window) -> list[dict[str, object]]:
        return [
            {
                **_fake_pr(2313, "author-a", "fix: included late utc merge", merged=True),
                "closedAt": "2026-07-06T02:00:00Z",
                "mergedAt": "2026-07-06T02:00:00Z",
            },
            {
                **_fake_pr(2314, "author-b", "fix: excluded next pt day", merged=True),
                "closedAt": "2026-07-06T08:00:00Z",
                "mergedAt": "2026-07-06T08:00:00Z",
            },
        ]

    try:
        report.USE_SEARCH_FETCH = False
        report._query_resolved_prs_graphql = fake_query
        report._enrich_discussions = lambda _repo, records: records
        window = report.Window("pt day", report.date(2026, 7, 5), report.date(2026, 7, 5))
        records = report._records_for_window(report.DEFAULT_REPO, window)
    finally:
        report.USE_SEARCH_FETCH = original_use_search_fetch
        report._query_resolved_prs_graphql = original_query
        report._enrich_discussions = original_enrich

    _assert(
        [item["number"] for item in records] == [2313],
        "window fetch must keep late-UTC same-PT-day records and drop next-PT-day overfetch",
    )


def test_pr_train_lane_mix_distinguishes_integration_and_main_paths() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2201,
                "community-author",
                "fix: improve profile route readiness",
                merged=True,
                base_ref="integration/pr-train",
                head_ref="contrib/profile-readiness",
            ),
            _fake_pr(
                2202,
                "kushaltrivedi5",
                "fix(ci): govern repo auto-merge setting",
                merged=True,
                base_ref="main",
                head_ref="maintainer/auto-merge-governance",
            ),
            _fake_pr(
                2203,
                "kushaltrivedi5",
                "promote integration train",
                merged=True,
                base_ref="main",
                head_ref="integration/pr-train",
            ),
            _fake_pr(
                2204,
                "community-author",
                "fix: still targeted main",
                merged=True,
                base_ref="main",
                head_ref="contrib/main-targeted",
            ),
        ]
    )
    lanes = {row["lane"]: row["prs"] for row in report._pr_train_lane_breakdown(records)}
    _assert(lanes["integration_pr_train"] == 1, "integration train intake must be counted")
    _assert(lanes["maintainer_direct_main"] == 1, "maintainer direct-to-main must be counted")
    _assert(lanes["train_promotion_to_main"] == 1, "train promotion must be counted")
    _assert(lanes["main_targeted_normal_intake"] == 1, "normal main-targeted intake must stay visible")
    _assert(
        records[0]["pr_train_lane_label"] == "Resolved against integration/pr-train",
        "records must expose a readable lane label",
    )


def test_operating_leaderboard_exposes_raw_maintainer_load_without_hiding_balanced_cap() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2301,
                "source-architect",
                "feat: add One agent pathway for portfolio consent vault import",
                merged=True,
                files=[
                    "hushh-webapp/app/kai/import/page.tsx",
                    "consent-protocol/hushh_mcp/agents/one_agent.py",
                ],
            ),
            _fake_pr(
                2302,
                "maintainer-author",
                "fix: govern direct main release path",
                merged=True,
                merged_by="kushaltrivedi5",
                comments=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "body": "Long governance review explaining release tradeoffs, queue state, and why this direct main path is acceptable.",
                    }
                ],
                reviews=[
                    {
                        "author": {"login": "kushaltrivedi5"},
                        "state": "APPROVED",
                        "body": "Approved after release governance review.",
                    }
                ],
                files=["docs/reference/operations/ci.md"],
            ),
        ]
    )

    operating = {row["author"]: row for row in report._leaderboard(records, mode="operating")}
    balanced = {row["author"]: row for row in report._leaderboard(records, mode="balanced")}

    _assert("kushaltrivedi5" in operating, "operating leaderboard must expose maintainer load")
    _assert(
        operating["kushaltrivedi5"]["score"] > balanced["kushaltrivedi5"]["score"],
        "operating impact must include raw maintainer activity while balanced impact remains capped",
    )
    _assert(
        operating["kushaltrivedi5"]["operator_score"] > operating["kushaltrivedi5"]["balanced_operator_score"],
        "raw and capped maintainer support must both stay visible",
    )


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
        window,
        records,
        github_insights,
    )

    _assert("## How This Is Counted" in text, "report must explain accounting")
    _assert("### PR Train Lane Mix" in text, "report must include PR train lane mix")
    _assert("### Operating Impact Leaders" in text, "report must include operating impact leaders")
    _assert("### Balanced Impact Leaders" in text, "report must include balanced impact leaders")
    _assert("### Overall Operating Impact Leaders" in text, "report must include overall leaders")
    _assert("All-Time Impact Leaders" not in text, "fast/overall report must not overclaim all-time leaders")
    _assert("Weekly, Two-Week, And Monthly Scoreboard" in text, "report must include monthly scoreboard")
    _assert("Coverage note: weekly, two-week, and month-to-date currently score the same resolved PR set" in text, "report must explain legitimate overlapping windows")
    _assert("## Monthly Top 10" in text, "report must include monthly top table")
    _assert("Two-Week Vs Overall" in text, "KPI comparison must avoid all-time overclaim")
    _assert("### Source Contribution Leaders" in text, "report must include source leaders")
    _assert("### Maintainer Support Leaders" in text, "report must include maintainer support leaders")
    _assert("## Product Area Impact" in text, "report must include product area impact")
    _assert("Source Impact credits the PR author" in text, "glossary must use plain language")
    _assert("Balanced Impact is the source-weighted recognition metric" in text, "glossary must name balanced ranking")
    _assert("Operating Impact is the workload metric" in text, "glossary must name operating ranking")
    _assert("GitHub Credit is separate" in text, "glossary must separate GitHub attribution")
    _assert("operating_leaderboard" in payload, "JSON must expose operating leaderboard")
    _assert("source_leaderboard" in payload, "JSON must expose source leaderboard")
    _assert("operator_leaderboard" in payload, "JSON must expose operator leaderboard")
    _assert("balanced_leaderboard" in payload, "JSON must expose balanced leaderboard")
    _assert("monthly_top_10" in payload, "JSON must expose monthly top 10")
    _assert("monthly_kpis" in payload, "JSON must expose monthly KPIs")
    _assert("pr_train_lane_mix" in payload, "JSON must expose PR train lane mix")
    _assert("data_mode" in payload, "JSON must expose dashboard fetch mode")
    _assert(
        payload["records"][0]["composite_impact_score"]
        == payload["records"][0]["source_impact_score"] + payload["records"][0]["operator_impact_score"],
        "JSON record must expose valid score fields",
    )
    _assert(
        "balanced_impact_score" in payload["records"][0],
        "JSON record must expose balanced score",
    )
    _assert(
        "operating_impact_score" in payload["records"][0],
        "JSON record must expose operating score",
    )


def test_partial_report_does_not_emit_overall_top_claim() -> None:
    records = report._analysis(
        [
            _fake_pr(
                2303,
                "feature-author",
                "fix: harden dashboard labels",
                merged=True,
                merged_by="kushaltrivedi5",
            )
        ]
    )
    window = report.Window("last 14 days", report.date(2026, 5, 1), report.date(2026, 5, 14))
    github_insights = {
        "total_prs": 0,
        "open_prs": 0,
        "closed_prs": 0,
        "merged_prs": 0,
        "closed_unmerged_prs": 0,
        "included_resolved_prs": 1,
        "fetch_limit": report.PR_FETCH_LIMIT,
        "audit_skipped": True,
        "partial_reason": "fast mode excludes all-time history",
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
        window,
        records,
        github_insights,
    )

    _assert("## Overall Top 10" not in text, "partial report must not claim overall top counts")
    _assert("Recent/Partial Top 10" not in text, "partial report must not render a duplicate partial top table")
    _assert("Run full mode for an all-time leaderboard" in text, "partial report must point to full mode")
    _assert(payload["report_scope"]["is_partial"] is True, "JSON must expose partial report scope")
    _assert(payload["overall_top_10"]["omitted"] is True, "partial JSON must mark overall top 10 omitted")
    _assert(payload["overall_top_10"]["contributors"] == [], "partial JSON must not populate fake overall contributors")


def test_all_time_fetch_uses_paginated_rest_without_single_limit_truncation() -> None:
    calls: list[str] = []
    original_run_gh = report._run_gh
    original_enrich = report._enrich_discussions

    def fake_run_gh(args: list[str]) -> object:
        endpoint = args[-1]
        calls.append(endpoint)
        page = int(endpoint.rsplit("page=", 1)[1])
        count = 100 if page in {1, 2} else 1
        return [
            {
                "number": (page * 1000) + index,
                "title": "fix: paginated all-time record",
                "html_url": f"https://github.com/hushh-labs/hushh-research/pull/{(page * 1000) + index}",
                "user": {"login": f"author-{page}"},
                "created_at": "2026-01-15T18:00:00Z",
                "updated_at": "2026-01-15T18:00:00Z",
                "closed_at": "2026-01-15T19:00:00Z",
                "merged_at": "2026-01-15T19:00:00Z",
                "merged_by": {"login": "kushaltrivedi5"},
                "base": {"ref": "integration/pr-train"},
                "head": {"ref": "feature/test"},
                "labels": [],
            }
            for index in range(count)
        ]

    try:
        report._run_gh = fake_run_gh
        report._enrich_discussions = lambda _repo, records: records
        records = report._records_for_all_time(report.DEFAULT_REPO)
    finally:
        report._run_gh = original_run_gh
        report._enrich_discussions = original_enrich

    _assert(len(calls) == 3, "all-time fetch must keep paging until the final short page")
    _assert("page=1" in calls[0] and "page=3" in calls[-1], "all-time fetch must request sequential pages")
    _assert(len(records) == 201, "all-time records must include every paginated result")


if __name__ == "__main__":
    test_harvested_source_gets_internal_credit()
    test_harvest_attribution_names_external_ledger_boundary()
    test_maintainer_patch_dual_credits_source_and_operator()
    test_duplicate_closure_dual_credits_source_and_operator()
    test_balanced_leaderboard_limits_routine_operator_dominance()
    test_product_surfaces_and_category_bonus_are_visible()
    test_duplicate_prs_are_deduped_before_scoring()
    test_skipped_github_audit_does_not_render_fake_zeroes()
    test_timeline_uses_report_timezone_without_invalid_date_range()
    test_records_in_window_uses_report_timezone()
    test_rolling_windows_use_exact_inclusive_day_count()
    test_records_for_window_filters_github_utc_overfetch_back_to_pt_window()
    test_pr_train_lane_mix_distinguishes_integration_and_main_paths()
    test_operating_leaderboard_exposes_raw_maintainer_load_without_hiding_balanced_cap()
    test_report_and_json_expose_dual_credit_sections()
    test_partial_report_does_not_emit_overall_top_claim()
    test_all_time_fetch_uses_paginated_rest_without_single_limit_truncation()
    print("contributor impact tests passed")
