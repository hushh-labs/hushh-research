#!/usr/bin/env python3
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
import tempfile

import pr_review_checklist as checklist


def _fake_report(
    number: int,
    files: list[str],
    *,
    lane: str = "merge_now",
    contract_set: str = "general",
    findings: list[dict] | None = None,
    related_files: list[str] | None = None,
    surface_tags: list[str] | None = None,
    created_at: str | None = None,
    ci_status_gate: str = "SUCCESS",
    current_checks: list[dict] | None = None,
    review_decision: str = "",
    stacked_dependency_prs: list[int] | None = None,
) -> OrderedDict:
    findings = findings or []
    report = OrderedDict(
        pr=OrderedDict(
            number=number,
            title=f"PR {number}",
            url=f"https://github.com/hushh-labs/hushh-research/pull/{number}",
            author="tester",
            head_sha=f"sha-{number}",
            head_ref=f"branch-{number}",
            base_ref="main",
            created_at=created_at or "",
            additions=1,
            deletions=0,
            changed_files_count=len(files),
            mergeable="MERGEABLE",
            merge_state_status="CLEAN",
            is_draft=False,
            review_decision=review_decision,
        ),
        changed_files=files,
        contract_set=contract_set,
        what_this_is_about="test PR",
        surface_tags=surface_tags or [],
        current_ci_status_gate=ci_status_gate,
        current_checks=current_checks or [
            OrderedDict(name="CI Status Gate", conclusion=ci_status_gate)
        ],
        stacked_dependency_prs=stacked_dependency_prs or [],
        findings=findings,
        exact_file_overlap=[],
        concept_overlap=[],
        related_surfaces=OrderedDict(
            files=[OrderedDict(path=path, summary="test") for path in (related_files or [])],
            docs=[],
        ),
        founder_wiki_probe=OrderedDict(required=False),
        decision=OrderedDict(lane=lane, rationale="test", next_steps=[]),
        lane=lane,
    )
    checklist._apply_patch_attachment_policy(report)
    return report


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_live_report_metadata_links_maintainer_records() -> None:
    line = checklist._report_freshness_line("2026-05-31T11:24:56Z")
    _assert("2026-05-31T23:24:56Z" in line, "freshness line must expose 12-hour reuse window")

    record = checklist._maintainer_record_link(
        {
            "maintainer_record_url": "https://github.com/hushh-labs/hushh-research/pull/1#issuecomment-1",
            "maintainer_record_at": "2026-05-31T11:24:56Z",
        }
    )
    _assert("[record](" in record, "maintainer record link must render as markdown")
    _assert("2026-05-31T11:24:56Z" in record, "maintainer record link must preserve timestamp")


def test_subagent_status_metadata_marks_unavailable() -> None:
    batch = {
        "train_to_subagent_map": [
            {
                "id": "train-1",
                "train_type": "queue_cohort",
                "subagent_lane": "ci/deploy/release",
                "agent": "repo_operator",
                "prs": [1],
            }
        ]
    }
    checklist._apply_subagent_status_metadata(batch, "tool unavailable")
    entry = batch["train_to_subagent_map"][0]
    _assert(entry["lane_status"] == "unavailable", "unavailable reason must mark lane status")
    _assert(entry["unavailable_reason"] == "tool unavailable", "unavailable reason must be preserved")
    _assert("parent session" in entry["parent_local_task"], "parent-local task must be explicit")


def test_same_file_collision() -> None:
    reports = [
        _fake_report(1, ["hushh-webapp/lib/a.ts"]),
        _fake_report(2, ["hushh-webapp/lib/a.ts"]),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(graph["collision_groups"], "same file must create a collision group")
    _assert(reports[1]["must_wait_for"] == [1], "second shared-file PR must wait for first")


def test_transitive_collision_only_waits_for_direct_edge() -> None:
    reports = [
        _fake_report(1, ["hushh-webapp/lib/a.ts"]),
        _fake_report(2, ["hushh-webapp/lib/a.ts", "hushh-webapp/lib/b.ts"]),
        _fake_report(3, ["hushh-webapp/lib/b.ts"]),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(graph["collision_groups"], "transitive exact-file edges still create a collision group")
    _assert(reports[1]["must_wait_for"] == [1], "bridge PR must wait for its direct older edge")
    _assert(reports[2]["must_wait_for"] == [2], "leaf PR must not wait on unrelated transitive edges")


def test_disjoint_merge_queue_cohort() -> None:
    reports = [
        _fake_report(1, ["docs/a.md"]),
        _fake_report(2, ["docs/b.md"]),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(graph["queue_cohorts"][0]["prs"] == [1, 2], "disjoint merge_now PRs should share cohort")
    _assert(reports[0]["can_queue_with"] == [2], "first PR should queue with second")


def test_hard_surface_sequence() -> None:
    lock_reports = [
        _fake_report(1, ["hushh-webapp/package-lock.json"]),
        _fake_report(2, ["package-lock.json"]),
    ]
    lock_graph = checklist._build_train_graph(
        lock_reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(lock_graph["collision_groups"], "lockfile changes must sequence")


def test_sensitive_runtime_overlap_without_file_edge_does_not_sequence() -> None:
    runtime_reports = [
        _fake_report(3, ["hushh-webapp/lib/pkm/a.ts"], contract_set="pkm-privacy"),
        _fake_report(4, ["consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py"], contract_set="pkm-privacy"),
    ]
    runtime_graph = checklist._build_train_graph(
        runtime_reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(
        not runtime_graph["collision_groups"],
        "sensitive runtime labels alone must not weld unrelated files into one train",
    )

    same_file_reports = [
        _fake_report(5, ["consent-protocol/api/routes/pkm_routes_shared.py"], contract_set="pkm-privacy"),
        _fake_report(6, ["consent-protocol/api/routes/pkm_routes_shared.py"], contract_set="pkm-privacy"),
    ]
    same_file_graph = checklist._build_train_graph(
        same_file_reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(
        same_file_graph["collision_groups"],
        "sensitive runtime PRs still sequence when they share an exact file edge",
    )


def test_patch_gate_blocks_unattached_export() -> None:
    report = _fake_report(
        5,
        ["hushh-webapp/lib/new-helper.ts"],
        lane="patch_then_merge",
        findings=[
            {
                "id": "new_export_without_app_or_backend_caller",
                "severity": "medium",
                "summary": "unattached",
                "files": ["hushh-webapp/lib/new-helper.ts"],
            }
        ],
    )
    _assert(report["lane"] == "block", "unattached export must not stay patch_then_merge")
    _assert(report["patch_denied_reason"], "unattached export must name patch denial")


def test_patch_gate_allows_canonical_attach_point() -> None:
    report = _fake_report(
        6,
        ["consent-protocol/hushh_mcp/services/account_service.py"],
        lane="patch_then_merge",
        contract_set="account-export",
        findings=[
            {
                "id": "account_export_schema_contract_mismatch",
                "severity": "high",
                "summary": "bounded contract mismatch",
                "files": ["consent-protocol/hushh_mcp/services/account_service.py"],
            }
        ],
        related_files=["consent-protocol/hushh_mcp/services/account_service.py"],
    )
    _assert(report["lane"] == "patch_then_merge", "bounded attached patch should remain eligible")
    _assert(report["canonical_attach_point"], "eligible patch must name canonical attach point")
    _assert(report["patch_allowed_reason"], "eligible patch must name allowed reason")


def test_pure_test_report_can_merge_now() -> None:
    decision = checklist._recommend_merge_lane(
        ci_status_gate="SUCCESS",
        review_decision="",
        findings=[],
        surface_tags=["tests"],
        changed_files=["consent-protocol/tests/test_existing_helper.py"],
    )
    _assert(decision["lane"] == "merge_now", "pure test proof with no findings can merge")


def test_mock_only_frontend_test_blocks_merge_now() -> None:
    findings = checklist._mock_only_test_findings(
        ["hushh-webapp/__tests__/components/dialog-escape-dismiss.test.tsx"],
        {
            "hushh-webapp/__tests__/components/dialog-escape-dismiss.test.tsx": """
new file mode 100644
+import { render } from "@testing-library/react";
+import { describe, it } from "vitest";
+
+function MockDialog() {
+  return <div role="dialog">Dialog</div>;
+}
""",
        },
    )
    _assert(findings, "mock-only frontend test must be detected")
    decision = checklist._recommend_merge_lane(
        ci_status_gate="SUCCESS",
        review_decision="",
        findings=findings,
        surface_tags=["tests"],
        changed_files=["hushh-webapp/__tests__/components/dialog-escape-dismiss.test.tsx"],
    )
    _assert(decision["lane"] == "block", "mock-only frontend tests must not merge")


def test_frontend_test_importing_production_code_can_merge_now() -> None:
    findings = checklist._mock_only_test_findings(
        ["hushh-webapp/__tests__/components/real-dialog.test.tsx"],
        {
            "hushh-webapp/__tests__/components/real-dialog.test.tsx": """
new file mode 100644
+import { render } from "@testing-library/react";
+import { Dialog } from "@/components/app-ui/dialog";
""",
        },
    )
    _assert(not findings, "frontend test importing production code should not be mock-only")


def test_claim_surface_mismatch_ignores_template_boilerplate() -> None:
    body = """
# Description

Adds explicit type="button" to the sidebar rail button.

## Impact Map (Required)

- API / schema / type changes:
  - [x] None

## Privacy & Consent

- [ ] Does this change access user data?
- [ ] If yes, have you implemented checkConsentToken()?
"""
    findings = checklist._claim_surface_mismatch_findings(
        "fix(ui): add type=button to sidebar rail",
        body,
        ["hushh-webapp/components/ui/sidebar.tsx"],
    )
    _assert(not findings, "template privacy/consent boilerplate must not create a consent claim")


def test_claim_surface_mismatch_ignores_generic_scope_heading() -> None:
    body = """
## Summary

Disabled pagination controls should leave the keyboard tab order.

## Scope

Two attribute additions in components/app-ui/data-table.tsx.
"""
    findings = checklist._claim_surface_mismatch_findings(
        "fix(data-table): remove disabled pagination controls from tab order",
        body,
        ["hushh-webapp/components/app-ui/data-table.tsx"],
    )
    _assert(not findings, "generic Scope heading must not create a consent scope claim")


def test_claim_surface_mismatch_keeps_actual_consent_claim() -> None:
    findings = checklist._claim_surface_mismatch_findings(
        "fix(consent): enforce consent scope on profile export",
        "This fixes consent scope enforcement for export access.",
        ["hushh-webapp/components/app-ui/data-table.tsx"],
    )
    _assert(findings, "actual consent claim should still require consent-surface files")


def test_claim_surface_mismatch_ignores_html_scope_attribute() -> None:
    findings = checklist._claim_surface_mismatch_findings(
        'fix(table): add scope="col" to TableHead column header primitive',
        'Adds scope="col" to shared table header cells for accessibility.',
        ["hushh-webapp/components/ui/table.tsx"],
    )
    _assert(not findings, "HTML table scope attribute must not create a consent-scope claim")


def test_failing_required_gate_excluded_from_executable_trains() -> None:
    failing = _fake_report(
        7,
        ["docs/failing.md"],
        lane="merge_now",
        ci_status_gate="FAILURE",
    )
    healthy = _fake_report(8, ["docs/healthy.md"], lane="merge_now")
    graph = checklist._build_train_graph(
        [failing, healthy],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(graph["queue_cohorts"][0]["prs"] == [8], "failing required gate must not enter queue cohort")
    _assert(graph["check_failure_holds"][0]["pr"] == 7, "failing required gate must be reported as a hold")
    _assert(not checklist._is_actionable_live_candidate(failing), "failing required gate must not be actionable")


def test_failing_auxiliary_check_excluded_from_operator_batches() -> None:
    aux_failing = _fake_report(
        9,
        ["docs/a.md"],
        lane="merge_now",
        current_checks=[
            OrderedDict(name="CI Status Gate", conclusion="SUCCESS"),
            OrderedDict(name="Markdown Lint", conclusion="FAILURE"),
        ],
    )
    peer = _fake_report(10, ["docs/a.md"], lane="merge_now")
    graph = checklist._build_train_graph(
        [aux_failing, peer],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(not graph["collision_groups"], "aux-failing PR must not create executable collision train")
    _assert(graph["queue_cohorts"][0]["prs"] == [10], "aux-failing PR must not enter queue cohort")
    _assert(not checklist._is_actionable_live_candidate(aux_failing), "aux-failing PR must not be actionable")


def test_zero_queue_cohort_size_does_not_emit_empty_cohort() -> None:
    reports = [
        _fake_report(11, ["docs/a.md"], lane="merge_now"),
        _fake_report(12, ["docs/b.md"], lane="merge_now"),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=0,
        max_parallel_patch_trains=3,
    )
    _assert(graph["queue_cohorts"] == [], "queue_cohort_size=0 must not emit an empty queue cohort")
    _assert(not reports[0]["queue_cohort_id"], "zero-sized queue cohort must not mark reports as queued")


def test_scan_failure_is_hold_not_public_changes_requested() -> None:
    report = checklist._scan_failure_report(
        "hushh-labs/hushh-research",
        13,
        "timeout",
        "per-PR review timed out",
    )
    _assert(report["lane"] == "block", "scan failure should remain blocked from execution")
    _assert(
        report["public_comment_policy"] == "no_comment_review_only_scan_incomplete",
        "scan failure must not generate a public changes-requested policy",
    )
    _assert(report["live_report_action"] == "hold_until_scan_refresh", "scan failure should be held until refresh")


def test_train_graph_maps_trains_to_subagent_lanes() -> None:
    patch = _fake_report(
        14,
        ["consent-protocol/hushh_mcp/services/account_service.py"],
        lane="patch_then_merge",
        contract_set="account-export",
        findings=[
            {
                "id": "account_export_schema_contract_mismatch",
                "severity": "high",
                "summary": "bounded contract mismatch",
                "files": ["consent-protocol/hushh_mcp/services/account_service.py"],
            }
        ],
        related_files=["consent-protocol/hushh_mcp/services/account_service.py"],
    )
    frontend = _fake_report(
        15,
        ["hushh-webapp/app/example/page.tsx"],
        lane="merge_now",
        contract_set="frontend",
    )
    graph = checklist._build_train_graph(
        [patch, frontend],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    entries = {entry["id"]: entry for entry in graph["train_to_subagent_map"]}
    _assert(entries["queue-cohort-1"]["agent"] == "repo_operator", "queue cohort should map to repo operator")
    _assert(
        entries["patch-train-1"]["agent"] == "security_consent_auditor",
        "account-export patch train should map to security/consent evidence lane",
    )


def test_collision_train_sequences_oldest_created_pr_first() -> None:
    reports = [
        _fake_report(
            100,
            ["hushh-webapp/lib/shared.ts"],
            created_at="2026-05-12T10:00:00Z",
        ),
        _fake_report(
            99,
            ["hushh-webapp/lib/shared.ts"],
            created_at="2026-05-13T10:00:00Z",
        ),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    group = graph["collision_groups"][0]
    _assert(group["sequence"] == [100, 99], "collision train must sequence by PR creation time, not PR number")
    _assert(reports[1]["must_wait_for"] == [100], "newer PR must wait for older PR in the same train")


def test_stacked_dependency_creates_sequential_train() -> None:
    reports = [
        _fake_report(
            300,
            ["hushh-webapp/lib/feature-init.ts"],
            created_at="2026-05-13T10:00:00Z",
        ),
        _fake_report(
            301,
            ["hushh-webapp/app/feature/page.tsx"],
            created_at="2026-05-13T11:00:00Z",
            stacked_dependency_prs=[300],
        ),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    group = graph["collision_groups"][0]
    _assert(group["sequence"] == [300, 301], "stacked dependency must sequence predecessor before follow-up")
    _assert(
        any("stacked_pr_dependency:#300->#301" in reason for reason in group["reasons"]),
        "stacked dependency must be recorded as a hard edge",
    )
    _assert(reports[1]["must_wait_for"] == [300], "dependent PR must wait for predecessor PR")


def test_stacked_dependency_parser_requires_dependency_language() -> None:
    deps = checklist._stacked_dependency_pr_numbers(
        "feat(ui): follow-up",
        "Depends on #300 before this can merge.",
    )
    _assert(deps == [300], "explicit dependency language must produce predecessor PR number")
    issue_only = checklist._stacked_dependency_pr_numbers(
        "fix: resolve issue",
        "Fixes #123 and updates docs.",
    )
    _assert(issue_only == [], "plain issue references must not create stacked PR dependency")


def test_external_stacked_dependency_blocks_queue_until_repass() -> None:
    report = _fake_report(
        302,
        ["hushh-webapp/app/feature/page.tsx"],
        stacked_dependency_prs=[300],
    )
    graph = checklist._build_train_graph(
        [report],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(graph["queue_cohorts"] == [], "dependent PR must not enter queue when predecessor is outside reviewed scope")
    _assert(report["must_wait_for"] == [300], "external predecessor must be preserved as must_wait_for")
    _assert(not checklist._is_actionable_live_candidate(report), "dependent PR must not be actionable until predecessor is reviewed or landed")


def test_all_async_trains_output_names_parallel_model() -> None:
    reports = [
        _fake_report(110, ["hushh-webapp/lib/a.ts"]),
        _fake_report(111, ["hushh-webapp/lib/a.ts"]),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    batch = {"repo": "hushh-labs/hushh-research", "reports": reports, "train_to_subagent_map": graph["train_to_subagent_map"]}
    text = "\n".join(checklist._subagent_taskforce_lines(batch))
    _assert("## All Async Trains" in text, "train report must expose all async trains")
    _assert("oldest PR first" in text, "train report must describe oldest-first sequencing")


def test_live_selection_order_defaults_to_oldest() -> None:
    original_inventory = checklist._open_pr_inventory
    try:
        checklist._open_pr_inventory = lambda repo: [
            OrderedDict(number=3, title="new", author="a", created_at="2026-05-03T00:00:00Z", updated_at="2026-05-03T00:00:00Z", base_ref="main"),
            OrderedDict(number=1, title="old", author="a", created_at="2026-05-01T00:00:00Z", updated_at="2026-05-01T00:00:00Z", base_ref="main"),
            OrderedDict(number=2, title="mid", author="a", created_at="2026-05-02T00:00:00Z", updated_at="2026-05-02T00:00:00Z", base_ref="main"),
        ]
        prs, scope = checklist._select_live_scan_prs(
            "hushh-labs/hushh-research",
            scan_mode="hybrid",
            active_limit=2,
            candidate_limit=0,
            per_pr_timeout_seconds=25,
        )
    finally:
        checklist._open_pr_inventory = original_inventory
    _assert(prs == [1, 2], "default live selection must review oldest open PRs first")
    _assert(scope["selection_order"] == "oldest", "scope must record oldest selection")


def test_live_selection_order_latest() -> None:
    rows = [
        OrderedDict(number=1, title="old", author="a", created_at="2026-05-01T00:00:00Z", updated_at="2026-05-01T00:00:00Z", base_ref="main"),
        OrderedDict(number=3, title="new", author="a", created_at="2026-05-03T00:00:00Z", updated_at="2026-05-03T00:00:00Z", base_ref="main"),
        OrderedDict(number=2, title="mid", author="a", created_at="2026-05-02T00:00:00Z", updated_at="2026-05-02T00:00:00Z", base_ref="main"),
    ]
    ordered = checklist._ordered_inventory(rows, "latest")
    _assert([row["number"] for row in ordered[:2]] == [3, 2], "latest selection must use newest inventory first")


def test_live_selection_excludes_previous_tranche() -> None:
    original_inventory = checklist._open_pr_inventory
    try:
        checklist._open_pr_inventory = lambda repo: [
            OrderedDict(number=1, title="old", author="a", created_at="2026-05-01T00:00:00Z", updated_at="2026-05-01T00:00:00Z", base_ref="main"),
            OrderedDict(number=2, title="mid", author="a", created_at="2026-05-02T00:00:00Z", updated_at="2026-05-02T00:00:00Z", base_ref="main"),
            OrderedDict(number=3, title="next", author="a", created_at="2026-05-03T00:00:00Z", updated_at="2026-05-03T00:00:00Z", base_ref="main"),
            OrderedDict(number=4, title="last", author="a", created_at="2026-05-04T00:00:00Z", updated_at="2026-05-04T00:00:00Z", base_ref="main"),
        ]
        prs, scope = checklist._select_live_scan_prs(
            "hushh-labs/hushh-research",
            scan_mode="hybrid",
            active_limit=2,
            candidate_limit=0,
            per_pr_timeout_seconds=25,
            excluded_prs={1, 2},
        )
    finally:
        checklist._open_pr_inventory = original_inventory
    _assert(prs == [3, 4], "next tranche must not repeat excluded reviewed PRs")
    _assert(scope["excluded_count"] == 2, "scope must record excluded PR count")
    _assert(scope["excluded_prs"] == [1, 2], "scope must preserve excluded PR list for audit")


def test_exclude_files_can_chain_completed_reports() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        first = Path(tmpdir) / "first.md"
        second = Path(tmpdir) / "second.md"
        first.write_text("- Reviewed PRs: [#10](url), [#11](url)\n- Blocked: [#99](url)\n", encoding="utf-8")
        second.write_text("- Reviewed PRs: [#12](url), [#13](url)\n", encoding="utf-8")
        excluded = checklist._pr_numbers_from_exclude_files([str(first), str(second)])
    _assert(excluded == {10, 11, 12, 13}, "repeated exclude files must chain reviewed tranches only")


def test_exclude_files_accept_globbed_tranche_reports() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        first = Path(tmpdir) / "pr-governance-refill-1-report.md"
        second = Path(tmpdir) / "pr-governance-refill-2-report.md"
        ignored = Path(tmpdir) / "notes.md"
        first.write_text("- Reviewed PRs: [#20](url), [#21](url)\n", encoding="utf-8")
        second.write_text("- Reviewed PRs: [#22](url), [#23](url)\n", encoding="utf-8")
        ignored.write_text("- Reviewed PRs: [#99](url)\n", encoding="utf-8")
        excluded = checklist._pr_numbers_from_exclude_files(
            [str(Path(tmpdir) / "pr-governance-refill-*-report.md")]
        )
    _assert(excluded == {20, 21, 22, 23}, "globbed refill reports must chain exclusions")


def test_train_pool_refills_next_oldest_non_touching_train() -> None:
    reports = []
    for number in range(200, 212):
        pair = number // 2
        reports.append(
            _fake_report(
                number,
                [f"hushh-webapp/lib/pair-{pair}.ts"],
                created_at=f"2026-05-{number - 199:02d}T00:00:00Z",
            )
        )
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
        train_pool_size=5,
    )
    _assert(graph["train_pool_size"] == 5, "train graph must expose pool size")
    _assert(len(graph["active_train_workers"]) == 5, "five workers should be active")
    _assert(graph["next_refill_train"] == "collision-group-6", "sixth oldest train should be next refill")
    entries = graph["train_to_subagent_map"]
    _assert(entries[0]["worker_slot"] == 1, "first train should occupy worker slot 1")
    _assert(entries[5]["worker_slot"] is None, "next refill train should not yet occupy a worker slot")


def test_report_state_buckets_classify_reviewed_terminal_blocked_remaining() -> None:
    terminal = _fake_report(220, ["docs/terminal.md"], review_decision="CHANGES_REQUESTED")
    blocked = _fake_report(221, ["docs/blocked.md"], ci_status_gate="FAILURE")
    remaining = _fake_report(222, ["docs/remaining.md"])
    state = checklist._reviewed_state_summary([terminal, blocked, remaining])
    _assert(state["terminal_count"] == 1, "active maintainer record should count as terminal")
    _assert(state["blocked_count"] == 1, "check failure should count as blocked")
    _assert(state["remaining_count"] == 1, "healthy unacted PR should remain train work")


def test_live_report_prints_reviewed_state_bucket_links() -> None:
    terminal = _fake_report(230, ["docs/terminal.md"], review_decision="CHANGES_REQUESTED")
    blocked = _fake_report(231, ["docs/blocked.md"], ci_status_gate="FAILURE")
    remaining = _fake_report(232, ["docs/remaining.md"])
    state = checklist._reviewed_state_summary([terminal, blocked, remaining])
    batch = {
        "repo": "hushh-labs/hushh-research",
        "prs": [230, 231, 232],
        "reports": [terminal, blocked, remaining],
        "reviewed_state": state,
        "reviewed_terminal_count": state["terminal_count"],
        "reviewed_blocked_count": state["blocked_count"],
        "reviewed_remaining_count": state["remaining_count"],
    }
    text = "\n".join(checklist._reviewed_state_bucket_lines(batch))
    _assert("## Reviewed State Buckets" in text, "live report must expose reviewed state buckets")
    _assert("https://github.com/hushh-labs/hushh-research/pull/230" in text, "terminal bucket must link PR")
    _assert("https://github.com/hushh-labs/hushh-research/pull/231" in text, "blocked bucket must link PR")
    _assert("https://github.com/hushh-labs/hushh-research/pull/232" in text, "remaining bucket must link PR")


def test_dynamic_decision_wave_size_selection() -> None:
    high_risk = [
        _fake_report(
            16,
            ["consent-protocol/hushh_mcp/services/pkm_service.py"],
            lane="block",
            contract_set="pkm-privacy",
            surface_tags=["backend-service"],
        )
        for _ in range(6)
    ]
    mixed = [
        _fake_report(30, ["docs/a.md"], lane="block", contract_set="docs"),
        _fake_report(31, ["hushh-webapp/app/a/page.tsx"], lane="block", contract_set="frontend"),
    ]
    normal = [
        _fake_report(
            40,
            ["docs/a.md"],
            lane="block",
            contract_set="general",
            findings=[{"id": "needs_rework", "severity": "medium", "summary": "rework"}],
        )
    ]
    low_risk = [
        _fake_report(50, ["docs/a.md"], lane="block", contract_set="general")
    ]

    _assert(checklist._decision_wave_size_plan(high_risk)["size"] == 5, "high-risk wave must cap at 5")
    _assert(checklist._decision_wave_size_plan(mixed)["size"] == 10, "mixed-topic wave must cap at 10")
    _assert(checklist._decision_wave_size_plan(normal)["size"] == 20, "normal homogeneous wave must cap at 20")
    _assert(checklist._decision_wave_size_plan(low_risk)["size"] == 40, "low-risk same-template wave can cap at 40")


def test_stale_decision_wave_requires_refresh() -> None:
    reports = [_fake_report(60, ["docs/a.md"], lane="block")]
    plan = checklist._decision_wave_size_plan(reports, scan_fresh=False)
    _assert(plan["size"] == 0, "stale live report must not allow wave writes")
    _assert(plan["next_action"] == "refresh_scan", "stale live report should request refresh")


def test_decision_wave_visible_without_merge_or_patch_train() -> None:
    reports = [
        _fake_report(70, ["docs/a.md"], lane="block"),
        _fake_report(71, ["docs/b.md"], lane="block"),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(not graph["queue_cohorts"], "blocked-only batch must not create merge queue")
    _assert(not graph["parallel_patch_trains"], "blocked-only batch must not create patch train")
    _assert(graph["decision_waves"], "blocked-only batch must still expose decision wave train")
    wave = graph["decision_waves"][0]
    _assert(wave["next_action"] == "ask_operator", "decision wave must ask operator before writes")
    _assert(wave["prs"] == [70, 71], "decision wave should include the selected PRs")


def test_pre_wave_question_contains_research_shape_and_links() -> None:
    reports = [
        _fake_report(80, ["docs/a.md"], lane="block"),
        _fake_report(81, ["docs/b.md"], lane="block"),
    ]
    graph = checklist._build_train_graph(
        reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    batch = {"repo": "hushh-labs/hushh-research", "reports": reports, "decision_waves": graph["decision_waves"]}
    text = "\n".join(checklist._decision_wave_lines(batch))
    for expected in [
        "Question Before Wave",
        "Current truth",
        "Recommended path",
        "Risk if accepted blindly",
        "Decision needed",
        "https://github.com/hushh-labs/hushh-research/pull/80",
        "https://github.com/hushh-labs/hushh-research/pull/81",
    ]:
        _assert(expected in text, f"decision wave output must include {expected}")


def test_check_failure_excluded_from_acknowledgement_wave() -> None:
    failing = _fake_report(90, ["docs/fail.md"], lane="block", ci_status_gate="FAILURE")
    healthy = _fake_report(91, ["docs/ok.md"], lane="block")
    graph = checklist._build_train_graph(
        [failing, healthy],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    wave = graph["decision_waves"][0]
    _assert(90 not in wave["candidate_prs"], "check-failure PR must not enter acknowledgement wave")
    _assert(91 in wave["candidate_prs"], "healthy blocked PR should enter acknowledgement wave")
    _assert(graph["check_failure_holds"][0]["pr"] == 90, "check-failure PR must be held separately")


def test_actionable_intake_filter_separates_unattended_repass_and_dormant() -> None:
    rows = [
        OrderedDict(
            number=3000,
            url="https://github.com/hushh-labs/hushh-research/pull/3000",
            head_sha="head-3000",
            latest_reviews=[],
            comments=[],
            commits=[],
        ),
        OrderedDict(
            number=3001,
            url="https://github.com/hushh-labs/hushh-research/pull/3001",
            head_sha="head-3001",
            latest_reviews=[
                {
                    "author": {"login": "kushaltrivedi5"},
                    "state": "CHANGES_REQUESTED",
                    "submittedAt": "2026-05-30T10:00:00Z",
                    "body": "## Changes Requested: narrow this",
                }
            ],
            comments=[
                {
                    "author": {"login": "contributor"},
                    "createdAt": "2026-05-30T11:00:00Z",
                    "body": "Updated the branch.",
                }
            ],
            commits=[],
        ),
        OrderedDict(
            number=3002,
            url="https://github.com/hushh-labs/hushh-research/pull/3002",
            head_sha="head-3002",
            updated_at="2026-05-30T12:00:00Z",
            latest_reviews=[
                {
                    "author": {"login": "kushaltrivedi5"},
                    "state": "CHANGES_REQUESTED",
                    "submittedAt": "2026-05-30T12:00:00Z",
                    "body": "## Changes Requested: narrow this",
                }
            ],
            comments=[
                {
                    "author": {"login": "contributor"},
                    "createdAt": "2026-05-30T09:00:00Z",
                    "body": "Earlier note.",
                }
            ],
            commits=[],
        ),
        OrderedDict(
            number=3003,
            url="https://github.com/hushh-labs/hushh-research/pull/3003",
            head_sha="head-3003",
            updated_at="2026-05-30T13:00:00Z",
            latest_reviews=[
                {
                    "author": {"login": "kushaltrivedi5"},
                    "state": "CHANGES_REQUESTED",
                    "submittedAt": "2026-05-30T12:00:00Z",
                    "body": "## Changes Requested: narrow this",
                }
            ],
            comments=[],
            commits=[],
        ),
    ]
    selected, meta = checklist._apply_actionable_intake_filter(rows)
    _assert([row["number"] for row in selected] == [3000, 3001, 3003], "filter must keep unattended and fresh repass PRs")
    _assert(meta["reasons"]["3000"] == "unattended_no_current_maintainer_record", "unattended reason must be explicit")
    _assert(meta["reasons"]["3001"] == "repass_after_contributor_activity", "fresh contributor activity must trigger repass")
    _assert(meta["reasons"]["3003"] == "coarse_pr_activity_after_maintainer_record", "post-review PR activity must trigger repass")
    _assert(meta["dormant_current_count"] == 1, "unchanged current maintainer record should become dormant-current")
    _assert(
        checklist._actionable_intake_reason(rows[3], allow_coarse=False) == "",
        "deep per-PR repass evidence must drop metadata-only updatedAt noise",
    )


def test_repass_changes_requested_can_remain_train_work() -> None:
    report = _fake_report(
        3003,
        ["docs/repass.md"],
        review_decision="CHANGES_REQUESTED",
    )
    report["actionable_intake_reason"] = "repass_after_contributor_activity"
    state, reason = checklist._reviewed_state_for_report(report)
    _assert(state == "remaining", "fresh repass PR should not be classified as terminal")
    _assert(reason == "awaiting train action", "fresh repass PR should not be terminal")
    _assert(checklist._is_actionable_live_candidate(report), "fresh repass merge candidate should be actionable")


def test_decision_wave_excludes_current_changes_requested_without_fresh_repass() -> None:
    current = _fake_report(
        3100,
        ["docs/current.md"],
        lane="block",
        review_decision="CHANGES_REQUESTED",
    )
    fresh = _fake_report(
        3101,
        ["docs/fresh.md"],
        lane="block",
        review_decision="CHANGES_REQUESTED",
    )
    fresh["actionable_intake_reason"] = "repass_after_contributor_activity"
    graph = checklist._build_train_graph(
        [current, fresh],
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    candidates = graph["decision_waves"][0]["candidate_prs"]
    _assert(3100 not in candidates, "current changes-requested PR must not consume decision-wave capacity")
    _assert(3101 in candidates, "fresh repass changes-requested PR should remain in decision wave")


def test_approved_review_counts_as_current_maintainer_record() -> None:
    row = OrderedDict(
        number=3200,
        url="https://github.com/hushh-labs/hushh-research/pull/3200",
        head_sha="head-3200",
        updated_at="2026-05-30T12:00:00Z",
        latest_reviews=[
            {
                "author": {"login": "kushaltrivedi5"},
                "state": "APPROVED",
                "submittedAt": "2026-05-30T12:00:00Z",
                "body": "## Approved: test-only coverage",
            }
        ],
        comments=[],
        commits=[],
    )
    selected, meta = checklist._apply_actionable_intake_filter([row])
    _assert(selected == [], "approved maintainer review should not re-enter unattended intake")
    _assert(meta["dormant_current_count"] == 1, "approved review should become dormant-current until state changes")


def test_current_maintainer_harvest_comment_blocks_merge_repass() -> None:
    row = OrderedDict(
        number=3201,
        url="https://github.com/hushh-labs/hushh-research/pull/3201",
        head_sha="head-3201",
        updated_at="2026-05-31T08:28:27Z",
        latest_reviews=[
            {
                "author": {"login": "kushaltrivedi5"},
                "state": "CHANGES_REQUESTED",
                "submittedAt": "2026-05-16T05:29:15Z",
                "body": "## Changes Requested: maintainer harvest landed",
                "commit": {"oid": "head-3201"},
            }
        ],
        comments=[
            {
                "author": {"login": "kushaltrivedi5"},
                "body": "## Maintainer harvest staged\n\nCurrent-head repass completed.",
                "createdAt": "2026-05-31T08:28:27Z",
                "url": "https://github.com/hushh-labs/hushh-research/pull/3201#issuecomment-1",
            }
        ],
        commits=[
            {
                "authors": [{"login": "contributor"}],
                "committedDate": "2026-05-30T00:00:00Z",
                "oid": "head-3201",
            }
        ],
    )
    _assert(checklist._actionable_intake_reason(row) == "", "current harvest comment must block repass")
    selected, meta = checklist._apply_actionable_intake_filter([row])
    _assert(selected == [], "current harvest comment should not re-enter merge intake")
    _assert(meta["dormant_current_count"] == 1, "current harvest comment should become dormant-current")


def main() -> int:
    test_same_file_collision()
    test_transitive_collision_only_waits_for_direct_edge()
    test_disjoint_merge_queue_cohort()
    test_hard_surface_sequence()
    test_sensitive_runtime_overlap_without_file_edge_does_not_sequence()
    test_patch_gate_blocks_unattached_export()
    test_patch_gate_allows_canonical_attach_point()
    test_pure_test_report_can_merge_now()
    test_failing_required_gate_excluded_from_executable_trains()
    test_failing_auxiliary_check_excluded_from_operator_batches()
    test_zero_queue_cohort_size_does_not_emit_empty_cohort()
    test_scan_failure_is_hold_not_public_changes_requested()
    test_train_graph_maps_trains_to_subagent_lanes()
    test_collision_train_sequences_oldest_created_pr_first()
    test_stacked_dependency_creates_sequential_train()
    test_stacked_dependency_parser_requires_dependency_language()
    test_external_stacked_dependency_blocks_queue_until_repass()
    test_all_async_trains_output_names_parallel_model()
    test_live_selection_order_defaults_to_oldest()
    test_live_selection_order_latest()
    test_live_selection_excludes_previous_tranche()
    test_exclude_files_can_chain_completed_reports()
    test_exclude_files_accept_globbed_tranche_reports()
    test_train_pool_refills_next_oldest_non_touching_train()
    test_report_state_buckets_classify_reviewed_terminal_blocked_remaining()
    test_live_report_prints_reviewed_state_bucket_links()
    test_dynamic_decision_wave_size_selection()
    test_stale_decision_wave_requires_refresh()
    test_decision_wave_visible_without_merge_or_patch_train()
    test_pre_wave_question_contains_research_shape_and_links()
    test_check_failure_excluded_from_acknowledgement_wave()
    test_actionable_intake_filter_separates_unattended_repass_and_dormant()
    test_repass_changes_requested_can_remain_train_work()
    test_decision_wave_excludes_current_changes_requested_without_fresh_repass()
    test_approved_review_counts_as_current_maintainer_record()
    test_current_maintainer_harvest_comment_blocks_merge_repass()
    print("pr_review_checklist unit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
