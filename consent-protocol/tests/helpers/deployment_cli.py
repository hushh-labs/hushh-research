"""Explicit synthetic checkout inputs for deployment capability contracts."""

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path


def cloudrun_revision(*, name: str, service: str, sha: str, intake: str | None = None) -> dict:
    """Synthetic immutable revision with explicit service and optional intake policy."""
    revision = {
        "metadata": {
            "name": name,
            "labels": {"serving.knative.dev/service": service, "deploy-sha": sha},
        },
        "spec": {"containers": [{"image": "image@sha256:" + "a" * 64}]},
    }
    if intake is not None:
        revision["spec"]["containers"][0]["env"] = [
            {"name": "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "value": intake}
        ]
    return revision


def copy_candidate_tools(root, destination_root):
    if os.name == "nt":
        # Native Python searches System32 before PATH; pin Git Bash in this fixture.
        (destination_root / "bash.exe").symlink_to(Path(shutil.which("bash")).resolve())
    for relative in (
        "scripts/ci/verify-dev-candidate.sh",
        "scripts/ci/cloudrun-retention.sh",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "scripts/ops/verify-env-secrets-parity.py",
        "deploy/backend.cloudbuild.yaml",
    ):
        destination = destination_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)
    for name in ("cloudrun-retention.py", "process_group.py"):
        shutil.copy2(root / "scripts/ci" / name, destination_root / "scripts/ci" / name)


def dev_migration_environment(directory: Path) -> dict[str, str]:
    """Only fixed synthetic qualification, fence and migration subprocesses."""
    (directory / "consent-protocol").mkdir()
    commands = {
        "python-gate": 'printf "%s:%s:%s\\n" "$*" "$DB_USER" "$DB_PASSWORD" >> "$CALLS"',
        "gcloud": 'case "$*" in *MIGRATOR_DB_USER*) echo scope_commerce_sandbox_migrator;; '
        "*MIGRATOR_DB_PASSWORD*) echo synthetic-migration-password;; *) exit 1;; esac",
        "python3": '[ "$*" = "deploy/account-deletion/activate_release.py --qualify-source '
        + "a" * 40
        + '" ] || exit 91\necho qualified >> "$RELEASE_CALLS"\nexit "${QUALIFY_EXIT:-0}"',
        "psql": '[ "$*" = "--no-psqlrc --set=ON_ERROR_STOP=1 --file '
        'deploy/account-deletion/install_release_fence.sql" ] || exit 92\n'
        '[ "$PGHOST:$PGPORT:$PGDATABASE:$PGUSER:$PGPASSWORD" = '
        '"127.0.0.1:6543:postgres:scope_commerce_sandbox:synthetic-runtime-password" ] || exit 93\n'
        'echo fence >> "$RELEASE_CALLS"\nexit "${FENCE_EXIT:-0}"',
    }
    for name, body in commands.items():
        script = directory / name
        script.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
        script.chmod(0o755)
    return {
        **os.environ,
        "PATH": str(directory) + ":" + os.environ["PATH"],
        "DEPLOY_SECRET_PREFIX": "SCOPE_COMMERCE_SANDBOX_",
        "DB_USER": "scope_commerce_sandbox",
        "DB_PASSWORD": "synthetic-runtime-password",
        "DEV_DB_NAME": "postgres",
        "CALLS": str(directory / "calls"),
        "RELEASE_CALLS": str(directory / "release-calls"),
    }


def run_candidate_gate(
    root, env, *, project="project", region="region", service="service", tag="dev-candidate-99"
):
    return subprocess.run(  # noqa: S603 - real repository gate with synthetic command adapters.
        [
            "bash",
            str(root / "scripts/ci/verify-dev-candidate.sh"),
            project,
            region,
            service,
            "revision",
            "registry/image@sha256:" + "a" * 64,
            "a" * 40,
            "99",
            tag,
            "/health",
        ],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
    )


def candidate_clock_environment(directory, code, ready_at, response_seconds):
    """Model elapsed curl/sleep time without waiting through a real cold start."""
    clock = directory / "clock"
    clock.write_text("0")
    clock_command = r"""
now=$(cat "$CLOCK")
case "${0##*/}" in
  date) printf '%s\n' "$now"; exit 0;;
  sleep) printf '%s\n' "$((now + $1))" > "$CLOCK"; exit 0;;
esac
echo "$*" >> "$COMMANDS"
while [ "$1" != --max-time ]; do shift; done
limit=$2
delay=$HTTP_RESPONSE_SECONDS
if [ "$now" -lt "$HTTP_READY_AT" ]; then delay=$((HTTP_READY_AT - now)); fi
code=$HTTP_CODE
if [ "$code" = 000 ] || [ "$delay" -gt "$limit" ]; then
  delay=$limit
  code=000
fi
printf '%s\n' "$((now + delay))" > "$CLOCK"
printf '%s' "$code"
[ "$code" != 000 ] || exit 28
"""
    for name, body in {
        **dict.fromkeys(("date", "sleep", "curl"), clock_command),
        "gcloud": 'echo "$*" >> "$COMMANDS"\n',
        "python-gate": 'if [ "$1" = "-c" ]; then echo https://candidate.run.app; fi\n',
    }.items():
        path = directory / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    return {
        **os.environ,
        "PATH": str(directory) + ":" + os.environ["PATH"],
        "PROTOCOL_PYTHON": str(directory / "python-gate"),
        "HTTP_CODE": code,
        "HTTP_READY_AT": str(ready_at),
        "HTTP_RESPONSE_SECONDS": str(response_seconds),
        "CLOCK": str(clock),
        "COMMANDS": str(directory / "commands"),
    }


DRIVE_PRODUCTION_TOOLS = (
    "resolve_prod_release_mode.py",
    "resolve_protected_document_release.py",
    "verify_prod_prerequisites.py",
    "verify_hashcoin_config.sh",
    "setup_native_callback_log_exclusion.sh",
    "deploy_worker_service_prod.sh",
    "setup_work_drain_scheduler_prod.sh",
    "work_drain_scheduler_snapshot_prod.py",
    "restore_prod_after_release_failure.sh",
)


def production_release_tools(root: Path, old_paths: tuple[str, ...]) -> list[str]:
    """Pinned current tools must survive checkout of a historical application."""
    return [
        *old_paths,
        "scripts/ci/verify-predecessor-acceptance.py",
        "scripts/ci/release_acceptance_provenance.py",
        "scripts/ci/resolve-deploy-scope.py",
        "scripts/ops/runtime_config_retention.py",
        "scripts/ops/scope_commerce_runtime_policy.py",
        "scripts/ops/shared_files_runtime_policy.py",
        "scripts/ops/passkey_domain_policy.py",
        "scripts/ops/upsert_gcp_secret.py",
        *(f"deploy/{name}/bind_secrets.sh" for name in ("email-auth", "plg")),
        "scripts/ci/verify-prod-places-readiness.py",
        "scripts/ci/cloudrun-retention.py",
        "scripts/ci/process_group.py",
        "scripts/ci/cloudrun-rollback.sh",
        "scripts/ci/runtime_capacity_inventory.py",
        "scripts/ci/runtime_capacity_cli.py",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "scripts/ci/account-deletion-fence-decision.py",
        "scripts/ci/verify-cloud-scheduler-attempt.py",
        "scripts/ci/cloudrun-rollback.sh",
        "deploy/drive/rollback_after_worker_failure.sh",
        "deploy/drive/rebind_protected_document_backend.py",
        *(
            f"deploy/account-deletion/{name}"
            for name in (
                "install_release_fence.sql",
                "remove_release_fence.sql",
                "activate_release.py",
                "release_target.py",
                "setup_cleanup_scheduler.sh",
                "verify_release_boundary.sql",
            )
        ),
        "scripts/ci/managed_provider_readiness.py",
        "scripts/ci/managed_capability_proof.py",
        "scripts/ops/verify-env-secrets-parity.py",
        *(path.relative_to(root).as_posix() for path in (root / "deploy/phone").glob("*.py")),
        *(f"deploy/drive/{name}" for name in DRIVE_PRODUCTION_TOOLS),
        *(
            f"scripts/deploy/{name}"
            for name in (
                "backend-deploy.sh",
                "backend-phone-rollback.sh",
                "verify-managed-vertex-runtime.sh",
                *(path.name for path in (root / "scripts/deploy").glob("backend-*-settings.sh")),
                "commerce-preview-bindings.sh",
                "scope-commerce-secrets.sh",
                "pod-release-env.sh",
                "preserve-pod-release.py",
            )
        ),
    ]


def executable_manifest() -> tuple[str, str]:
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "1" * 64,
                "size": 100,
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": "sha256:" + "2" * 64,
                    "size": 200,
                }
            ],
        }
    )
    return manifest, "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()


def frontend_deploy_script(steps: list[dict], project: str, tmp_path: Path) -> tuple[str, Path]:
    """Render the authored serial deploy with a synthetic Cloud Build transport."""
    run = next(step["run"] for step in steps if step.get("id") == "deploy-frontend")
    preparation = next(
        (step for step in steps if step.get("id") == "prepare-frontend-rollout"), None
    )
    if preparation:
        prepare = preparation["run"]
        # Synthetic scope expressions below leave admission unselected. Exercise
        # the full settings preparation without coupling this helper to prose.
        # Combined-build admission has its own behavioral/DAG tests.
        run = (
            prepare + '\nexport FRONTEND_DEPLOY_SUBSTITUTIONS="$SUBSTITUTIONS"; '
            "export FRONTEND_PARALLEL=false;\n" + run
        )
    run = run.replace("${{ env.GCP_PROJECT_ID }}", project)
    run = re.sub(r"\$\{\{[^}]*\}\}", "fixture", run)
    assert "${{" not in run
    capture = tmp_path / "gcloud.txt"
    guards = (
        f"export GITHUB_OUTPUT='{tmp_path / 'github-output'}';\n"
        "gcloud() { "
        f'if [ "$1 $2" = "builds submit" ]; then printf "%s\\n" "$@" > "{capture}"; return 0; fi; '
        "echo UNEXPECTED_CLOUD_COMMAND >&2; return 95; };\n"
    )
    return guards + run, capture


def frontend_release():
    return {
        "_FRONTEND_RUNTIME_SERVICE_ACCOUNT": "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "_APP_ENV": "uat",
        "_DEPLOY_ENV": "uat",
        "_DEPLOY_SOURCE": "deploy-uat",
        "_DEPLOY_SHA": "a" * 40,
        "_GITHUB_RUN_ID": "42",
        "_GITHUB_RUN_ATTEMPT": "1",
        "_SKIP_IMAGE_BUILD": "true",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/hushh-webapp@sha256:" + "b" * 64,
        "_CLOUD_RUN_MEMORY": "1Gi",
        "_CLOUD_RUN_MIN_INSTANCES": "2",
        "_CLOUD_RUN_MAX_INSTANCES": "10",
        "_CLOUD_RUN_CONCURRENCY": "10",
        "_CLOUD_RUN_TIMEOUT_SECONDS": "300",
        "_REGION": "us-central1",
    }


def uat_build_module():
    spec = importlib.util.spec_from_file_location(
        "uat_build_config",
        Path(__file__).resolve().parents[3] / "scripts/ci/uat_backend_build_config.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe_worker_payment_bindings(
    block,
    mocked,
    *,
    enabled: bool,
    missing: str = "",
    previous_bound: bool = False,
    hosted: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed repo shell block with a mocked gcloud
        [
            "bash",
            "-c",
            mocked
            + 'hosted_maintenance="${HOSTED_MAINTENANCE:-false}"\n'
            + block
            + '\nprintf "%s" "$payment_secret_bindings"\n',
        ],
        env={
            **os.environ,
            "DRIVE_REQUEST_PAYMENTS_PROD_ENABLED": "true" if enabled else "false",
            "MISSING_SECRET": missing,
            "PREVIOUS_REVISION": "consent-protocol-drive-worker-prev" if previous_bound else "",
            "PREVIOUS_STRIPE_BOUND": "true" if previous_bound else "false",
            "HOSTED_MAINTENANCE": "true" if hosted else "false",
        },
        capture_output=True,
        text=True,
        check=False,
    )


def assert_backend_source_rollback(
    root: Path, directory: Path, *, service: str, contract: str, sha_valid: bool, allowed: bool
) -> None:
    commands = directory / "commands"
    sha = "a" * 40 if sha_valid else "unverified"
    (directory / "gcloud").write_text(
        "#!/usr/bin/env python3\nimport os,sys\n"
        "a=sys.argv[1:]\n"
        "with open(os.environ['CALLS'],'a') as f: f.write(' '.join(a)+'\\n')\n"
        "if a[:3]==['run','revisions','describe']: print(os.environ['SOURCE_SHA'])\n"
        "elif a[:3]!=['run','services','update-traffic']: raise SystemExit(99)\n"
    )
    (directory / "git").write_text(
        "#!/usr/bin/env python3\nimport json,os,sys\n"
        "assert sys.argv[1]=='show'\n"
        "if os.environ['SOURCE_CONTRACT']=='unknown': raise SystemExit(1)\n"
        "print(json.dumps({'version':1} if sys.argv[2].endswith('account-deletion-authority.json') "
        "else {'ordered_migrations':['423_account_shared_provider_authority.sql'] + "
        "(['425_account_phone_transfers.sql'] if os.environ['SOURCE_CONTRACT'] in ('phone','legacy_phone') else []) + "
        "(['428_phone_recovery_actions.sql'] if os.environ['SOURCE_CONTRACT']=='phone' else [])}))\n"
    )
    for binary in ("gcloud", "git"):
        (directory / binary).chmod(0o700)
    environment = {
        **os.environ,
        "PATH": str(directory) + os.pathsep + os.environ["PATH"],
        "CALLS": str(commands),
        "SOURCE_SHA": sha,
        "SOURCE_CONTRACT": contract,
        "GCP_PROJECT_ID": "synthetic-project",
    }
    environment.pop("BASH_ENV", None)
    if service == "consent-protocol":
        bootstrap = subprocess.run(  # noqa: S603 -- Exact source qualifier with synthetic git port.
            [
                sys.executable,
                str(root / "deploy/account-deletion/activate_release.py"),
                "--qualify-source",
                sha,
            ],
            cwd=root,
            env=environment,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert (bootstrap.returncode == 0) is (contract != "unknown" and sha_valid)
    result = subprocess.run(  # noqa: S603 - authored script and synthetic cloud/git ports
        ["bash", str(root / "scripts/ci/cloudrun-rollback.sh"), service, "us-central1", "prior"],
        cwd=root,
        env=environment,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert (result.returncode == 0) is allowed, result.stderr
    calls = commands.read_text().splitlines()
    assert any("update-traffic" in call for call in calls) is allowed
    if service == "consent-protocol":
        assert calls[0].startswith("run revisions describe prior ")
        assert "--project=synthetic-project" in calls[0]


def backend_rollback_authority_fixture(
    root: Path, directory: Path, denied: str | None
) -> tuple[Path, Callable[[Path], subprocess.CompletedProcess[str]]]:
    tools = directory / "bin"
    tools.mkdir()
    calls = directory / "calls"
    sha = "a" * 40
    programs = {
        "python3": (
            '#!/bin/sh\ncase "$1" in\n'
            " */resolve_protected_document_release.py) guard=reader;;\n"
            " */activate_release.py) guard=provider; "
            '[ "$2" = --qualify-rollback-source ] && [ "$3" = "$SOURCE_SHA" ] || exit 98;;\n'
            " *) exit 99;;\nesac\n"
            'printf "%s\\n" "$guard" >> "$CALLS"\n'
            '[ "$guard" != "$DENIED" ] || exit 47\n'
        ),
        "gcloud": (
            '#!/bin/sh\ncase "$1:$2:$3" in\n'
            ' run:revisions:describe) printf "%s\\n" "$SOURCE_SHA";;\n'
            ' run:services:update-traffic) printf "traffic\\n" >> "$CALLS";;\n'
            " *) exit 99;;\nesac\n"
        ),
    }
    for name, program in programs.items():
        path = tools / name
        path.write_text(program)
        path.chmod(0o700)
    environment = {
        **os.environ,
        "PATH": str(tools) + os.pathsep + os.environ["PATH"],
        "PROTOCOL_PYTHON": str(tools / "python3"),
        "GCP_PROJECT_ID": "hushh-pda",
        "HUSHH_DOCUMENT_READER_ENVIRONMENT": "production",
        "HUSHH_DOCUMENT_READER_GUARD_REPORT": "synthetic-reader-report",
        "HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD": "false",
        "CALLS": str(calls),
        "SOURCE_SHA": sha,
        "DENIED": denied or "",
    }
    environment.pop("BASH_ENV", None)

    def execute(script):
        return subprocess.run(  # noqa: S603 -- Real shell and fixed synthetic authority ports; no provider calls.
            ["bash", str(script), "consent-protocol", "us-central1", "consent-protocol-prior"],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
        )

    return calls, execute


def manifest_index() -> tuple[str, str, str]:
    child = "sha256:" + "c" * 64
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": "sha256:" + "b" * 64,
                    "size": 10,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child,
                    "size": 10,
                    "platform": {"os": "linux", "architecture": "amd64"},
                },
            ],
        }
    )
    return manifest, "sha256:" + hashlib.sha256(manifest.encode()).hexdigest(), child


def document_installer_environment(directory: Path) -> dict[str, str]:
    """Synthetic executable providers for the bounded document browser gate."""
    (directory / "hushh-webapp").mkdir()
    commands = directory / "commands"
    for script, body in {
        directory / "consent-protocol/.venv/bin/python": "exit 0\n",
        commands / "npx": 'echo "$*" >> "$FIXTURE_ROOT/calls"\n'
        '! grep -q azure.archive "$FIXTURE_ROOT/apt-mirrors.txt"\n',
        commands / "timeout": '[ "$1 $2 $3" = "--signal=TERM --kill-after=30s 8m" ] || exit 97\n'
        'shift 3\nexec "$@"\n',
    }.items():
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("#!/bin/sh\n" + body)
        script.chmod(0o755)
    return {
        **os.environ,
        "PATH": str(commands) + os.pathsep + os.environ["PATH"],
        "FIXTURE_ROOT": str(directory),
    }
