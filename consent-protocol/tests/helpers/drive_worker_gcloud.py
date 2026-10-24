"""Synthetic CLI transport for worker release and cancellation contracts."""

import os
from pathlib import Path


def write_executables(directory: Path, sources: dict[str, str]) -> Path:
    """Keep synthetic CLI creation identical across release and resume probes."""
    directory.mkdir(exist_ok=True)
    for name, source in sources.items():
        executable = directory / name
        executable.write_text(source, encoding="utf-8")
        executable.chmod(0o755)
    return directory


def write_worker_gcloud_fixture(fake_bin: Path) -> None:
    import shlex
    import sys

    fake_bin.mkdir()
    fake_gcloud = fake_bin / "gcloud.py"
    fake_gcloud.write_text(
        """#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys

args = sys.argv[1:]
with open(os.environ["MOCK_GCLOUD_CALLS"], "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
command = [arg for arg in args if arg != "--quiet"]
state = os.environ["MOCK_WORKER_STATE"]
if command[:4] == ["run", "services", "describe", "consent-protocol"]:
    print(json.dumps({"status": {"traffic": [{"revisionName": "consent-protocol-01234-api", "percent": 100}]}}))
elif command[:4] == ["run", "revisions", "describe", "consent-protocol-01234-api"]:
    print(json.dumps({
        "metadata": {"name": "consent-protocol-01234-api"},
        "spec": {"serviceAccountName": os.environ["RUNTIME_SERVICE_ACCOUNT"], "containers": [{
            "image": os.environ["IMAGE_REFERENCE"],
            "env": [{"name": key, "value": value} for key, value in {
                "HUSHH_DEPLOY_SHA": os.environ["DEPLOY_SHA"],
                "HUSHH_DEPLOY_RUN_ID": os.environ["RELEASE_RUN_ID"],
                "HUSHH_DEPLOY_ENV": "uat", "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "azure_openai", "HUSHH_UAT_MANAGED_AI_PROVIDER": "azure_openai",
            }.items()],
        }]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif command[:3] == ["run", "services", "list"]:
    if state == "list_error":
        sys.exit(77)
    names = ["consent-protocol-drive-worker"] if state in ("existing", "ambiguous", "failed_first_create") else []
    print(json.dumps([{"metadata": {"name": name}} for name in names]))
elif command[:3] == ["run", "services", "describe"]:
    traffic = ([{"revisionName": "worker-previous-00001", "percent": 100}]
               if state == "existing" else
               [{"revisionName": "worker-previous-00001", "percent": 50},
                {"revisionName": "worker-previous-00002", "percent": 50}]
               if state == "ambiguous" else [])
    if "--format=value(status.url)" in command:
        print("https://consent-protocol-drive-worker-abc.a.run.app")
    else:
        print(json.dumps({"status": {"traffic": traffic, "url": "https://consent-protocol-drive-worker-abc.a.run.app"}}))
elif command[:3] == ["scheduler", "jobs", "list"]:
    print(os.environ["MOCK_SCHEDULER_JOB"])
elif command[:3] == ["scheduler", "jobs", "describe"]:
    if "--format=json" in command:
        print(json.dumps(json.loads(os.environ["MOCK_SCHEDULER_JOB"])[0]))
    else:
        sys.exit(78)
elif command[:2] == ["run", "deploy"]:
    if state == "cancel_during_deploy":
        subprocess.run([shutil.which("bash") or "bash", "-c", 'kill -TERM "$1"', "signal", os.environ["MOCK_WORKER_PARENT_PID"]], check=True)
        sys.exit(0)
    sys.exit(79)
else:
    sys.exit(80)
""",
        encoding="utf-8",
    )
    shell = fake_bin / "gcloud"
    shell.write_text(
        '#!/usr/bin/env bash\nexport MOCK_WORKER_PARENT_PID="$PPID"\n'
        f'exec {shlex.quote(sys.executable)} "$(dirname "$0")/gcloud.py" "$@"\n'
    )
    shell.chmod(0o755)
    if os.name == "nt":
        (fake_bin / "gcloud.cmd").write_text(
            f'@"{sys.executable}" "%~dp0gcloud.py" %*\n', encoding="utf-8", newline=""
        )
