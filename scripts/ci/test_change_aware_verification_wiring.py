#!/usr/bin/env python3
"""Contract checks for the one changed-SHA verification selector."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
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


def _uat_step(name: str, field: str = "run") -> str:
    """One checked-in deploy-uat step: its dedented run script, or its whole block."""
    workflow = (ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^(      - name: {re.escape(name)}\n.*?^        run: \|\n(.*?))(?=^      - name: )",
        workflow,
    )
    assert match, name
    return textwrap.dedent(match.group(2)) if field == "run" else match.group(1)


# Stands in for the trusted receipt reader: accepts each "sha:service" in $ACCEPTED.
_ACCEPTANCE_READER = """import json, os, sys
args = sys.argv[1:]
opts = dict(zip(args[1::2], args[2::2]))
assert args[0] == "require" and opts["--environment"] == "uat" and "--output" in opts
scope = opts["--scope"]
assert scope in ("all", "backend", "frontend")
services = ["backend", "frontend"] if scope == "all" else [scope]
with open(os.environ["READER_CALLS"], "a") as calls:
    calls.write(opts["--sha"] + ":" + scope + "\\n")
if any(opts["--sha"] + ":" + s not in os.environ["ACCEPTED"].split(",") for s in services):
    print("Predecessor acceptance refused: no receipt")
    raise SystemExit(1)
with open(opts["--output"], "w") as out:
    json.dump({"status": "accepted"}, out)
"""


def _uat_base_fixture(temp: Path, env: dict[str, str]) -> tuple[str, str, str]:
    """Accepted, tagged A and B, then an untagged candidate that changes reviewer paths."""
    repo = temp / "candidate"
    repo.mkdir()

    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603 - fixed git argv in a temporary repository.
            ["git", "-c", "user.name=ci", "-c", "user.email=ci@example.invalid",
             "-c", f"core.excludesFile={os.devnull}", *args],
            cwd=repo,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-q")
    git("init", "-q", "--bare", str(temp / "origin.git"))
    git("remote", "add", "origin", str(temp / "origin.git"))
    accepted = []
    for name in ("a", "b"):
        git("commit", "-q", "--allow-empty", "-m", name)
        accepted.append(git("rev-parse", "HEAD"))
        git("tag", f"deployed/uat/{accepted[-1][:8]}-20261029T11144{len(accepted)}Z")
    for path in (
        "hushh-webapp/lib/vault/vault-context.tsx",
        "consent-protocol/api/routes/vault_routes.py",
    ):
        (repo / path).parent.mkdir(parents=True)
        (repo / path).write_text("# reviewer path\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-q", "-m", "candidate")
    git("push", "-q", "origin", "--tags")
    (repo / "scripts/ci").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/ci/resolve-uat-verification-plan.py", repo / "scripts/ci")
    (temp / "runner/release-tools").mkdir(parents=True)
    (temp / "runner/release-tools/verify-predecessor-acceptance.py").write_text(_ACCEPTANCE_READER)
    return accepted[0], accepted[1], git("rev-parse", "HEAD")


def _run_uat_step(temp: Path, name: str, env: dict[str, str], output: str) -> str:
    """Run one checked-in step in the candidate checkout; return its stdout and stderr."""
    script = _uat_step(name).replace("/tmp/", f"{temp}/tmp/")
    result = subprocess.run(  # noqa: S603 - checked-in workflow step, fixed test values.
        ["bash", "-c", script],
        cwd=temp / "candidate",
        env={**env, "GITHUB_OUTPUT": str(temp / output)},
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return result.stdout + result.stderr


def _run_uat_plan(temp: Path, env: dict[str, str]) -> tuple[dict, str, list[str]]:
    """Run the trusted bases step, then the token-free plan step, as the workflow does."""
    shutil.rmtree(temp / "tmp", ignore_errors=True)
    (temp / "tmp").mkdir()
    for name in ("bases-output", "plan-output", "reader-calls"):
        (temp / name).write_text("")
    env = {**env, "RUNNER_TEMP": str(temp / "runner"), "READER_CALLS": str(temp / "reader-calls")}
    log = _run_uat_step(temp, "Prove UAT comparison bases", env, "bases-output")
    bases = dict(line.split("=", 1) for line in (temp / "bases-output").read_text().splitlines())
    env.update(BACKEND_BASE_SHA=bases["backend_base"], FRONTEND_BASE_SHA=bases["frontend_base"])
    _run_uat_step(temp, "Resolve UAT verification plan", env, "plan-output")
    plan = json.loads((temp / "tmp/uat-verification-plan.json").read_text(encoding="utf-8"))
    return plan, log, (temp / "reader-calls").read_text().split()


def test_uat_plan_steps_bind_only_their_inputs() -> None:
    # Only the trusted bases step holds the token; the candidate selector gets bases, not secrets.
    def env_of(name: str) -> dict[str, str]:
        return dict(re.findall(r"(?m)^          ([A-Z_]+): (.+)$", _uat_step(name, "block")))

    scope = {
        "DEPLOY_BACKEND": "${{ steps.scope.outputs.deploy_backend }}",
        "DEPLOY_FRONTEND": "${{ steps.scope.outputs.deploy_frontend }}",
    }
    assert env_of("Prove UAT comparison bases") == {
        "GH_TOKEN": "${{ secrets.GITHUB_TOKEN }}",
        "BACKEND_SERVING_SHA": "${{ steps.predeploy-state.outputs.backend_sha }}",
        "FRONTEND_SERVING_SHA": "${{ steps.predeploy-state.outputs.frontend_sha }}",
        **scope,
    }
    assert env_of("Resolve UAT verification plan") == {
        "TARGET_SHA": "${{ steps.resolve-sha.outputs.sha }}",
        "BACKEND_BASE_SHA": "${{ steps.verification-bases.outputs.backend_base }}",
        "FRONTEND_BASE_SHA": "${{ steps.verification-bases.outputs.frontend_base }}",
        **scope,
        "RUN_LIVE_MODEL_CHECKS": "${{ inputs.run_live_model_checks && 'true' || 'false' }}",
    }
    plan_block = _uat_step("Resolve UAT verification plan", "block")
    assert "secrets." not in plan_block and "github.token" not in plan_block
    require(".github/workflows/deploy-uat.yml", "            /tmp/uat-verification-base-*.json\n")


def test_uat_plan_compares_only_from_accepted_serving_shas() -> None:
    # A candidate can keep serving after its acceptance failed. Comparing its
    # retry, or the next release, from it would drop the lane that failed.
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "GITHUB_", "GH_"))}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        a, b, candidate = _uat_base_fixture(temp, env)
        env.update(TARGET_SHA=candidate, RUN_LIVE_MODEL_CHECKS="false")
        both = f"{a}:backend,{a}:frontend"
        unproven = "conservative:comparison_base_unproven"

        def plan(backend: str, frontend: str, accepted_by=both, deploy=("true", "true")):
            return _run_uat_plan(temp, {
                **env, "ACCEPTED": accepted_by, "BACKEND_SERVING_SHA": backend,
                "FRONTEND_SERVING_SHA": frontend, "DEPLOY_BACKEND": deploy[0],
                "DEPLOY_FRONTEND": deploy[1],
            })

        narrowed, _, calls = plan(a, a)
        assert narrowed["reason"] == "changed_paths:reviewer_byok" and calls == [f"{a}:all"]
        assert (temp / "tmp/uat-verification-base-all.json").exists(), "kept in the artifact"
        # The failed candidate still serves; it has no release tag, so no search runs.
        retry, log, calls = plan(candidate, candidate)
        assert retry["reason"] == unproven and calls == [], log
        assert retry["lanes"]["reviewer_byok"]["required"] is True
        # Any unproven deployed service skips every receipt search.
        for backend, frontend in ((a, candidate), (candidate, a)):
            skipped, log, calls = plan(backend, frontend)
            assert skipped["reason"] == unproven and calls == [], log
        split, _, calls = plan(a, b, f"{a}:backend,{b}:frontend")
        assert split["reason"] == "changed_paths:reviewer_byok"
        assert calls == [f"{a}:backend", f"{b}:frontend"]
        refused, _, calls = plan(a, b, f"{b}:frontend")
        assert refused["reason"] == unproven and calls == [f"{a}:backend"], "frontend skipped"
        # A receipt for one service never proves the other, and a refusal is no base.
        partial, log, calls = plan(a, a, f"{a}:frontend")
        assert partial["reason"] == unproven and calls == [f"{a}:all"]
        assert "backend=none frontend=none" in log
        for deploy, accepted_by, call in ((("false", "true"), f"{a}:frontend", f"{a}:frontend"),
                                          (("true", "false"), f"{a}:backend", f"{a}:backend")):
            single, _, calls = plan(a, a, accepted_by, deploy)
            assert single["reason"] == "changed_paths:reviewer_byok" and calls == [call]
        assert plan(candidate, a, both, ("true", "false"))[0]["reason"] == unproven


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
        '"${RUNNER_TEMP}/release-tools/runtime_capacity_volume.py" scripts/ci/',
        'cp "${RUNNER_TEMP}/release-tools/runtime-capacity.json"',
        'cp "${RUNNER_TEMP}/release-tools/verify_passkey_domain_associations.py"',
    )
    require(
        ".github/workflows/deploy-uat-one-chat.yml",
        "--inherit-candidate-service consent-protocol",
        'cp "${RUNNER_TEMP}/capacity-tools/runtime-capacity-budget.py"',
        'cp "${RUNNER_TEMP}/capacity-tools/runtime_capacity_inventory.py"',
        '"${RUNNER_TEMP}/capacity-tools/runtime_capacity_volume.py" scripts/ci/',
        'cp "${RUNNER_TEMP}/capacity-tools/runtime-capacity.json"',
    )

    require(
        ".github/workflows/deploy-production.yml",
        'cp scripts/ci/runtime_capacity_volume.py "${RUNNER_TEMP}/release-tools/"',
        'cp "${RUNNER_TEMP}/release-tools/runtime_capacity_volume.py" scripts/ci/',
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


def test_financial_packet_inputs_schedule_existing_connections_pack() -> None:
    import json

    from web_ci_lane_fixture import _run

    for changed in (
        "hushh-webapp/e2e/financial-packets.layout.spec.ts",
        "hushh-webapp/e2e/fixtures/person-profile-browser.ts",
        "hushh-webapp/components/connections/person-profile-packets.tsx",
        "hushh-webapp/components/consent/drive-packet-catalog.tsx",
        "hushh-webapp/components/consent/packets/financial-packet-summaries.tsx",
    ):
        code, calls, output = _run(
            ROOT / "scripts/ci/web-targeted-check.sh",
            {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed},
        )
        assert code == 0, output[-2000:]
        overlap_owner = "run test:drive-sharing-layout" in calls
        expected = "run test:connections-layout:without-covered" if overlap_owner else "run test:connections-layout"
        assert calls.count(expected) == 1, (changed, calls)
    scripts = json.loads((ROOT / "hushh-webapp/package.json").read_text())["scripts"]
    selected = scripts["test:connections-layout"].split("--project=chromium")[0]
    assert selected.count("e2e/financial-packets.layout.spec.ts") == 1
    assert selected.count("e2e/person-profile-actions.layout.spec.ts") == 1


def main() -> int:
    tests = (
        test_ci_smoke_and_uat_share_the_selector,
        test_ci_passes_selector_decision_to_integration,
        test_uat_plan_steps_bind_only_their_inputs,
        test_uat_plan_compares_only_from_accepted_serving_shas,
        test_smoke_receives_selector_decision_without_reclassification,
        test_uat_capacity_admission_follows_resolved_scope_on_old_targets,
        test_uat_publishes_lane_reasons_in_summary_and_release_artifacts,
        test_uat_frontend_release_blocks_on_real_analytics_smoke,
        test_uat_analytics_smoke_requires_successful_collect_responses,
        test_uat_analytics_transient_asset_retry_is_bounded_and_fail_closed,
        test_web_targeted_voice_check_uses_locked_protocol_runtime,
        test_web_targeted_layout_check_tracks_people_fixture_inputs,
        test_financial_packet_inputs_schedule_existing_connections_pack,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
