"""Fail-closed Cloud Run readiness and immutable image attestation for Drive work."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import os
import sys
from pathlib import Path
from typing import Any

_REVISION_MAX_SCALE = "autoscaling.knative.dev/maxScale"
_REVISION_MIN_SCALE = "autoscaling.knative.dev/minScale"


def _digest(image: Any) -> str | None:
    if not isinstance(image, str) or image.count("@") != 1:
        return None
    digest = image.rsplit("@", 1)[1]
    if not digest.startswith("sha256:") or len(digest) != 71:
        return None
    return digest


def _verify_scaling(
    revision: dict[str, Any], *, max_instances: str | None, concurrency: str | None
) -> None:
    """Hold the candidate to the per-revision shape the connection budget counts.

    The budget reserves maxScale x workers x pool for every retained revision.
    Warm capacity comes from the service-level minimum, which follows traffic;
    a revision-level minimum would keep every tagged rollback revision warm.
    Concurrency is pinned because the worker's memory-heavy child limits are
    per request, not per process.
    """
    annotations = (revision.get("metadata") or {}).get("annotations") or {}
    observed = (revision.get("spec") or {}).get("containerConcurrency")
    if (
        max_instances is None
        or concurrency is None
        or annotations.get(_REVISION_MAX_SCALE) != max_instances
        or annotations.get(_REVISION_MIN_SCALE, "0") != "0"
        or type(observed) is not int
        or str(observed) != concurrency
    ):
        raise ValueError("Drive worker revision scaling mismatch")


def verify_revision(
    revision: dict[str, Any],
    *,
    deploy_sha: str,
    app_image: str,
    scanner_index_digest: str,
    scanner_amd64_digest: str,
    drain_enabled: str | None = None,
    semantic_model_provider: str | None = None,
    managed_text_provider: str | None = None,
    max_instances: str | None = None,
    concurrency: str | None = None,
) -> None:
    """Accept only the reviewed app and either pinned ClamAV manifest form.

    Cloud Run's mirror resolves the pinned multi-architecture OCI index to its
    Linux/AMD64 child manifest. Both digests must be pinned independently;
    merely accepting any resolved scanner image would lose provenance.
    """
    labels = (revision.get("metadata") or {}).get("labels") or {}
    if labels.get("deploy-sha") != deploy_sha:
        raise ValueError("Drive worker deploy SHA mismatch")

    conditions = (revision.get("status") or {}).get("conditions") or []
    if not any(
        item.get("type") == "Ready" and item.get("status") == "True"
        for item in conditions
    ):
        raise ValueError("Drive worker revision is not Ready")

    containers = (revision.get("spec") or {}).get("containers") or []
    if len(containers) != 2 or {item.get("name") for item in containers} != {
        "drive-worker",
        "clamav",
    }:
        raise ValueError("Drive worker container set mismatch")
    images = {item["name"]: item.get("image") for item in containers}
    if managed_text_provider is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        selected = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "HUSHH_UAT_MANAGED_TEXT_PROVIDER"
        ]
        if managed_text_provider not in {"azure_openai", "vertex"} or selected != [
            managed_text_provider
        ]:
            raise ValueError("Drive worker managed text provider mismatch")
        full = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "HUSHH_UAT_MANAGED_AI_PROVIDER"
        ]
        if full != [managed_text_provider]:
            raise ValueError("Drive worker managed capability provider mismatch")
    if semantic_model_provider is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        providers = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER"
        ]
        if semantic_model_provider not in {"gemini", "azure_openai"} or providers != [
            semantic_model_provider
        ]:
            raise ValueError("Drive worker semantic model provider mismatch")
    if drain_enabled is not None:
        worker = next(item for item in containers if item["name"] == "drive-worker")
        flags = [
            item.get("value")
            for item in worker.get("env", [])
            if item.get("name") == "DRIVE_WORK_DRAIN_ENABLED"
        ]
        if drain_enabled not in {"true", "false"} or flags != [drain_enabled]:
            raise ValueError("Drive worker background processing state mismatch")
    if images["drive-worker"] != app_image:
        raise ValueError("Drive worker app image mismatch")
    if _digest(images["clamav"]) not in {
        scanner_index_digest,
        scanner_amd64_digest,
    }:
        raise ValueError("Drive worker scanner image digest mismatch")
    if max_instances is not None or concurrency is not None:
        _verify_scaling(revision, max_instances=max_instances, concurrency=concurrency)


RUNTIME = "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
SCANNER_INDEX = (
    "sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"
)
SCANNER_AMD64 = (
    "sha256:e8388295191bff0893fb889d9415ae975491201c989b205e30c9057b1985d36a"
)
SERVICE = "consent-protocol-drive-worker"


def same_worker_spec(desired: dict, observed: dict) -> bool:
    """Compare exact settings after resolving only the reviewed scanner image pair."""
    normalized = []
    for spec in (desired, observed):
        value = copy.deepcopy(spec)
        scanners = [
            item for item in value.get("containers", []) if item.get("name") == "clamav"
        ]
        allowed = {
            f"{repository}@{digest}"
            for repository in ("clamav/clamav", "mirror.gcr.io/clamav/clamav")
            for digest in (SCANNER_INDEX, SCANNER_AMD64)
        }
        if len(scanners) != 1 or scanners[0].get("image") not in allowed:
            return False
        scanners[0]["image"] = f"clamav/clamav@{SCANNER_AMD64}"
        normalized.append(value)
    return normalized[0] == normalized[1]


def scheduler_command(action: str, path: Path, origin: str) -> list[str]:
    if action not in {"capture", "verify"}:
        raise ValueError("worker_scheduler_action_invalid")
    return [
        "python3",
        str(Path(__file__).with_name("work_drain_scheduler_snapshot_prod.py")),
        action,
        "--snapshot",
        str(path),
        "--worker-origin",
        origin,
    ]


def _stage_fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def service_controls(value: dict) -> str:
    ignored = {
        "run.googleapis.com/operation-id",
        "run.googleapis.com/client-name",
        "run.googleapis.com/client-version",
        "serving.knative.dev/creator",
        "serving.knative.dev/lastModifier",
    }
    metadata = value.get("metadata") or {}
    return _stage_fingerprint(
        {
            "spec": {
                k: v
                for k, v in value["spec"].items()
                if k not in {"template", "traffic"}
            },
            "labels": metadata.get("labels", {}),
            "annotations": {
                k: v
                for k, v in metadata.get("annotations", {}).items()
                if k not in ignored
            },
        }
    )


def _verify_staged_launcher(value: dict, worker: dict) -> None:
    annotations = value.get("metadata", {}).get("annotations", {})
    if (
        value["spec"].get("timeoutSeconds") != 240
        or annotations.get("run.googleapis.com/cloudsql-instances")
        != "hushh-pda:us-central1:hushh-vault-db"
    ):
        raise ValueError("worker_database_or_timeout_contract_mismatch")
    if (
        worker.get("command") != ["gunicorn"]
        or worker.get("args")
        != [
            "server_drive_worker:app",
            "-w",
            "1",
            "-k",
            "uvicorn.workers.UvicornWorker",
            "--timeout",
            "220",
            "--worker-tmp-dir",
            "/tmp",
            "-b",
            "0.0.0.0:8080",
        ]
        or worker.get("startupProbe", {}).get("httpGet")
        != {"path": "/ready", "port": 8080}
    ):
        raise ValueError("worker_readiness_launcher_mismatch")
    for container in value["spec"]["containers"]:
        limits = container.get("resources", {}).get("limits", {})
        if limits.get("cpu") not in {"2", "2000m"} or limits.get("memory") not in {
            "4Gi",
            "4096Mi",
        }:
            raise ValueError("worker_resource_contract_mismatch")


def verify_staged_revision(
    value: dict, expected: dict, version: str | None = None
) -> None:
    verify_revision(
        value,
        deploy_sha=expected["source"],
        app_image=expected["image"],
        scanner_index_digest=SCANNER_INDEX,
        scanner_amd64_digest=SCANNER_AMD64,
        drain_enabled="true",
        max_instances="2",
        concurrency="1",
    )
    spec = value["spec"]
    worker = next(item for item in spec["containers"] if item["name"] == "drive-worker")
    env = worker.get("env", [])
    names = [item.get("name") for item in env]
    values = {item["name"]: item.get("value") for item in env}
    refs = {item["name"]: item.get("valueFrom", {}).get("secretKeyRef") for item in env}
    if len(set(names)) != len(names) or spec.get("serviceAccountName") != RUNTIME:
        raise ValueError("worker_identity_or_environment_invalid")
    if any(
        values.get(key) != expected_value
        for key, expected_value in {
            "DRIVE_WORKER_MODE": "true",
            "DB_POOL_MIN_SIZE": "0",
            "DB_POOL_MAX_SIZE": "2",
            "DB_SQLALCHEMY_POOL_SIZE": "1",
            "DB_SQLALCHEMY_MAX_OVERFLOW": "0",
        }.items()
    ):
        raise ValueError("worker_capacity_contract_mismatch")
    _verify_staged_launcher(value, worker)
    if version is not None and (
        values.get("PROTECTED_DOCUMENT_DELIVERY_ENABLED") != expected["protected"]
        or refs.get("BACKEND_RUNTIME_CONFIG_JSON")
        != {"name": expected["config_secret"], "key": version}
    ):
        raise ValueError("worker_immutable_config_mismatch")


def verify_scanner_startup(value: dict, fields: dict, *, read, pause) -> None:
    if fields["protected"] != "true":
        return
    name = value["metadata"]["name"]
    created = value["metadata"].get("creationTimestamp")
    if not created or not re.fullmatch(r"[0-9TZ:.-]+", created):
        raise ValueError("worker_creation_timestamp_unavailable")
    for attempt in range(12):
        rows = read(
            "logging",
            "read",
            f'resource.type="cloud_run_revision" AND resource.labels.service_name="{SERVICE}" AND resource.labels.revision_name="{name}" AND timestamp>="{created}" AND textPayload:"drive_worker_startup stage=scanner outcome=ready"',
            "--limit=100",
        )
        if not isinstance(rows, list):
            raise ValueError("worker_eicar_evidence_invalid")
        if any(
            "drive_worker_startup stage=scanner outcome=ready"
            in str(row.get("textPayload", ""))
            and row.get("resource", {}).get("labels", {}).get("revision_name") == name
            for row in rows
        ):
            return
        if attempt < 11:
            pause(5)
    raise ValueError("worker_eicar_startup_attestation_unavailable")


def staged_template(value: dict, fields: dict, version: str, name: str) -> dict:
    template = copy.deepcopy(value["spec"]["template"])
    metadata = {
        key: template.get("metadata", {}).get(key, {})
        for key in ("labels", "annotations")
    }
    template["metadata"] = metadata
    metadata["name"] = name
    metadata.setdefault("labels", {}).update(
        {"deploy-sha": fields["source"], "github-run-id": fields["run_id"]}
    )
    worker = next(
        item
        for item in template["spec"]["containers"]
        if item["name"] == "drive-worker"
    )
    worker["image"] = fields["image"]
    env = [
        item
        for item in worker["env"]
        if item["name"]
        not in {"BACKEND_RUNTIME_CONFIG_JSON", "PROTECTED_DOCUMENT_DELIVERY_ENABLED"}
    ]
    worker["env"] = env + [
        {
            "name": "BACKEND_RUNTIME_CONFIG_JSON",
            "valueFrom": {
                "secretKeyRef": {"name": fields["config_secret"], "key": version}
            },
        },
        {"name": "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "value": fields["protected"]},
    ]
    return template


def main() -> int:
    try:
        revision = json.load(sys.stdin)
        verify_revision(
            revision,
            deploy_sha=os.environ["EXPECTED_SHA"],
            app_image=os.environ["EXPECTED_APP_IMAGE"],
            scanner_index_digest=os.environ["EXPECTED_SCANNER_INDEX_DIGEST"],
            scanner_amd64_digest=os.environ["EXPECTED_SCANNER_AMD64_DIGEST"],
            drain_enabled=os.environ.get("EXPECTED_DRAIN_ENABLED"),
            semantic_model_provider=os.environ.get("EXPECTED_SEMANTIC_MODEL_PROVIDER"),
            managed_text_provider=os.environ.get("EXPECTED_MANAGED_TEXT_PROVIDER"),
            max_instances=os.environ.get("EXPECTED_MAX_INSTANCES"),
            concurrency=os.environ.get("EXPECTED_CONCURRENCY"),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Drive worker candidate provenance failed: {exc}", file=sys.stderr)
        return 1
    print("Verified Drive worker candidate readiness, SHA and image digests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
