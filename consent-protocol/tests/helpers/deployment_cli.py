"""Explicit synthetic checkout inputs for deployment capability contracts."""

import os
import shutil
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
