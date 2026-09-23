"""Prove cancellation restores the pre-worker scheduler target."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
OLD_URI = "https://api.uat.hushh.ai/api/internal/drive-work/drain"
OLD_AUDIENCE = "https://api.uat.hushh.ai"
WORKER_URL = "https://consent-protocol-drive-worker-abc.a.run.app"


@pytest.mark.parametrize("restore_succeeds", [True, False])
def test_term_after_scheduler_retarget_restores_or_reports_failure(
    tmp_path: Path, restore_succeeds: bool
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    state_path = tmp_path / "scheduler.json"
    state_path.write_text(json.dumps({"uri": OLD_URI, "audience": OLD_AUDIENCE}), encoding="utf-8")
    setup_count = tmp_path / "setup-count"
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = [arg for arg in sys.argv[1:] if arg != "--quiet"]
if args[:3] == ["run", "services", "list"]:
    print("[]")
elif args[:3] == ["scheduler", "jobs", "describe"]:
    state = json.loads(Path(os.environ["MOCK_SCHEDULER_STATE"]).read_text())
    if "--format=value(httpTarget.uri)" in args:
        print(state["uri"])
    elif "--format=value(httpTarget.oidcToken.audience)" in args:
        print(state["audience"])
    else:
        sys.exit(78)
elif args[:2] == ["run", "deploy"]:
    pass
elif args[:3] == ["run", "services", "describe"]:
    if "--format=value(status.latestCreatedRevisionName)" in args:
        print("consent-protocol-drive-worker-00001-abc")
    elif "--format=value(status.url)" in args:
        print(os.environ["MOCK_WORKER_URL"])
    else:
        sys.exit(79)
elif args[:3] == ["run", "revisions", "describe"]:
    print(json.dumps({
        "metadata": {"labels": {"deploy-sha": os.environ["DEPLOY_SHA"]}},
        "spec": {"containers": [
            {"name": "drive-worker", "image": os.environ["IMAGE_REFERENCE"]},
            {"name": "clamav", "image": os.environ["MOCK_CLAMAV_IMAGE"]},
        ]},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif args[:3] in (
    ["run", "services", "add-iam-policy-binding"],
    ["run", "services", "update-traffic"],
):
    pass
else:
    sys.exit(80)
""",
        encoding="utf-8",
    )
    fake_gcloud.chmod(0o755)
    fake_bash = fake_bin / "bash"
    fake_bash.write_text(
        """#!/usr/bin/env python3
import json
import os
import signal
import sys
from pathlib import Path

if sys.argv[1:] != ["deploy/drive/setup_work_drain_scheduler.sh"]:
    sys.exit(81)
count_path = Path(os.environ["MOCK_SETUP_COUNT"])
count = int(count_path.read_text()) if count_path.exists() else 0
count_path.write_text(str(count + 1))
if count == 1 and os.environ["MOCK_RESTORE_SUCCEEDS"] != "true":
    sys.exit(82)
Path(os.environ["MOCK_SCHEDULER_STATE"]).write_text(json.dumps({
    "uri": os.environ["BACKEND_URL"] + "/api/internal/drive-work/drain",
    "audience": os.environ["OIDC_AUDIENCE"],
}))
if count == 0:
    os.kill(os.getppid(), signal.SIGTERM)
""",
        encoding="utf-8",
    )
    fake_bash.chmod(0o755)

    clamav_image = next(
        line.split('"')[1]
        for line in WORKER_RELEASE.read_text(encoding="utf-8").splitlines()
        if line.startswith("readonly CLAMAV_IMAGE=")
    )
    environment = os.environ.copy()
    wrapper_log = tmp_path / "worker-release.log"
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "MOCK_SCHEDULER_STATE": str(state_path),
            "MOCK_SETUP_COUNT": str(setup_count),
            "MOCK_RESTORE_SUCCEEDS": str(restore_succeeds).lower(),
            "MOCK_WORKER_URL": WORKER_URL,
            "MOCK_CLAMAV_IMAGE": clamav_image,
            "MOCK_WRAPPER_LOG": str(wrapper_log),
            "MOCK_WORKER_RELEASE": str(WORKER_RELEASE),
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": (
                "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
            ),
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": "12345",
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        [
            "/bin/bash",
            "-c",
            'set -euo pipefail; exec > >(tee "$MOCK_WRAPPER_LOG") 2>&1; '
            'exec /bin/bash "$MOCK_WORKER_RELEASE"',
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=15,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 143, output
    assert setup_count.read_text(encoding="utf-8") == "2"
    assert "Drive worker candidate failed" in output
    assert "Drive worker candidate failed" in wrapper_log.read_text(encoding="utf-8")
    final_state = json.loads(state_path.read_text(encoding="utf-8"))
    if restore_succeeds:
        assert final_state == {"uri": OLD_URI, "audience": OLD_AUDIENCE}
        assert "CRITICAL" not in output
    else:
        assert final_state["uri"] == f"{WORKER_URL}/api/internal/drive-work/drain"
        assert "CRITICAL: Drive worker rollback is incomplete" in output
