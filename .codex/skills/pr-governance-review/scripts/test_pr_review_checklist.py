#!/usr/bin/env python3
from __future__ import annotations

from collections import OrderedDict

import pr_review_checklist as checklist


def _fake_report(
    number: int,
    files: list[str],
    *,
    lane: str = "merge_now",
    contract_set: str = "general",
    findings: list[dict] | None = None,
    related_files: list[str] | None = None,
    ci_status_gate: str = "SUCCESS",
    current_checks: list[dict] | None = None,
) -> OrderedDict:
    findings = findings or []
    report = OrderedDict(
        pr=OrderedDict(
            number=number,
            title=f"PR {number}",
            url=f"https://github.com/hushh-labs/hushh-research/pull/{number}",
            author="tester",
            head_sha=f"sha-{number}",
            additions=1,
            deletions=0,
            changed_files_count=len(files),
            mergeable="MERGEABLE",
            merge_state_status="CLEAN",
            is_draft=False,
            review_decision="",
        ),
        changed_files=files,
        contract_set=contract_set,
        surface_tags=[],
        current_ci_status_gate=ci_status_gate,
        current_checks=current_checks or [
            OrderedDict(name="CI Status Gate", conclusion=ci_status_gate)
        ],
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


def test_hard_surface_and_sensitive_runtime_sequence() -> None:
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

    runtime_reports = [
        _fake_report(3, ["hushh-webapp/lib/pkm/a.ts"], contract_set="pkm-privacy"),
        _fake_report(4, ["consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py"], contract_set="pkm-privacy"),
    ]
    runtime_graph = checklist._build_train_graph(
        runtime_reports,
        queue_cohort_size=4,
        max_parallel_patch_trains=3,
    )
    _assert(runtime_graph["collision_groups"], "sensitive PKM runtime overlap must sequence")


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


def main() -> int:
    test_same_file_collision()
    test_disjoint_merge_queue_cohort()
    test_hard_surface_and_sensitive_runtime_sequence()
    test_patch_gate_blocks_unattached_export()
    test_patch_gate_allows_canonical_attach_point()
    test_pure_test_report_can_merge_now()
    test_failing_required_gate_excluded_from_executable_trains()
    test_failing_auxiliary_check_excluded_from_operator_batches()
    print("pr_review_checklist unit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
