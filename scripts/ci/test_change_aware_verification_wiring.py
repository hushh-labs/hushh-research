#!/usr/bin/env python3
"""Contract checks for the one changed-SHA verification selector."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: str, *fragments: str) -> None:
    content = (ROOT / path).read_text(encoding="utf-8")
    for fragment in fragments:
        assert fragment in content, f"{path} is missing {fragment!r}"


def test_ci_queue_smoke_and_uat_share_the_selector() -> None:
    selector = "scripts/ci/resolve-uat-verification-plan.py"
    for workflow in (
        ".github/workflows/ci.yml",
        ".github/workflows/queue-validation.yml",
        ".github/workflows/main-post-merge-smoke.yml",
        ".github/workflows/deploy-uat.yml",
    ):
        require(workflow, selector, "verification-plan")


def test_ci_and_queue_pass_selector_decision_to_integration() -> None:
    for workflow in (".github/workflows/ci.yml", ".github/workflows/queue-validation.yml"):
        require(
            workflow,
            "CI_RUN_PKM_UPGRADE_GATE: ${{ steps.verification-plan.outputs.run_pkm_upgrade_gate }}",
            "CI_VERIFICATION_PLAN_REASON: ${{ steps.verification-plan.outputs.reason }}",
        )


def test_smoke_receives_selector_decision_without_reclassification() -> None:
    require(
        ".github/workflows/main-post-merge-smoke.yml",
        "CI_RUN_PKM_UPGRADE_GATE: ${{ steps.verification-plan.outputs.run_pkm_upgrade_gate }}",
    )


def test_uat_publishes_lane_reasons_in_summary_and_release_artifacts() -> None:
    require(
        ".github/workflows/deploy-uat.yml",
        "name: uat-verification-plan",
        "VERIFICATION_PLAN_LANES: ${{ steps.verification-plan.outputs.lanes }}",
        '"lanes": json.loads(os.environ.get("VERIFICATION_PLAN_LANES") or "{}")',
        "Verification lanes:",
    )
    require(
        "scripts/ci/main-post-merge-smoke.sh",
        'run_pkm_upgrade_gate="${CI_RUN_PKM_UPGRADE_GATE:-}"',
        'if [ -z "$run_pkm_upgrade_gate" ]; then',
    )


def main() -> int:
    tests = (
        test_ci_queue_smoke_and_uat_share_the_selector,
        test_ci_and_queue_pass_selector_decision_to_integration,
        test_smoke_receives_selector_decision_without_reclassification,
        test_uat_publishes_lane_reasons_in_summary_and_release_artifacts,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
