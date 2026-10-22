"""Emit the Container Apps Job specs for the in-Azure model eval (JSON is valid YAML).

usage:
  python aca_specs.py build <out.json>   kaniko build of Dockerfile.pod, in the spike env
  python aca_specs.py eval  <out.json>   the harness runner (per-lane env set at start)

Everything is the person's own: the spike Container Apps environment (westus2), the spike
registry, the spike storage account and one user-assigned identity. No Container Apps
environment is created by these specs, and no secret appears in them.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SUB = "8edb2a2a-84bd-421c-b321-6c0a934d863d"
TENANT = "8703ed52-8300-4535-980a-6a82a6a6c2eb"
RG = "rg-hussh-spike"
LOCATION = "westus2"
ENV_ID = f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.App/managedEnvironments/hussh-spike-env"
IDENTITY_ID = (
    f"/subscriptions/{SUB}/resourcegroups/{RG}/providers/"
    "Microsoft.ManagedIdentity/userAssignedIdentities/hussh-eval-runner-id"
)
IDENTITY_CLIENT_ID = "4b8eb99c-fb65-4bfa-bda4-637c04c1c377"
REGISTRY = "husshspike6efde1a13a.azurecr.io"
RESULTS_ACCOUNT = "husshspike7eec428223"
RESULTS_CONTAINER = "eval-results"
AOAI_ENDPOINT = "https://hussh-aoai-eval-268e88.openai.azure.com/"

CODE_SHA = "cecc31de3b82434f8fe402efdbc24ce0815cf08e"
POD_IMAGE = f"{REGISTRY}/hussh-pod-eval:{CODE_SHA[:9]}"

BOOTSTRAP = (Path(__file__).parent / "aca_bootstrap.py").read_text()


def _env(**values: str) -> list[dict[str, str]]:
    return [{"name": key, "value": str(value)} for key, value in values.items()]


def _job(template: dict, *, timeout: int) -> dict:
    return {
        "location": LOCATION,
        "identity": {"type": "UserAssigned", "userAssignedIdentities": {IDENTITY_ID: {}}},
        "tags": {"purpose": "model-eval-20261003", "owner": "founder-spike"},
        "properties": {
            "environmentId": ENV_ID,
            "configuration": {
                "triggerType": "Manual",
                "replicaTimeout": timeout,
                "replicaRetryLimit": 0,
                "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1},
                "registries": [{"server": REGISTRY, "identity": IDENTITY_ID}],
            },
            "template": template,
        },
    }


def build_spec() -> dict:
    blob_env = _env(
        AZURE_CLIENT_ID=IDENTITY_CLIENT_ID,
        EVAL_RESULTS_ACCOUNT=RESULTS_ACCOUNT,
        EVAL_RESULTS_CONTAINER=RESULTS_CONTAINER,
    )
    prefix = f"build/{CODE_SHA[:9]}"
    kaniko = " ".join(
        [
            "/kaniko/executor",
            "--context=dir:///workspace/ctx",
            "--dockerfile=Dockerfile.pod",
            f"--destination={POD_IMAGE}",
            f"--build-arg=POD_IMAGE_TAG={CODE_SHA[:9]}",
            f"--registry-mirror={REGISTRY}",
            "--snapshot-mode=redo",
            "--use-new-run",
            "--compressed-caching=false",
            "--push-retry=3",
            "--verbosity=info",
            "--log-timestamp",
        ]
    )
    shell = (
        f"{kaniko} > /workspace/out/kaniko.log 2>&1; e=$?; "
        "df -h / /workspace >> /workspace/out/kaniko.log 2>&1; "
        'echo "KANIKO_EXIT=$e" >> /workspace/out/kaniko.log; sleep 45; exit $e'
    )
    mounts = [
        {"volumeName": "ws", "mountPath": "/workspace"},
        {"volumeName": "dockercfg", "mountPath": "/kaniko/.docker"},
    ]
    python_image = f"{REGISTRY}/library/python:3.13-slim"
    template = {
        "initContainers": [
            {
                "name": "fetch",
                "image": python_image,
                "command": ["python", "-c", BOOTSTRAP, "fetch-context"],
                "env": blob_env
                + _env(
                    AZURE_TENANT_ID=TENANT,
                    REGISTRY=REGISTRY,
                    BUILD_CONTEXT_BLOB=f"{prefix}/context.tar.gz",
                    BUILD_CONTEXT_SHA256=sys.argv[3] if len(sys.argv) > 3 else "",
                    BUILD_LOG_PREFIX=prefix,
                ),
                "resources": {"cpu": 0.5, "memory": "1Gi"},
                "volumeMounts": mounts,
            }
        ],
        "containers": [
            {
                "name": "kaniko",
                "image": f"{REGISTRY}/tools/kaniko-executor:v1.24.0-debug",
                "command": ["/busybox/sh", "-c", shell],
                "resources": {"cpu": 3.5, "memory": "7Gi"},
                "volumeMounts": mounts,
            },
            {
                "name": "logs",
                "image": python_image,
                "command": ["python", "-c", BOOTSTRAP, "upload-log"],
                "env": blob_env
                + _env(
                    LOG_PATH="/workspace/out/kaniko.log",
                    LOG_BLOB=f"{prefix}/kaniko.log",
                    LOG_EXIT_MARKER="KANIKO_EXIT=",
                ),
                "resources": {"cpu": 0.5, "memory": "1Gi"},
                "volumeMounts": [{"volumeName": "ws", "mountPath": "/workspace"}],
            },
        ],
        "volumes": [
            {"name": "ws", "storageType": "EmptyDir"},
            {"name": "dockercfg", "storageType": "EmptyDir"},
        ],
    }
    return _job(template, timeout=5400)


def eval_env(*, plan: dict, prefix: str, drivers_blob: str, drivers_sha256: str) -> dict:
    """The per-lane environment; set on the job right before each start."""
    return {
        "AZURE_CLIENT_ID": IDENTITY_CLIENT_ID,
        "AZURE_OPENAI_ENDPOINT": AOAI_ENDPOINT,
        "EVAL_RESULTS_ACCOUNT": RESULTS_ACCOUNT,
        "EVAL_RESULTS_CONTAINER": RESULTS_CONTAINER,
        "EVAL_RESULTS_PREFIX": prefix,
        "EVAL_DRIVERS_BLOB": drivers_blob,
        "EVAL_DRIVERS_SHA256": drivers_sha256,
        "EVAL_PLAN": json.dumps(plan, separators=(",", ":")),
        "EVAL_REPO_ROOT": "/app",
        "EVAL_OUT_ROOT": "/tmp/eval-out",
        "EVAL_CODE_SHA": CODE_SHA,
        "HOME": "/tmp",
        "PYTHONUNBUFFERED": "1",
    }


def eval_spec() -> dict:
    template = {
        "containers": [
            {
                "name": "harness",
                "image": POD_IMAGE,
                "command": ["python", "-c", BOOTSTRAP, "run-lane"],
                "env": _env(
                    AZURE_CLIENT_ID=IDENTITY_CLIENT_ID,
                    AZURE_OPENAI_ENDPOINT=AOAI_ENDPOINT,
                    EVAL_RESULTS_ACCOUNT=RESULTS_ACCOUNT,
                    EVAL_RESULTS_CONTAINER=RESULTS_CONTAINER,
                    HOME="/tmp",
                ),
                "resources": {"cpu": 2.0, "memory": "4Gi"},
            }
        ],
    }
    return _job(template, timeout=10800)


if __name__ == "__main__":
    kind, out = sys.argv[1], Path(sys.argv[2])
    spec = build_spec() if kind == "build" else eval_spec()
    out.write_text(json.dumps(spec, indent=1))
    print(out)
