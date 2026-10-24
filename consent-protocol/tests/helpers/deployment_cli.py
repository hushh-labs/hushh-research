"""Explicit synthetic checkout inputs for deployment capability contracts."""

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


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
        "scripts/ci/runtime_capacity_inventory.py",
        "scripts/ci/account-deletion-fence-decision.py",
        "scripts/ci/managed_provider_readiness.py",
        "scripts/ci/managed_capability_proof.py",
        "scripts/ops/verify-env-secrets-parity.py",
        *(f"deploy/drive/{name}" for name in DRIVE_PRODUCTION_TOOLS),
        *(
            f"scripts/deploy/{name}"
            for name in (
                "backend-deploy.sh",
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
