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


def test_uat_frontend_release_blocks_on_real_analytics_smoke() -> None:
    require(
        ".github/workflows/deploy-uat.yml",
        "id: frontend-analytics-candidate",
        '--update-tags="analytics-candidate=${smoke_revision}"',
        "--remove-secrets=BACKEND_URL,DEVELOPER_API_URL",
        'BACKEND_URL=${{ steps.backend-candidate-state.outputs.backend_candidate_url }}',
        'steps.scope.outputs.deploy_backend == \'true\'',
        "id: verify-analytics-uat",
        "UAT_ANALYTICS_SMOKE_ORIGIN: ${{ steps.frontend-analytics-candidate.outputs.url }}",
        "npm run smoke:analytics:uat",
        "Remove zero-traffic frontend analytics candidate tag",
        "if: always() && steps.scope.outputs.deploy_frontend == 'true'",
        'entry.get("tag") == "analytics-candidate"',
        "--remove-tags=analytics-candidate",
        "Analytics smoke failed; both zero-traffic candidates stay unpromoted.",
        "ANALYTICS_SMOKE_OUTCOME: ${{ steps.verify-analytics-uat.outcome }}",
        'append_unique(blocking, ["analytics_transport_failed"])',
        'if os.environ.get("DEPLOY_BACKEND") == "true":',
        'analytics_smoke_required = os.environ.get("DEPLOY_FRONTEND") == "true"',
        '"analytics_smoke": {',
    )
    content = (ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")
    assert '--set-tags="analytics-candidate=' not in content
    assert "id: promote-paired-backend" not in content
    assert (
        'if [ "${{ steps.scope.outputs.deploy_backend }}" = "true" ] \\\n'
        '            && [ "${{ steps.scope.outputs.deploy_frontend }}" != "true" ]; then'
        not in content
    )
    require(
        ".github/workflows/deploy-uat.yml",
        'release_revision="${{ steps.candidate-state.outputs.frontend_revision }}"',
        'smoke_revision="${release_revision}"',
        '--update-tags="analytics-candidate=${smoke_revision}"',
        'echo "revision=${smoke_revision}" >> "$GITHUB_OUTPUT"',
    )


def test_uat_analytics_smoke_requires_successful_collect_responses() -> None:
    path = "hushh-webapp/scripts/testing/run-uat-analytics-smoke.mjs"
    require(
        path,
        'page.on("response", (response) => {',
        'status: response.ok() ? "finished" : "failed"',
        'page.on("requestfailed", (request) => {',
        'entry.status === "finished"',
        'entry.status === "failed"',
    )
    content = (ROOT / path).read_text(encoding="utf-8")
    require(
        path,
        '"page_view"',
        '"/one/kai?tab=portfolio"',
        '`/one/kai?tab=analysis&ticker=${encodeURIComponent(smokeTicker)}&pickSource=default`',
        'payload.route_id === "kai_home"',
        'process.argv.includes("--full")',
        'params: { journey: "investor", step: "entered" }',
        'params: { route_id: "kai_home" }',
        '"portfolio_viewed"',
        'payload.result === "success" && Boolean(payload.portfolio_source)',
        'portfolio_source: portfolioEvent.payload.portfolio_source',
        'entry_surface: activationEvent.payload.entry_surface',
    )
    package_json = (ROOT / "hushh-webapp/package.json").read_text(encoding="utf-8")
    assert "npm run smoke:analytics:uat -- --full" in package_json


def test_web_targeted_voice_check_uses_locked_protocol_runtime() -> None:
    """Keep the CapabilityGraph compiler out of ambient runner Python."""

    content = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    start = content.index("  web-targeted-check:\n")
    end = content.index("\n  ios-native-check:\n", start)
    web_targeted = content[start:end]
    for fragment in (
        "uses: ./consent-protocol/.github/actions/setup-python-uv",
        "protocol-dir: ./consent-protocol",
        'sync-dev-group: "false"',
    ):
        assert fragment in web_targeted, f"web-targeted-check is missing {fragment!r}"


def test_web_targeted_layout_check_tracks_people_fixture_inputs() -> None:
    require(
        "scripts/ci/web-targeted-check.sh",
        "fixtures/one-location-people-rows\\.html",
        "scripts/testing/capture-one-location-people-fixture\\.mjs",
        'run_check "layout contracts" npm run test:layout-contracts',
    )


def main() -> int:
    tests = (
        test_ci_queue_smoke_and_uat_share_the_selector,
        test_ci_and_queue_pass_selector_decision_to_integration,
        test_smoke_receives_selector_decision_without_reclassification,
        test_uat_publishes_lane_reasons_in_summary_and_release_artifacts,
        test_uat_frontend_release_blocks_on_real_analytics_smoke,
        test_uat_analytics_smoke_requires_successful_collect_responses,
        test_web_targeted_voice_check_uses_locked_protocol_runtime,
        test_web_targeted_layout_check_tracks_people_fixture_inputs,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
