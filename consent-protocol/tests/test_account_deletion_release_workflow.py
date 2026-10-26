from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from tests.helpers import deployment_cli
from tests.helpers.phone_retirement_fixture import lifecycle_retirement_revisions

ROOT = Path(__file__).resolve().parents[2]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "deploy-uat.yml"
SERVING_STATE_SCRIPT = ROOT / "scripts" / "ci" / "resolve-cloud-run-serving-state.py"
SCHEDULER_ATTEMPT_SCRIPT = ROOT / "scripts" / "ci" / "verify-cloud-scheduler-attempt.py"
SCHEDULER_SETUP_SCRIPT = ROOT / "deploy" / "account-deletion" / "setup_cleanup_scheduler.sh"
FENCE_DECISION_SCRIPT = ROOT / "scripts" / "ci" / "account-deletion-fence-decision.py"
CLOUD_RUN_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "cloud_run"
CLOUD_SCHEDULER_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "cloud_scheduler"


def _activation_module():
    spec = importlib.util.spec_from_file_location(
        "account_lifecycle_activation", ROOT / "deploy/account-deletion/activate_release.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _activation_adapter(module, args, failure, monkeypatch, *, phone_floor=False):
    service, revisions = lifecycle_retirement_revisions(
        args.expected_sha, invalid_candidate=failure == "candidate"
    )
    calls, deleted = [], []
    supported = {args.expected_sha: phone_floor, "d" * 40: False}
    monkeypatch.setattr(
        module,
        "supports_current_contract",
        lambda sha, rollback=False: sha in supported and (not rollback or supported[sha]),
    )
    ticks = iter([0, 361])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(ticks))

    @contextmanager
    def database(_args):
        yield {"fixture": "disposable-port"}

    monkeypatch.setattr(module, "database", database)

    def run(argv, **_kwargs):
        calls.append(argv)
        if argv[:4] == ["gcloud", "run", "services", "describe"]:
            return json.dumps(service)
        if argv[:4] == ["gcloud", "run", "revisions", "list"]:
            return json.dumps(
                [
                    row
                    for row in revisions
                    if row["metadata"]["name"] not in deleted or failure == "retirement"
                ]
            )
        if argv[:4] == ["gcloud", "run", "revisions", "delete"]:
            deleted.append(argv[4])
            return ""
        if argv[:3] == ["gcloud", "logging", "read"]:
            entry = {
                "timestamp": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat(),
                "jsonPayload": {
                    "@type": "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished",
                    "jobName": "projects/hushh-pda-uat/locations/us-central1/jobs/account-deletion-cleanup-uat",
                    "url": "https://api.uat.hushh.ai/api/account/deletion-cleanup/drain?limit=10",
                },
                "httpRequest": {"status": 503 if failure == "scheduler" else 200},
            }
            return json.dumps([entry])
        if argv[0] == "psql" and "--command" in argv:
            return (
                "1" if failure == "database" else "2" if "contract_version()" in argv[-1] else "{}"
            )
        return ""

    monkeypatch.setattr(module, "run", run)
    return calls, deleted


@pytest.mark.parametrize("failure", [None, "candidate", "database", "scheduler", "retirement"])
@pytest.mark.parametrize("phone_floor", [False, True])
def test_activation_requires_exact_candidate_database_delivery_and_legacy_retirement(
    monkeypatch, tmp_path, failure, phone_floor
):
    module = _activation_module()
    args = SimpleNamespace(
        project="hushh-pda-uat",
        region="us-central1",
        backend_service="consent-protocol",
        backend_url="https://api.uat.hushh.ai",
        oidc_audience="https://api.uat.hushh.ai",
        scheduler_job="account-deletion-cleanup-uat",
        scheduler_service_account="account-deletion-cleanup",
        expected_sha="a" * 40,
        expected_run_id="123",
        fence_required=True,
        evidence_prefix=str(tmp_path / "activation"),
    )
    calls, deleted = _activation_adapter(
        module, args, failure, monkeypatch, phone_floor=phone_floor
    )
    evidence = {"status": "blocked"}
    if failure:
        with pytest.raises((ValueError, RuntimeError)):
            module.activate(args, evidence)
        assert evidence["status"] == "blocked"
        assert not any("remove_release_fence.sql" in arg for call in calls for arg in call)
        if failure in {"candidate", "database", "scheduler"}:
            assert not deleted
    else:
        module.activate(args, evidence)
        assert evidence["status"] == "activated"
        assert evidence["scheduler"]["completion"]["http_status"] == 200
        assert deleted == ["consent-protocol-legacy"] + (
            ["consent-protocol-prephone"] if phone_floor else []
        )
        assert evidence["retirement"]["phone_admission_floor_required"] is phone_floor
        assert evidence["retirement"]["remaining_pre_phone425_count"] == (
            0 if phone_floor else None
        )
        retirement = next(
            i
            for i, call in enumerate(calls)
            if call[:4] == ["gcloud", "run", "revisions", "delete"]
        )
        removal = next(
            i
            for i, call in enumerate(calls)
            if any("remove_release_fence.sql" in arg for arg in call)
        )
        assert retirement < removal
        assert "expected_fence_count=0" in calls[-1]
        assert evidence["fence_removal"] == "confirmed_absent"
        assert (tmp_path / "activation-boundary.log").is_file()


@pytest.mark.parametrize(
    ("project", "instance", "origin", "database", "port"),
    [
        (
            "hushh-pda-dev",
            "hushh-dev-pg",
            "https://consent-protocol-621416509462.us-central1.run.app",
            "postgres",
            6543,
        ),
        ("hushh-pda-uat", "hushh-uat-pg", "https://api.uat.hushh.ai", "postgres", 6543),
        ("hushh-pda", "hushh-vault-db", "https://api.hushh.ai", "hushh_vault", 6544),
    ],
)
def test_activation_pins_environment_database_and_retains_failure_receipt(
    monkeypatch, tmp_path, project, instance, origin, database, port
):
    module = _activation_module()
    argv = [
        "activation",
        "--project",
        project,
        "--region",
        "us-central1",
        "--backend-service",
        "consent-protocol",
        "--backend-url",
        origin,
        "--oidc-audience",
        origin,
        "--scheduler-job",
        "account-deletion-cleanup",
        "--scheduler-service-account",
        "account-deletion-cleanup",
        "--expected-sha",
        "a" * 40,
        "--expected-run-id",
        "123",
        "--cloudsql-instance",
        f"{project}:us-central1:{instance}",
        "--evidence-prefix",
        str(tmp_path / "release"),
        "--fence-required",
        "true",
        "--db-name",
        database,
        "--db-port",
        str(port),
    ]
    monkeypatch.setattr(sys, "argv", argv)
    calls = []

    def fail_after_removal_requested(args, evidence):
        calls.append(args.db_name)
        evidence["fence_removal"] = "requested_outcome_unconfirmed"
        raise RuntimeError("psql_failed_1")

    monkeypatch.setattr(module, "activate", fail_after_removal_requested)
    assert module.main() == 1
    receipt = json.loads((tmp_path / "release-activation.json").read_text())
    assert calls == [database]
    assert receipt["status"] == "blocked"
    assert receipt["fence_removal"] == "requested_outcome_unconfirmed"
    argv[argv.index("--db-name") + 1] = "wrong_database"
    with pytest.raises(SystemExit):
        module.main()
    assert calls == [database]


def test_shared_dev_requires_lifecycle_activation_before_healthy_acceptance():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    by_name = {step.get("name"): step for step in steps}
    activation = by_name["Activate tombstone-aware account deletion"]
    assert "env.DEV_TARGET == 'shared-dev'" in activation["if"]
    assert "activate_release.py" in activation["run"]
    assert "--fence-required true" in activation["run"]
    installer = by_name["Install PostgreSQL client for selected lifecycle or preservation"]
    assert "steps.scope.outputs.deploy_backend" in installer["if"]
    assert steps.index(installer) < steps.index(
        by_name["Apply dev DB migrations and predeploy schema gate"]
    )
    status = by_name["Write dev release status artifact"]["run"]
    assert "steps.activate-account-deletion.outcome" in status
    assert status.index("steps.activate-account-deletion.outcome") < status.index('"status":')


@pytest.mark.parametrize(
    ("workflow", "prefix"), [("dev", "dev"), ("uat", "uat"), ("production", "prod")]
)
def test_every_release_retains_activation_failure_evidence(workflow, prefix):
    document = yaml.safe_load((ROOT / f".github/workflows/deploy-{workflow}.yml").read_text())
    required_if = "always()"
    if workflow == "production":
        required_if = f"env.PHONE_DEPLOY_PHASE != 'cold' && ({required_if})"
    assert any(
        step.get("if") == required_if
        and "upload-artifact" in step.get("uses", "")
        and any(
            path in step["with"]["path"]
            for path in [
                f"/tmp/{prefix}-account-deletion-activation.json",  # noqa: S108 - workflow artifact path, never opened here
                f"/tmp/{prefix}-account-deletion-*.json",  # noqa: S108 - workflow artifact path, never opened here
            ]
        )
        for step in document["jobs"]["deploy"]["steps"]
    )


def _workflow_steps() -> list[dict]:
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    return workflow["jobs"]["deploy"]["steps"]


def _step(name: str) -> dict:
    for step in _workflow_steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"Missing workflow step: {name}")


def _serving_state_module():
    spec = importlib.util.spec_from_file_location(
        "resolve_cloud_run_serving_state", SERVING_STATE_SCRIPT
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _scheduler_attempt_module():
    spec = importlib.util.spec_from_file_location(
        "verify_cloud_scheduler_attempt", SCHEDULER_ATTEMPT_SCRIPT
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _fence_decision_module():
    spec = importlib.util.spec_from_file_location(
        "account_deletion_fence_decision", FENCE_DECISION_SCRIPT
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_v201_rollout_keeps_deletion_available_only_for_safe_changes() -> None:
    decision = _fence_decision_module()
    v201 = [{"metadata": {"labels": {"account-deletion-contract": "v201"}}}]
    old = [{"metadata": {"labels": {"account-deletion-contract": "v200"}}}]
    routine = ["consent-protocol/hushh_mcp/services/feed_service.py"]

    assert decision.eligible_for_unfenced_release(v201, routine)
    assert not decision.eligible_for_unfenced_release(
        v201, ["deploy/account-deletion/verify_release_boundary.sql"]
    )
    assert not decision.eligible_for_unfenced_release(old, routine)
    assert not decision.eligible_for_unfenced_release([], routine)
    assert not decision.eligible_for_unfenced_release(v201, None)
    assert decision.changed_paths("a" * 40, "b" * 40) is None
    for changed_path in (
        "consent-protocol/api/routes/account.py",
        "consent-protocol/hushh_mcp/services/account_service.py",
        "consent-protocol/db/migrate.py",
        "consent-protocol/db/migrations/350_new_identity_table.sql",
        "consent-protocol/db/release_migration_manifest.json",
        "deploy/account-deletion/install_release_fence.sql",
    ):
        assert not decision.eligible_for_unfenced_release(v201, [changed_path])

    for workflow in (WORKFLOW_PATH, ROOT / ".github/workflows/deploy-production.yml"):
        steps = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]["deploy"]["steps"]
        by_name = {step.get("name"): step for step in steps}
        assert (
            "account-deletion-fence-decision.py"
            in by_name["Preserve current release tooling"]["run"]
        )
        assert (
            "${RUNNER_TEMP}/release-tools/account-deletion-fence-decision.py"
            in by_name["Checkout deployment SHA"]["run"]
        )
        assert (
            "deploy/account-deletion/{install,remove}_release_fence.sql"
            in by_name["Preserve current release tooling"]["run"]
        )
        assert (
            'cp "${RUNNER_TEMP}/release-tools/account-deletion/"* deploy/account-deletion/'
            in by_name["Checkout deployment SHA"]["run"]
        )
        qualifier = by_name["Qualify uninterrupted account deletion"]
        assert "verify_release_boundary.sql" in qualifier["run"]
        assert "expected_fence_count=0" in qualifier["run"]
        assert "account-deletion-fence-decision.py" in qualifier["run"]
        fence = by_name["Install fail-closed account deletion release fence"]
        assert "steps.account-deletion-fence-decision.outputs.required == 'true'" in fence["if"]
        migration = by_name[
            next(
                name
                for name in by_name
                if name.startswith("Apply ")
                and "DB migrations behind account deletion fence" in name
            )
        ]
        assert "steps.account-deletion-fence-decision.outputs.required" in migration["run"]
        assert "expected_fence_count=0" in migration["run"]
        rollback = by_name["Roll back backend revision"]
        assert '|| [ "${rollback_contract}" != "v201" ]' in rollback["run"]


def test_reviewed_circle_migration_does_not_pause_deletion(tmp_path: Path, monkeypatch) -> None:
    decision = _fence_decision_module()
    monkeypatch.chdir(tmp_path)

    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603 - fixed Git commands in an isolated fixture
            ["git", *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    def write(path: str, contents: bytes) -> None:
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)

    git("init", "-q")
    git("config", "user.name", "Release Test")
    git("config", "user.email", "release@example.test")
    manifest = {"ordered_migrations": ["349_existing.sql"], "rollback_migrations": {}}
    write(decision.MIGRATION_MANIFEST, json.dumps(manifest).encode())
    write(decision.READ_ONLY_VERIFIER, b"prior fenced verifier\n")
    git("add", ".")
    git("commit", "-qm", "prior release")
    base_sha = git("rev-parse", "HEAD")

    for path in decision.SAFE_CIRCLE_MIGRATION_FILES:
        write(path, (ROOT / path).read_bytes())
    write(decision.READ_ONLY_VERIFIER, (ROOT / decision.READ_ONLY_VERIFIER).read_bytes())
    manifest["ordered_migrations"].append(decision.SAFE_CIRCLE_MIGRATION)
    manifest["rollback_migrations"][decision.SAFE_CIRCLE_MIGRATION] = (
        "rollback/350_circle_chat_full_emoji_reactions.rollback.sql"
    )
    write(decision.MIGRATION_MANIFEST, json.dumps(manifest).encode())
    git("add", ".")
    git("commit", "-qm", "reviewed circle-only migration")
    approved_sha = git("rev-parse", "HEAD")
    v201 = [{"metadata": {"labels": {"account-deletion-contract": "v201"}}}]
    assert decision.eligible_for_unfenced_release(
        v201, decision.changed_paths(base_sha, approved_sha)
    )

    migration_path = next(iter(decision.SAFE_CIRCLE_MIGRATION_FILES))
    write(migration_path, (ROOT / migration_path).read_bytes() + b"\n-- altered\n")
    git("add", ".")
    git("commit", "-qm", "unreviewed migration edit")
    assert not decision.eligible_for_unfenced_release(
        v201, decision.changed_paths(base_sha, git("rev-parse", "HEAD"))
    )

    fence_path = "deploy/account-deletion/install_release_fence.sql"
    write(fence_path, b"SELECT true;\n")
    git("add", ".")
    git("commit", "-qm", "existing lifecycle file")
    before_rename = git("rev-parse", "HEAD")
    (tmp_path / "docs").mkdir()
    git("mv", fence_path, "docs/release-fence.sql")
    git("commit", "-qm", "move lifecycle file")
    assert fence_path in decision.changed_paths(before_rename, git("rev-parse", "HEAD"))

    write(migration_path, (ROOT / migration_path).read_bytes())
    write(decision.READ_ONLY_VERIFIER, b"SELECT true; -- unreviewed verifier edit\n")
    git("add", ".")
    git("commit", "-qm", "unreviewed verifier edit")
    assert not decision.eligible_for_unfenced_release(
        v201, decision.changed_paths(base_sha, git("rev-parse", "HEAD"))
    )

    write(decision.READ_ONLY_VERIFIER, (ROOT / decision.READ_ONLY_VERIFIER).read_bytes())
    manifest["ordered_migrations"].append("351_unreviewed.sql")
    write(decision.MIGRATION_MANIFEST, json.dumps(manifest).encode())
    git("add", ".")
    git("commit", "-qm", "unreviewed manifest edit")
    assert not decision.eligible_for_unfenced_release(
        v201, decision.changed_paths(base_sha, git("rev-parse", "HEAD"))
    )


def test_uat_release_orders_image_fence_schema_runtime_and_activation() -> None:
    names = [str(step.get("name") or "") for step in _workflow_steps()]
    expected_order = [
        "Build and pin backend image before lifecycle migration",
        "Install fail-closed account deletion release fence",
        "Apply UAT DB migrations behind account deletion fence",
        "Deploy backend using Cloud Build",
        "Verify backend candidate readiness and exact-SHA provenance",
        "Promote deployed revisions to UAT traffic",
        "Classify UAT release outcome",
        "Activate tombstone-aware account deletion",
    ]
    positions = [names.index(name) for name in expected_order]
    assert positions == sorted(positions)


def test_uat_backend_deploy_consumes_the_pinned_digest_without_rebuilding() -> None:
    build_run = str(
        _step("Build and pin backend image before lifecycle migration").get("run") or ""
    )
    deploy_run = str(_step("Deploy backend using Cloud Build").get("run") or "")
    readiness_run = str(
        _step("Verify backend candidate readiness and exact-SHA provenance").get("run") or ""
    )

    assert "deploy/backend-image.cloudbuild.yaml" in build_run
    assert "image_summary.digest" in build_run
    assert "^sha256:[0-9a-f]{64}$" in build_run
    assert "_SKIP_IMAGE_BUILD=true" in deploy_run
    assert "_IMAGE_REFERENCE=${{ steps.build-backend-image.outputs.image_reference }}" in deploy_run
    assert 'containers[0].get("image") == expected_image_reference' in readiness_run
    assert "account-deletion-contract" in readiness_run

    image_build = yaml.safe_load(
        (ROOT / "deploy" / "backend-image.cloudbuild.yaml").read_text(encoding="utf-8")
    )
    assert image_build["timeout"] == "1800s"


@pytest.mark.parametrize(
    ("skip_build", "image_reference", "expected_code", "expected_message"),
    [
        ("true", "example.invalid/backend@sha256:" + "a" * 64, 0, "Using prebuilt"),
        ("true", "", 1, "requires an immutable _IMAGE_REFERENCE digest"),
        ("true", "example.invalid/backend:latest", 1, "requires an immutable"),
        ("invalid", "example.invalid/backend@sha256:" + "a" * 64, 1, "must be true or false"),
    ],
)
def test_prebuilt_backend_step_runs_without_substitution_environment(
    skip_build: str, image_reference: str, expected_code: int, expected_message: str
) -> None:
    cloudbuild = yaml.safe_load(
        (ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
    )
    step = next(step for step in cloudbuild["steps"] if step["id"] == "build-backend-image")
    assert step["entrypoint"] == "bash"
    assert step["args"][0] == "-c"
    # Cloud Build replaces simple substitutions; it does not export them as shell
    # variables. Leave Bash parameter operators untouched to exercise strict mode.
    script = step["args"][1].replace("${_SKIP_IMAGE_BUILD}", skip_build)
    script = script.replace("${_IMAGE_REFERENCE}", image_reference)
    environment = os.environ.copy()
    environment.pop("_SKIP_IMAGE_BUILD", None)
    environment.pop("_IMAGE_REFERENCE", None)
    # Never build or touch cloud resources if the production step regresses.
    guards = (
        "docker() { echo UNEXPECTED_BUILD_COMMAND >&2; return 95; }; "
        "gcloud() { echo UNEXPECTED_CLOUD_COMMAND >&2; return 96; };\n"
    )
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required to verify the Cloud Build runtime contract"
    result = subprocess.run(  # noqa: S603 - trusted repo script, fixed inputs, guarded commands
        [bash, "-c", guards + script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    output = result.stdout + result.stderr
    assert result.returncode == expected_code, output
    assert expected_message in output
    assert "UNEXPECTED_" not in output


def test_uat_activation_uses_the_qualified_shared_lifecycle_owner() -> None:
    activation = _step("Activate tombstone-aware account deletion")
    assert activation["if"] == (
        "steps.classify-uat-release.outputs.release_failed == 'false' && "
        "steps.scope.outputs.deploy_backend == 'true'"
    )
    assert "python3 deploy/account-deletion/activate_release.py" in activation["run"]
    assert '--expected-sha "${{ steps.resolve-sha.outputs.sha }}"' in activation["run"]
    assert '--cloudsql-instance "${{ env.UAT_CLOUDSQL_INSTANCE }}"' in activation["run"]


def test_uat_scheduler_service_account_id_is_valid_and_consistent() -> None:
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    scheduler_account_id = workflow["env"]["ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID"]
    deploy_run = str(_step("Deploy backend using Cloud Build").get("run") or "")
    activation = _step("Activate tombstone-aware account deletion")
    scheduler_setup = SCHEDULER_SETUP_SCRIPT.read_text(encoding="utf-8")

    assert 6 <= len(scheduler_account_id) <= 30
    assert re.fullmatch(r"[a-z][a-z0-9-]*[a-z0-9]", scheduler_account_id)
    assert (
        '--scheduler-service-account "${{ env.ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID }}"'
        in activation["run"]
    )
    assert (
        "_ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL="
        "${{ env.ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID }}@"
        "${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in deploy_run
    assert f"SCHEDULER_SERVICE_ACCOUNT_NAME:-{scheduler_account_id}" in scheduler_setup
    assert "iam service-accounts add-iam-policy-binding" not in scheduler_setup
    assert "roles/iam.serviceAccountTokenCreator" not in scheduler_setup


@pytest.mark.parametrize("job_exists", [False, True])
@pytest.mark.parametrize("mutation_fails", [False, True])
def test_scheduler_setup_is_repeatable_without_service_account_policy_admin(
    tmp_path: Path, job_exists: bool, mutation_fails: bool
) -> None:
    environment = os.environ.copy()
    for name in (
        "BASH_ENV",
        "SCHEDULER_SERVICE_ACCOUNT_EMAIL",
        "SCHEDULER_LOCATION",
        "JOB_NAME",
        "CRON",
        "TIMEZONE",
        "BATCH_LIMIT",
        "OIDC_AUDIENCE",
    ):
        environment.pop(name, None)
    environment.update(
        {
            "BACKEND_URL": "https://api.uat.example.com",
            "PROJECT_ID": "example-uat-project",
            "SCHEDULER_SERVICE_ACCOUNT_NAME": "account-deletion-cleanup",
        }
    )
    calls = tmp_path / "gcloud-calls"
    job_state = tmp_path / "scheduler-job-exists"
    if job_exists:
        job_state.touch()
    guards = f'''gcloud() {{
      printf '%s\\n' "$*" >> "{calls.as_posix()}"
      case "$1 $2 $3" in
        "iam service-accounts describe") return 0 ;;
        "scheduler jobs describe")
          [[ -f "{job_state.as_posix()}" ]] || return 1
          printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
            'ENABLED' '*/2 * * * *' \\
            'https://api.uat.example.com/api/account/deletion-cleanup/drain?limit=10' \\
            'POST' \\
            'account-deletion-cleanup@example-uat-project.iam.gserviceaccount.com' \\
            'https://api.uat.example.com'
          return 0
          ;;
        "scheduler jobs create"|"scheduler jobs update")
          [[ "$4" == http && "$5" == account-deletion-cleanup-uat ]] || return 95
          local expected_header forbidden_header argument header_found=false
          if [[ "$3" == update ]]; then
            [[ -f "{job_state.as_posix()}" ]] || return 95
            expected_header='--update-headers=Content-Type=application/json'
            forbidden_header='--headers='
          else
            [[ ! -f "{job_state.as_posix()}" ]] || return 95
            expected_header='--headers=Content-Type=application/json'
            forbidden_header='--update-headers='
          fi
          for argument in "$@"; do
            if [[ "$argument" == "$forbidden_header"* ]]; then
              echo "UNSUPPORTED_HEADER_FLAG: $argument" >&2
              return 2
            fi
            if [[ "$argument" == "$expected_header" ]]; then header_found=true; fi
          done
          [[ "$header_found" == true ]] || return 95
          if [[ "{str(mutation_fails).lower()}" == true ]]; then
            echo SCHEDULER_MUTATION_FAILED >&2
            return 42
          fi
          : > "{job_state.as_posix()}"
          return 0
          ;;
        *) echo "UNEXPECTED_GCLOUD_COMMAND: $*" >&2; return 96 ;;
      esac
    }}
'''
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required for the scheduler behavior test"

    for _ in range(2):
        result = subprocess.run(  # noqa: S603 - trusted script with guarded cloud commands
            [bash, "-c", guards + SCHEDULER_SETUP_SCRIPT.read_text(encoding="utf-8")],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

        output = result.stdout + result.stderr
        assert result.returncode == (42 if mutation_fails else 0), output
        assert "UNSUPPORTED_HEADER_FLAG" not in output
        assert "UNEXPECTED_GCLOUD_COMMAND" not in output
        if mutation_fails:
            assert "SCHEDULER_MUTATION_FAILED" in result.stderr
            assert "Configured and verified" not in result.stdout
        else:
            assert "Configured and verified Cloud Scheduler job" in result.stdout

    commands = calls.read_text(encoding="utf-8").splitlines()
    mutations = [
        line.split()[2]
        for line in commands
        if line.startswith(("scheduler jobs create ", "scheduler jobs update "))
    ]
    expected = ["update", "update"] if job_exists else ["create", "update"]
    if mutation_fails and not job_exists:
        expected = ["create", "create"]
    assert mutations == expected
    describes = [line for line in commands if line.startswith("scheduler jobs describe ")]
    assert len(describes) == (2 if mutation_fails else 4)
    assert not any("iam-policy" in line for line in commands)


@pytest.mark.parametrize(
    "invalid_id",
    [
        "short",
        "a" * 31,
        "Account-deletion-cleanup",
        "account_deletion_cleanup",
        "1account-deletion-cleanup",
        "account-deletion-cleanup-",
        "account-deletion-cleanup-scheduler",
    ],
)
def test_scheduler_setup_rejects_invalid_account_id_before_gcloud(
    tmp_path: Path, invalid_id: str
) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "BACKEND_URL": "https://api.uat.example.com",
            "PROJECT_ID": "example-uat-project",
            "SCHEDULER_SERVICE_ACCOUNT_NAME": invalid_id,
        }
    )
    marker = tmp_path / "gcloud-called"
    guards = f'gcloud() {{ : > "{marker.as_posix()}"; return 0; }};\n'
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required for the scheduler behavior test"

    result = subprocess.run(  # noqa: S603 - trusted script with fixed test environment
        [bash, "-c", guards + SCHEDULER_SETUP_SCRIPT.read_text(encoding="utf-8")],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 1
    assert "must be a valid 6-30 character Google service-account ID" in result.stderr
    assert not marker.exists()


def test_scheduler_setup_rejects_mismatched_explicit_email_before_gcloud(
    tmp_path: Path,
) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "BACKEND_URL": "https://api.uat.example.com",
            "PROJECT_ID": "example-uat-project",
            "SCHEDULER_SERVICE_ACCOUNT_NAME": "account-deletion-cleanup",
            "SCHEDULER_SERVICE_ACCOUNT_EMAIL": (
                "different-account@example-uat-project.iam.gserviceaccount.com"
            ),
        }
    )
    marker = tmp_path / "gcloud-called"
    guards = f'gcloud() {{ : > "{marker.as_posix()}"; return 0; }};\n'
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required for the scheduler behavior test"

    result = subprocess.run(  # noqa: S603 - trusted script with fixed test environment
        [bash, "-c", guards + SCHEDULER_SETUP_SCRIPT.read_text(encoding="utf-8")],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 1
    assert "must match SCHEDULER_SERVICE_ACCOUNT_NAME and PROJECT_ID" in result.stderr
    assert not marker.exists()


@pytest.mark.parametrize(
    "service,contract,sha_valid,allowed",
    [
        ("consent-protocol", "phone", True, True),
        ("consent-protocol", "provider", True, False),
        ("consent-protocol", "unknown", True, False),
        ("consent-protocol", "phone", False, False),
        ("hushh-webapp", "unknown", False, True),
    ],
)
def test_backend_rollback_qualifies_exact_source_before_traffic(
    tmp_path, service, contract, sha_valid, allowed
):
    deployment_cli.assert_backend_source_rollback(
        ROOT, tmp_path, service=service, contract=contract, sha_valid=sha_valid, allowed=allowed
    )


@pytest.mark.parametrize("denied", [None, "reader", "provider"])
def test_backend_rollback_requires_both_reader_and_provider_authority(tmp_path, denied):
    """The real traffic mutator requires both independent compatibility ports."""
    calls, execute = deployment_cli.backend_rollback_authority_fixture(ROOT, tmp_path, denied)

    script = ROOT / "scripts/ci/cloudrun-rollback.sh"
    result = execute(script)
    assert result.returncode == (47 if denied else 0), result.stderr
    expected = ["reader"] if denied == "reader" else ["reader", "provider"]
    if denied is None:
        expected.append("traffic")
    assert calls.read_text().splitlines() == expected
    if denied is None:
        return

    # Remove only the denied authority. The other compatible guard still runs,
    # so a missing helper or relocated fixture cannot masquerade as a denial.
    source = script.read_text()
    start = source.index(
        'if [[ -n "${HUSHH_DOCUMENT_READER_GUARD_REPORT:-}" ]]; then'
        if denied == "reader"
        else 'if [[ "$SERVICE" == "consent-protocol" ]]; then'
    )
    end = source.index("manual_reader_guard=" if denied == "reader" else "cmd=(", start)
    broken = tmp_path / "one-guard-removed.sh"
    broken.write_text(source[:start] + source[end:])
    calls.unlink()
    result = execute(broken)
    assert result.returncode == 0, result.stderr
    assert calls.read_text().splitlines() == [
        "provider" if denied == "reader" else "reader",
        "traffic",
    ]


def test_pre_v201_backend_rollback_requires_fence_and_empty_tombstones() -> None:
    rollback_run = str(_step("Roll back backend revision").get("run") or "")

    assert "install_release_fence.sql" in rollback_run
    assert "SELECT count(*) FROM public.account_deletion_tombstones" in rollback_run
    assert '"${rollback_contract}" != "v201"' in rollback_run
    assert '"${tombstone_count}" != "0"' in rollback_run
    assert "Refusing rollback to a pre-v201 backend" in rollback_run


def test_release_fence_is_statement_level_bounded_and_verified() -> None:
    install_sql = (ROOT / "deploy" / "account-deletion" / "install_release_fence.sql").read_text(
        encoding="utf-8"
    )
    remove_sql = (ROOT / "deploy" / "account-deletion" / "remove_release_fence.sql").read_text(
        encoding="utf-8"
    )
    verify_sql = (ROOT / "deploy" / "account-deletion" / "verify_release_boundary.sql").read_text(
        encoding="utf-8"
    )

    assert "LOCK TABLE public.actor_profiles, public.vault_keys" in install_sql
    assert "IN SHARE ROW EXCLUSIVE MODE" in install_sql
    assert install_sql.count("FOR EACH STATEMENT") == 2
    assert "ERRCODE = '55000'" in install_sql
    assert "DELETE FROM public.actor_profiles WHERE false" in install_sql
    assert "DELETE FROM public.vault_keys WHERE false" in install_sql
    assert remove_sql.index("DROP TRIGGER") < remove_sql.index("DROP FUNCTION")
    assert "trg_reject_deleted_account_insert" in verify_sql
    assert "trg_reject_deleted_account_reference_update" in verify_sql
    assert "hushh.account-deletion-guard/v3/insert-presence:" in verify_sql
    assert "hushh.account-deletion-guard/v3/update-bind-immutable:" in verify_sql
    assert "account_identity_presence_pkey" in verify_sql
    assert "missing_presence_count" in verify_sql


def test_uat_serving_state_ignores_zero_percent_candidate_tag() -> None:
    resolver = _serving_state_module()
    service = json.loads(
        (CLOUD_RUN_FIXTURES / "tagged_zero_before_serving.json").read_text(encoding="utf-8")
    )

    state = resolver.resolve_serving_state(service)

    assert state.revision == "consent-protocol-serving"
    assert state.url == "https://consent-protocol.example.run.app"


def test_uat_serving_state_rejects_ambiguous_split_traffic() -> None:
    resolver = _serving_state_module()
    service = json.loads(
        (CLOUD_RUN_FIXTURES / "ambiguous_split_traffic.json").read_text(encoding="utf-8")
    )

    with pytest.raises(ValueError, match="exactly one"):
        resolver.resolve_serving_state(service)


def test_uat_predeploy_and_final_state_use_order_safe_resolver() -> None:
    for name in ("Capture predeploy Cloud Run state", "Resolve final Cloud Run state"):
        run = str(_step(name).get("run") or "")
        assert "resolve-cloud-run-serving-state.py" in run
        assert "status.traffic[0]" not in run


def test_scheduler_attempt_requires_fresh_concrete_http_success() -> None:
    verifier = _scheduler_attempt_module()
    expected_job = "projects/hushh-pda-uat/locations/us-central1/jobs/account-deletion-cleanup-uat"
    expected_uri = "https://api.uat.hushh.ai/api/account/deletion-cleanup/drain?limit=10"
    triggered_at = verifier.parse_instant("2026-09-04T15:30:00Z")
    success = json.loads(
        (CLOUD_SCHEDULER_FIXTURES / "fresh_success.json").read_text(encoding="utf-8")
    )
    missing_status = json.loads(
        (CLOUD_SCHEDULER_FIXTURES / "fresh_missing_http_status.json").read_text(encoding="utf-8")
    )

    selected = verifier.successful_completion(
        success,
        triggered_at=triggered_at,
        expected_job=expected_job,
        expected_uri=expected_uri,
    )
    assert selected is not None
    assert selected["http_status"] == 200
    assert (
        verifier.successful_completion(
            missing_status,
            triggered_at=triggered_at,
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )
    assert (
        verifier.successful_completion(
            [missing_status[0], success[0]],
            triggered_at=triggered_at,
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )
    assert (
        verifier.successful_completion(
            success,
            triggered_at=verifier.parse_instant("2026-09-04T15:31:00Z"),
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )


PRODUCTION_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "deploy-production.yml"


def _production_workflow() -> dict:
    return yaml.safe_load(PRODUCTION_WORKFLOW_PATH.read_text(encoding="utf-8"))


def _production_steps() -> list[dict]:
    return _production_workflow()["jobs"]["deploy"]["steps"]


def _production_step(name: str) -> dict:
    for step in _production_steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"Missing production workflow step: {name}")


def _assert_no_uat_target(run: str) -> None:
    for uat_marker in (
        "hushh-pda-uat",
        "hushh-uat-pg",
        "api.uat.hushh.ai",
        "/tmp/uat-",  # noqa: S108 - workflow evidence path literal, not a temp file
        "--port 6543",
        "--release-environment uat",
        "account-deletion-cleanup-uat",
        '"uat"',
    ):
        assert uat_marker not in run, uat_marker


def test_production_no_longer_hard_blocks_migration_201() -> None:
    names = [str(step.get("name") or "") for step in _production_steps()]
    text = PRODUCTION_WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "Block production migration 201 until lifecycle rollout controls exist" not in names
    assert "Apply production release migrations" not in names
    assert "201_account_deletion_tombstones.sql" not in text


def test_production_release_orders_image_fence_schema_runtime_and_activation() -> None:
    names = [str(step.get("name") or "") for step in _production_steps()]
    expected_order = [
        # The proxy is installed early for read-only Drive database attestation.
        # Backup, image, fence and migration authority retain their order.
        "Install Cloud SQL Auth Proxy",
        "Pre-deploy Cloud SQL backup posture gate",
        "Build and pin backend image before lifecycle migration",
        "Install fail-closed account deletion release fence",
        "Apply production DB migrations behind account deletion fence",
        "Migration governance and DB drift gate",
        "Deploy backend using Cloud Build",
        "Resolve backend candidate revision",
        "Verify backend candidate readiness and exact-SHA provenance",
        "Resolve deployed candidate revisions",
        "Promote deployed revisions to production traffic",
        "Classify production release outcome",
        "Roll back backend revision",
        "Roll back frontend revision",
        "Activate tombstone-aware account deletion",
        "Resolve final Cloud Run state",
        "Write production release status artifact",
    ]
    positions = [names.index(name) for name in expected_order]
    assert positions == sorted(positions)

    for name, step_id in (
        ("Build and pin backend image before lifecycle migration", "build-backend-image"),
        ("Install fail-closed account deletion release fence", "install-account-deletion-fence"),
        ("Apply production DB migrations behind account deletion fence", "predeploy-db-gate"),
        ("Deploy backend using Cloud Build", "deploy-backend"),
        ("Resolve backend candidate revision", "backend-candidate-state"),
        ("Activate tombstone-aware account deletion", "activate-account-deletion"),
    ):
        step = _production_step(name)
        assert step.get("id") == step_id
    for name in (
        "Build and pin backend image before lifecycle migration",
        "Apply production DB migrations behind account deletion fence",
        "Resolve backend candidate revision",
        "Verify backend candidate readiness and exact-SHA provenance",
    ):
        expected = "steps.scope.outputs.deploy_backend == 'true'"
        if name != "Build and pin backend image before lifecycle migration":
            expected = "env.PHONE_DEPLOY_PHASE != 'cold' && (" + expected + ")"
        assert _production_step(name).get("if") == expected
    assert _production_step("Install fail-closed account deletion release fence").get("if") == (
        "env.PHONE_DEPLOY_PHASE != 'cold' && (steps.scope.outputs.deploy_backend == 'true' && "
        "steps.account-deletion-fence-decision.outputs.required == 'true')"
    )


def test_production_fence_and_migration_target_only_the_production_database() -> None:
    fence_run = str(_production_step("Install fail-closed account deletion release fence")["run"])
    migrate_run = str(
        _production_step("Apply production DB migrations behind account deletion fence")["run"]
    )

    for run in (fence_run, migrate_run):
        assert '"${GCP_PROJECT_ID}" != "hushh-pda"' in run
        assert '"${PROD_CLOUDSQL_INSTANCE}" != "hushh-pda:us-central1:hushh-vault-db"' in run
        assert "--port 6544" in run
        assert 'export PGDATABASE="${PROD_DB_NAME}"' in run
        assert "install_release_fence.sql" in run
        assert "HUSSH_RELEASE_ENVIRONMENT" not in run
        _assert_no_uat_target(run)
    assert "/tmp/prod-account-deletion-fence-install.log" in fence_run  # noqa: S108 - workflow evidence path literal, not a temp file
    assert "--release-environment production" in migrate_run
    assert "--migration-mode replay" in migrate_run
    assert migrate_run.index("install_release_fence.sql") < migrate_run.index("db/migrate.py")
    assert migrate_run.index("db/migrate.py") < migrate_run.index("verify_release_boundary.sql")
    assert "SELECT count(*) FROM public.account_deletion_tombstones" in migrate_run
    assert 'echo "tombstone_count=${tombstone_count}" >> "$GITHUB_OUTPUT"' in migrate_run


def test_production_backend_deploy_consumes_the_pinned_digest_without_rebuilding() -> None:
    build_run = str(
        _production_step("Build and pin backend image before lifecycle migration").get("run") or ""
    )
    deploy_run = str(_production_step("Deploy backend using Cloud Build").get("run") or "")
    readiness_run = str(
        _production_step("Verify backend candidate readiness and exact-SHA provenance").get("run")
        or ""
    )
    candidate_run = str(_production_step("Resolve deployed candidate revisions").get("run") or "")

    assert "deploy/backend-image.cloudbuild.yaml" in build_run
    assert 'image_tag="prod-${{ github.event.inputs.sha }}"' in build_run
    assert "image_summary.digest" in build_run
    assert "^sha256:[0-9a-f]{64}$" in build_run
    assert "resolve-cloud-run-image.py" in build_run
    assert "/tmp/prod-backend-image.json" in build_run  # noqa: S108 - workflow evidence path literal, not a temp file
    assert ",_SKIP_IMAGE_BUILD=true," in deploy_run
    assert (
        ",_IMAGE_REFERENCE=${{ steps.build-backend-image.outputs.image_reference }}," in deploy_run
    )
    assert ",_CLOUD_RUN_TAG=account-deletion-${{ github.run_id }}," in deploy_run
    assert ",_ACCOUNT_DELETION_CLEANUP_AUDIENCE=${{ env.CONSENT_API_PUBLIC_ORIGIN }}," in deploy_run
    assert 'containers[0].get("image") == expected_image_reference' in readiness_run
    assert 'labels.get("account-deletion-contract") == "v201"' in readiness_run
    assert 'labels.get("deploy-env") == "production"' in readiness_run
    assert 'labels.get("deploy-source") == "deploy-production"' in readiness_run
    _assert_no_uat_target(readiness_run)
    readiness_env = _production_step("Verify backend candidate readiness and exact-SHA provenance")[
        "env"
    ]
    assert readiness_env["EXPECTED_SHA"] == "${{ github.event.inputs.sha }}"
    assert readiness_env["EXPECTED_IMAGE_REFERENCE"] == (
        "${{ steps.build-backend-image.outputs.image_reference }}"
    )
    # Promotion targets the tagged, readiness-proven candidate, not "latest".
    assert "steps.backend-candidate-state.outputs.backend_revision" in candidate_run
    assert "latestCreatedRevisionName" not in candidate_run.split("deploy_frontend")[0]


def test_production_build_step_pins_executable_manifest(tmp_path: Path) -> None:
    child_digest = "sha256:" + "d" * 64
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": "sha256:" + "e" * 64,
                    "size": 1234,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child_digest,
                    "size": 1234,
                    "platform": {"os": "linux", "architecture": "amd64"},
                },
            ],
        }
    )
    index_digest = "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()
    repository = "gcr.io/hushh-pda/consent-protocol"
    script = _production_step("Build and pin backend image before lifecycle migration")["run"]
    script = script.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda")
    script = script.replace("${{ github.event.inputs.sha }}", "f" * 40)
    for name in ("prod-backend-image.json", "prod-backend-image-manifest.json"):
        script = script.replace(
            f"/tmp/{name}",  # noqa: S108 - replace workflow paths with pytest isolation
            (tmp_path / name).as_posix(),
        )
    assert "${{" not in script
    # Only the digest resolver runs for real; every registry/build call is stubbed.
    guards = (
        'gcloud() { case "$1 $2" in '
        "'builds submit'|'auth configure-docker') return 0 ;; "
        f"'container images') printf '%s' '{index_digest}' ;; "
        "*) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
        "docker() { "
        f"if [[ \"$*\" != *'{repository}@{index_digest}'* ]]; then "
        "echo UNEXPECTED_MUTABLE_LOOKUP >&2; return 96; fi; "
        f"printf '%s' '{manifest}'; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    )
    output_path = tmp_path / "github-output"
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment["GITHUB_OUTPUT"] = output_path.as_posix()
    # The default dispatch input: rebuild from source at the SHA (today's path).
    environment["BACKEND_IMAGE_SOURCE"] = "build-from-source"
    environment.pop("UAT_VERIFIED_IMAGE_REFERENCE", None)
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required for the workflow behavior test"
    result = subprocess.run(  # noqa: S603 - trusted workflow, fixed inputs, guarded cloud commands
        [bash, "-c", guards + script],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr
    assert output_path.read_text().splitlines() == [
        f"image_reference={repository}@{child_digest}",
        "image_source=build-from-source",
    ]


def test_production_backend_deploy_substitutions_are_declared_by_cloud_build() -> None:
    deploy_run = str(_production_step("Deploy backend using Cloud Build").get("run") or "")
    cloudbuild = yaml.safe_load(
        (ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
    )
    declared = set((cloudbuild.get("substitutions") or {}).keys())
    for name in (
        "_SKIP_IMAGE_BUILD",
        "_IMAGE_REFERENCE",
        "_CLOUD_RUN_TAG",
        "_ACCOUNT_DELETION_CLEANUP_AUDIENCE",
        "_ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL",
    ):
        assert f"{name}=" in deploy_run
        assert name in declared


def test_production_activation_uses_the_same_qualified_lifecycle_owner() -> None:
    activation = _production_step("Activate tombstone-aware account deletion")
    assert activation["if"] == (
        "env.PHONE_DEPLOY_PHASE != 'cold' && (steps.classify.outputs.release_failed == 'false' && "
        "steps.scope.outputs.deploy_backend == 'true')"
    )
    assert "python3 deploy/account-deletion/activate_release.py" in activation["run"]
    assert '--expected-sha "${{ github.event.inputs.sha }}"' in activation["run"]
    assert '--cloudsql-instance "${{ env.PROD_CLOUDSQL_INSTANCE }}"' in activation["run"]
    assert _production_workflow()["env"]["CONSENT_API_PUBLIC_ORIGIN"] == "https://api.hushh.ai"
    _assert_no_uat_target(activation["run"])


def test_production_scheduler_service_account_id_is_valid_and_consistent() -> None:
    workflow = _production_workflow()
    scheduler_account_id = workflow["env"]["ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID"]
    deploy_run = str(_production_step("Deploy backend using Cloud Build").get("run") or "")
    activation = _production_step("Activate tombstone-aware account deletion")

    assert scheduler_account_id == "account-deletion-cleanup"
    assert workflow["env"]["GCP_PROJECT_ID"] == "hushh-pda"
    assert (
        '--scheduler-service-account "${{ env.ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID }}"'
        in activation["run"]
    )
    assert (
        "_ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL="
        "${{ env.ACCOUNT_DELETION_SCHEDULER_SERVICE_ACCOUNT_ID }}@"
        "${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in deploy_run


def test_production_pre_v201_rollback_requires_fence_and_empty_tombstones() -> None:
    rollback = _production_step("Roll back backend revision")
    rollback_run = str(rollback.get("run") or "")

    assert "steps.phone-rollback-qualified.outputs.revision != ''" in str(rollback.get("if"))
    assert 'rollback_revision="${{ steps.phone-rollback-qualified.outputs.revision }}"' in (
        rollback_run
    )
    assert "Cannot authorize rollback from ambiguous backend traffic" in rollback_run
    assert '"${{ steps.predeploy-db-gate.outcome }}" != "success"' in rollback_run
    assert "install_release_fence.sql" in rollback_run
    assert "SELECT count(*) FROM public.account_deletion_tombstones" in rollback_run
    assert '"${rollback_contract}" != "v201"' in rollback_run
    assert '"${tombstone_count}" != "0"' in rollback_run
    assert "Refusing rollback to a pre-v201 backend" in rollback_run
    assert "--port 6544" in rollback_run
    assert "${{ env.PROD_CLOUDSQL_INSTANCE }}" in rollback_run
    assert rollback_run.index('"${tombstone_count}" != "0"') < rollback_run.index(
        "cloudrun-rollback.sh"
    )


def test_production_predeploy_and_final_state_use_order_safe_resolver() -> None:
    for name in ("Capture predeploy Cloud Run state", "Resolve final Cloud Run state"):
        run = str(_production_step(name).get("run") or "")
        assert "resolve-cloud-run-serving-state.py" in run
        assert "status.traffic[0]" not in run
    final_run = str(_production_step("Resolve final Cloud Run state").get("run") or "")
    assert 'echo "backend_serving=${backend_serving}" >> "$GITHUB_OUTPUT"' in final_run
    assert 'echo "frontend_serving=${frontend_serving}" >> "$GITHUB_OUTPUT"' in final_run


def test_production_status_blocks_until_account_deletion_is_activated() -> None:
    status_run = str(_production_step("Write production release status artifact").get("run"))
    upload = _production_step("Upload production deploy artifacts")
    upload_paths = str((upload.get("with") or {}).get("path") or "")

    assert '"${{ steps.activate-account-deletion.outcome }}" != "success"' in status_run
    assert '"account_deletion_activation"' in status_run
    assert '"account_deletion_activated"' in status_run
    for evidence in (
        "/tmp/prod-backend-image.json",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-backend-image-manifest.json",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-backend-candidate-readiness.json",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-account-deletion-fence-install.log",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-account-deletion-scheduler-evidence.json",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-account-deletion-revision-retirement.json",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/prod-account-deletion-fence-removal.log",  # noqa: S108 - workflow evidence path literal, not a temp file
        "/tmp/cloud-sql-proxy-prod.log",  # noqa: S108 - workflow evidence path literal, not a temp file
    ):
        assert evidence in upload_paths


def test_production_deploys_share_one_global_concurrency_group() -> None:
    concurrency = _production_workflow()["concurrency"]

    assert concurrency == {
        "group": "deploy-production",
        "cancel-in-progress": False,
        "queue": "max",
    }
