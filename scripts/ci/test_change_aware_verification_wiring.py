#!/usr/bin/env python3
"""Contract checks for the one changed-SHA verification selector."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: str, *fragments: str) -> None:
    content = (ROOT / path).read_text(encoding="utf-8")
    for fragment in fragments:
        assert fragment in content, f"{path} is missing {fragment!r}"


def test_ci_smoke_and_uat_share_the_selector() -> None:
    # Queue Validation is a pass-through that reuses PR Validation's verdict for
    # an identical tree, so the selector decision it carries is PR Validation's.
    selector = "scripts/ci/resolve-uat-verification-plan.py"
    for workflow in (
        ".github/workflows/ci.yml",
        ".github/workflows/main-post-merge-smoke.yml",
        ".github/workflows/deploy-dev.yml",
        ".github/workflows/deploy-uat.yml",
    ):
        require(workflow, selector, "verification-plan")


def test_ci_passes_selector_decision_to_integration() -> None:
    for workflow in (".github/workflows/ci.yml",):
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


def test_uat_capacity_admission_follows_resolved_scope_on_old_targets() -> None:
    workflow = (ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")
    assert workflow.index("- name: Resolve deployment scope") < workflow.index(
        "- name: Enforce UAT database connection budget before deployment"
    )
    require(
        ".github/workflows/deploy-uat.yml",
        "DEPLOY_BACKEND: ${{ steps.scope.outputs.deploy_backend }}",
        "--candidate-service consent-protocol-drive-worker",
        "--frontend-only",
        'cp "${RUNNER_TEMP}/release-tools/runtime-capacity-budget.py"',
        'cp "${RUNNER_TEMP}/release-tools/runtime_capacity_inventory.py"',
        'cp "${RUNNER_TEMP}/release-tools/runtime-capacity.json"',
        'cp "${RUNNER_TEMP}/release-tools/verify_passkey_domain_associations.py"',
    )
    require(
        ".github/workflows/deploy-uat-one-chat.yml",
        "--inherit-candidate-service consent-protocol",
        'cp "${RUNNER_TEMP}/capacity-tools/runtime-capacity-budget.py"',
        'cp "${RUNNER_TEMP}/capacity-tools/runtime_capacity_inventory.py"',
        'cp "${RUNNER_TEMP}/capacity-tools/runtime-capacity.json"',
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
    candidate_step = content.split(
        "      - name: Resolve zero-traffic frontend analytics candidate", 1
    )[1].split("      - name: Verify governed analytics transport on zero-traffic UAT candidate", 1)[0]
    secret_removal = candidate_step.index("--remove-secrets=BACKEND_URL,DEVELOPER_API_URL")
    literal_binding = candidate_step.index('--update-env-vars="BACKEND_URL=')
    assert (
        'gcloud run services update "${{ env.FRONTEND_SERVICE }}"'
        in candidate_step[secret_removal:literal_binding]
    ), "Cloud Run requires separate updates to switch a secret-backed variable to a literal"
    restore_step = content.split("      - name: Restore canonical frontend backend bindings", 1)[1].split(
        "      - name: Promote deployed revisions to UAT traffic", 1
    )[0]
    assert "--no-traffic" in restore_step
    assert "--remove-env-vars=BACKEND_URL,DEVELOPER_API_URL" in restore_step
    assert "--update-secrets=BACKEND_URL=BACKEND_URL:latest,DEVELOPER_API_URL=BACKEND_URL:latest" in restore_step
    assert "Canonical secret binding missing" in restore_step
    rollback_step = content.split("      - name: Resolve rollback targets from predeploy traffic", 1)[1].split(
        "      - name: Resolve UAT verification plan", 1
    )[0]
    assert 'backend_revision="${{ steps.predeploy-state.outputs.backend_revision }}"' in rollback_step
    assert 'frontend_revision="${{ steps.predeploy-state.outputs.frontend_revision }}"' in rollback_step
    assert 'if [ -z "${backend_revision}" ]; then' in rollback_step
    assert 'if [ -z "${frontend_revision}" ]; then' in rollback_step
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


def test_uat_and_production_resolve_frontend_candidate_by_exact_deploy_labels() -> None:
    resolver = "scripts/ci/resolve-cloud-run-deploy-revision.py"
    require(
        ".github/workflows/deploy-uat.yml",
        resolver,
        "--deploy-env uat",
        "--deploy-source deploy-uat",
        '--github-run-id "${{ github.run_id }}"',
        '--github-run-attempt "${{ github.run_attempt }}"',
        '${RUNNER_TEMP}/release-tools/resolve-cloud-run-deploy-revision.py',
    )
    require(
        ".github/workflows/deploy-production.yml",
        resolver,
        "--deploy-env production",
        "--deploy-source deploy-production",
        '--github-run-id "${{ github.run_id }}"',
        '--github-run-attempt "${{ github.run_attempt }}"',
        '--deploy-sha "${{ github.event.inputs.sha }}"',
        '${RUNNER_TEMP}/release-tools/resolve-cloud-run-deploy-revision.py',
    )


def test_uat_analytics_smoke_requires_successful_collect_responses() -> None:
    path = "hushh-webapp/scripts/testing/run-uat-analytics-smoke.mjs"
    require(
        path,
        'page.on("requestfinished", async (request) => {',
        'status: response?.ok() ? "finished" : "failed"',
        'page.on("requestfailed", (request) => {',
        'entry.status === "finished"',
        'candidate.status === "failed"',
    )
    content = (ROOT / path).read_text(encoding="utf-8")
    # Static asset 5xx diagnosis may observe responses, but GA delivery must
    # continue to require requestfinished and a successful final response.
    asset_response_handler = content.split('page.on("response", (response) => {', 1)[1].split(
        'page.on("request", (request) => {', 1
    )[0]
    assert "isCandidateStaticAsset5xx" in asset_response_handler
    assert "analyticsCollectEvents.push" not in asset_response_handler
    require(
        path,
        '"page_view"',
        '"/one/kai?tab=portfolio"',
        '`/one/kai?tab=analysis&ticker=${encodeURIComponent(smokeTicker)}&pickSource=default`',
        'payload.route_id === "kai_home"',
        'process.argv.includes("--full")',
        'params: { route_id: "kai_home" }',
        '"portfolio_viewed"',
        'payload.result === "success" && Boolean(payload.portfolio_source)',
        'portfolio_source: portfolioEvent.payload.portfolio_source',
        'requestId: getAnalyticsRequestId(request)',
        'candidate.requestId === entry.requestId',
        'entry_surface: activationEvent.payload.entry_surface',
    )
    assert 'payload.journey === "investor" && payload.step === "entered"' not in content
    package_json = (ROOT / "hushh-webapp/package.json").read_text(encoding="utf-8")
    assert "npm run smoke:analytics:uat -- --full" in package_json


def test_uat_analytics_transient_asset_retry_is_bounded_and_fail_closed() -> None:
    path = ".github/workflows/deploy-uat.yml"
    content = (ROOT / path).read_text(encoding="utf-8")
    step = content.split("      - name: Verify governed analytics transport on zero-traffic UAT candidate", 1)[1].split(
        "      - name: Remove zero-traffic frontend analytics candidate tag", 1
    )[0]
    assert step.count("npm run smoke:analytics:uat") == 2
    assert 'smoke_attempt_1_statuses=("${PIPESTATUS[@]}")' in step
    assert '"classification": "candidate_asset_unavailable"' in step
    assert 'exit "${smoke_attempt_1_statuses[0]}"' in step
    assert "sleep 15" in step
    assert "npm run smoke:analytics:uat 2>&1 | tee -a /tmp/uat-analytics-smoke.log" in step
    assert "--to-revisions=" not in step


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
        test_ci_smoke_and_uat_share_the_selector,
        test_ci_passes_selector_decision_to_integration,
        test_smoke_receives_selector_decision_without_reclassification,
        test_uat_capacity_admission_follows_resolved_scope_on_old_targets,
        test_uat_publishes_lane_reasons_in_summary_and_release_artifacts,
        test_uat_frontend_release_blocks_on_real_analytics_smoke,
        test_uat_analytics_smoke_requires_successful_collect_responses,
        test_uat_analytics_transient_asset_retry_is_bounded_and_fail_closed,
        test_web_targeted_voice_check_uses_locked_protocol_runtime,
        test_web_targeted_layout_check_tracks_people_fixture_inputs,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
