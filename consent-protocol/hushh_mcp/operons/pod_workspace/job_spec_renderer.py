# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pure spec renderers and normalizers for Option A ephemeral CLI worker jobs (#9511).

Supports GCP Cloud Run Jobs (`run.googleapis.com/v2`) and Azure Container Apps Jobs
(`Microsoft.App/jobs`, API `2025-01-01`) without performing any network I/O or
importing service-layer modules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from .command_policy import METADATA_NO_PROXY

WORKER_CONTAINER_NAME = "ws-worker"
WORKER_ENTRYPOINT_COMMAND = ("python3",)
WORKER_ENTRYPOINT_ARGS = ("-m", "hushh_mcp.services.pod_workspace.worker_runner")
MAX_WORKER_TIMEOUT_SECONDS = 600

_DIGEST_IMAGE_RE = re.compile(r"^[^\s:@]+(?::\d+)?/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$")

FORBIDDEN_WORKER_JOB_ENV: frozenset[str] = frozenset(
    {
        "APP_SIGNING_KEY",
        "HUSSH_POD_KMS_KEY",
        "HUSSH_POD_KEY_VAULT_KEY",
        "HUSSH_POD_FLEET_KEY_HEX",
        "HUSSH_POD_BROKER_WRAPPED_DEK",
        "HUSSH_POD_WRAPPED_KEY_OBJECT",
        "HUSSH_SHARED_FILES_BUCKET",
        "VAULT_MASTER_KEY",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_AZURE_BLOB_URL",
        "POD_FILES_AZURE_STORAGE_RESOURCE_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "ANTHROPIC_API_KEY",
    }
)

ALLOWED_WORKER_OVERRIDE_ENV_KEYS: frozenset[str] = frozenset(
    {
        "HUSSH_WS_RUN_ID",
        "HUSSH_WS_ID",
        "HUSSH_WS_OWNER",
        "HUSSH_WS_ACCOUNT_GENERATION",
        "HUSSH_WS_HOST_KIND",
        "HUSSH_WS_STORAGE_PROVIDER",
        "HUSSH_WS_STORAGE_URL",
        "HUSSH_WS_STORAGE_BUCKET",
        "HUSSH_WS_STORAGE_PREFIX",
        "HUSSH_WS_BEARER_TOKEN",
        "HUSSH_WS_RUN_KEY_B64",
    }
)

_AZURE_REFUSED_METERED_KEYS: frozenset[str] = frozenset(
    {
        "privateEndpointConnections",
        "privateEndpoints",
        "vnetConfiguration",
        "maintenanceConfigurations",
        "maintenanceConfiguration",
        "scheduledEntries",
    }
)


class WorkerJobSpecInvalid(ValueError):
    """Raised when a worker job template or override violates Option A security/cost bounds."""


@dataclass(frozen=True)
class WorkerJobSpecInput:
    """Provider-neutral inputs for rendering an Option A ephemeral CLI worker job."""

    image_by_digest: str
    worker_principal: str = ""
    pod_principal: str = ""
    timeout_seconds: int = 300
    cpu: str = "1"
    memory: str = "2Gi"
    azure_location: str = ""
    azure_environment_id: str = ""
    azure_registry_server: str = ""
    azure_registry_identity: str = ""
    labels_or_tags: dict[str, str] = field(default_factory=dict)
    base_env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkerExecutionOverrideInput:
    """Per-execution override inputs carrying only transient subprefix + one-shot run envelope metadata."""

    run_id: str
    workspace_id: str
    owner: str
    account_generation: int
    host_kind: str
    storage_provider: Literal[
        "ace_prefix_bearer",
        "gcs_cab",
        "azure_blob_delegation_sas",
    ]
    storage_url: str
    bearer_token: str
    run_key_b64: str
    storage_bucket: str = ""
    storage_prefix: str = ""
    timeout_seconds: int = 120


@dataclass(frozen=True)
class NormalizedWorkerJobRunResult:
    """Provider-neutral summary of a settled cloud worker job execution."""

    provider_job_mode: Literal["cloud_run_jobs_v2", "azure_container_apps_jobs"]
    execution_name: str
    succeeded: bool
    failed_count: int
    succeeded_count: int
    raw_state: str


def _refuse_azure_metered_keys(node: Any, *, where: str = "body") -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _AZURE_REFUSED_METERED_KEYS:
                raise WorkerJobSpecInvalid(
                    f"{where}.{key} refused: metered network/maintenance configuration is forbidden"
                )
            _refuse_azure_metered_keys(value, where=f"{where}.{key}")
    elif isinstance(node, list):
        for idx, item in enumerate(node):
            _refuse_azure_metered_keys(item, where=f"{where}[{idx}]")


def validate_worker_job_spec_security(
    spec: WorkerJobSpecInput,
    *,
    require_worker_principal: bool = False,
) -> None:
    image = (spec.image_by_digest or "").strip()
    if not _DIGEST_IMAGE_RE.fullmatch(image):
        raise WorkerJobSpecInvalid(
            "worker job requires an immutable @sha256:<64hex> container image reference"
        )
    worker_id = (spec.worker_principal or "").strip()
    pod_id = (spec.pod_principal or "").strip()
    if require_worker_principal and not worker_id:
        raise WorkerJobSpecInvalid("worker job requires a dedicated non-pod worker identity")
    if worker_id and pod_id and worker_id.lower() == pod_id.lower():
        raise WorkerJobSpecInvalid("worker job must not reuse the serving pod workload identity")
    if not (1 <= int(spec.timeout_seconds) <= MAX_WORKER_TIMEOUT_SECONDS):
        raise WorkerJobSpecInvalid(
            f"worker job timeout_seconds must be within 1..{MAX_WORKER_TIMEOUT_SECONDS}"
        )
    for env_key in spec.base_env:
        upper = str(env_key).strip().upper()
        if (
            upper in FORBIDDEN_WORKER_JOB_ENV
            or upper.startswith(("HUSSH_POD_", "VAULT_"))
            or "SECRET" in upper
        ):
            raise WorkerJobSpecInvalid(f"forbidden secret/pod env var in worker job: {env_key}")


def build_worker_override_env_map(override: WorkerExecutionOverrideInput) -> dict[str, str]:
    if not re.fullmatch(r"[0-9a-f]{32}", (override.run_id or "").strip()):
        raise WorkerJobSpecInvalid("run_id must be 32 lowercase hex chars")
    if not (override.bearer_token or "").strip() or not (override.run_key_b64 or "").strip():
        raise WorkerJobSpecInvalid(
            "worker execution requires transient subprefix token and run key"
        )
    if not (1 <= int(override.timeout_seconds) <= MAX_WORKER_TIMEOUT_SECONDS):
        raise WorkerJobSpecInvalid("override timeout_seconds out of bounds")
    env_map: dict[str, str] = {
        "HUSSH_WS_RUN_ID": override.run_id.strip(),
        "HUSSH_WS_ID": override.workspace_id.strip(),
        "HUSSH_WS_OWNER": override.owner.strip(),
        "HUSSH_WS_ACCOUNT_GENERATION": str(int(override.account_generation)),
        "HUSSH_WS_HOST_KIND": override.host_kind.strip(),
        "HUSSH_WS_STORAGE_PROVIDER": override.storage_provider,
        "HUSSH_WS_STORAGE_URL": override.storage_url.strip(),
        "HUSSH_WS_STORAGE_BUCKET": override.storage_bucket.strip(),
        "HUSSH_WS_STORAGE_PREFIX": override.storage_prefix.strip(),
        "HUSSH_WS_BEARER_TOKEN": override.bearer_token.strip(),
        "HUSSH_WS_RUN_KEY_B64": override.run_key_b64.strip(),
    }
    for key in env_map:
        if key not in ALLOWED_WORKER_OVERRIDE_ENV_KEYS:
            raise WorkerJobSpecInvalid(f"unapproved override env key: {key}")
    return env_map


def _base_worker_env_list(spec: WorkerJobSpecInput) -> list[dict[str, str]]:
    merged: dict[str, str] = {
        "NO_PROXY": METADATA_NO_PROXY,
        "no_proxy": METADATA_NO_PROXY,
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    for key, value in sorted(spec.base_env.items()):
        merged[str(key)] = str(value)
    return [{"name": k, "value": v} for k, v in merged.items()]


def render_gcp_cloud_run_job_spec(spec: WorkerJobSpecInput) -> dict[str, Any]:
    """Render a Cloud Run Admin v2 `Job` resource with zero pod KMS/session secrets."""
    validate_worker_job_spec_security(spec, require_worker_principal=True)
    return {
        "launchStage": "GA",
        "labels": dict(spec.labels_or_tags),
        "template": {
            "parallelism": 1,
            "taskCount": 1,
            "template": {
                "maxRetries": 0,
                "timeout": f"{int(spec.timeout_seconds)}s",
                "executionEnvironment": "EXECUTION_ENVIRONMENT_GEN2",
                "serviceAccount": spec.worker_principal.strip(),
                "containers": [
                    {
                        "name": WORKER_CONTAINER_NAME,
                        "image": spec.image_by_digest.strip(),
                        "command": list(WORKER_ENTRYPOINT_COMMAND),
                        "args": list(WORKER_ENTRYPOINT_ARGS),
                        "resources": {
                            "limits": {
                                "cpu": str(spec.cpu),
                                "memory": str(spec.memory),
                            }
                        },
                        "env": _base_worker_env_list(spec),
                    }
                ],
            },
        },
    }


def render_gcp_cloud_run_job_overrides(override: WorkerExecutionOverrideInput) -> dict[str, Any]:
    """Render Cloud Run Admin v2 `jobs:run` execution overrides."""
    env_map = build_worker_override_env_map(override)
    return {
        "overrides": {
            "taskCount": 1,
            "timeout": f"{int(override.timeout_seconds)}s",
            "containerOverrides": [
                {
                    "name": WORKER_CONTAINER_NAME,
                    "env": [{"name": k, "value": v} for k, v in sorted(env_map.items())],
                }
            ],
        }
    }


def normalize_gcp_job_execution(payload: dict[str, Any]) -> NormalizedWorkerJobRunResult:
    name = str(payload.get("name") or "")
    succeeded_count = int(payload.get("succeededCount") or 0)
    failed_count = int(payload.get("failedCount") or 0)
    conditions = payload.get("conditions") or ()
    completed_state = "UNKNOWN"
    completed_ok = succeeded_count >= 1 and failed_count == 0
    for cond in conditions:
        if isinstance(cond, dict) and cond.get("type") == "Completed":
            completed_state = str(cond.get("state") or "")
            if completed_state == "CONDITION_SUCCEEDED":
                completed_ok = failed_count == 0
            elif completed_state == "CONDITION_FAILED":
                completed_ok = False
    return NormalizedWorkerJobRunResult(
        provider_job_mode="cloud_run_jobs_v2",
        execution_name=name,
        succeeded=completed_ok,
        failed_count=failed_count,
        succeeded_count=succeeded_count,
        raw_state=completed_state,
    )


def _parse_azure_cpu(cpu_str: str) -> float:
    cleaned = str(cpu_str).strip()
    if cleaned.endswith("m"):
        return round(int(cleaned[:-1]) / 1000.0, 3)
    return float(cleaned)


def render_azure_container_app_job_spec(spec: WorkerJobSpecInput) -> dict[str, Any]:
    """Render an Azure `Microsoft.App/jobs` (`2025-01-01`) manual Consumption job body."""
    validate_worker_job_spec_security(spec, require_worker_principal=False)
    if not spec.azure_location.strip() or not spec.azure_environment_id.strip():
        raise WorkerJobSpecInvalid(
            "Azure Container Apps Job requires azure_location and azure_environment_id"
        )
    reg_identity = (spec.azure_registry_identity or spec.worker_principal or "").strip()
    if (
        reg_identity
        and spec.pod_principal
        and reg_identity.lower() == spec.pod_principal.strip().lower()
    ):
        raise WorkerJobSpecInvalid(
            "Azure worker job registry identity must not reuse the serving pod identity"
        )

    identity_block: dict[str, Any] = {"type": "None"}
    registries: list[dict[str, str]] = []
    if spec.azure_registry_server.strip() and reg_identity:
        identity_block = {
            "type": "UserAssigned",
            "userAssignedIdentities": {reg_identity: {}},
        }
        registries.append(
            {
                "server": spec.azure_registry_server.strip(),
                "identity": reg_identity,
            }
        )

    body: dict[str, Any] = {
        "location": spec.azure_location.strip(),
        "tags": dict(spec.labels_or_tags),
        "identity": identity_block,
        "properties": {
            "environmentId": spec.azure_environment_id.strip(),
            "workloadProfileName": "Consumption",
            "configuration": {
                "triggerType": "Manual",
                "replicaTimeout": int(spec.timeout_seconds),
                "replicaRetryLimit": 0,
                "manualTriggerConfig": {
                    "parallelism": 1,
                    "replicaCompletionCount": 1,
                },
                "registries": registries,
                "secrets": [],
            },
            "template": {
                "containers": [
                    {
                        "name": WORKER_CONTAINER_NAME,
                        "image": spec.image_by_digest.strip(),
                        "command": list(WORKER_ENTRYPOINT_COMMAND),
                        "args": list(WORKER_ENTRYPOINT_ARGS),
                        "resources": {
                            "cpu": _parse_azure_cpu(spec.cpu),
                            "memory": str(spec.memory),
                        },
                        "env": _base_worker_env_list(spec),
                    }
                ]
            },
        },
    }
    _refuse_azure_metered_keys(body)
    return body


def render_azure_container_app_job_start_body(
    spec: WorkerJobSpecInput,
    override: WorkerExecutionOverrideInput,
) -> dict[str, Any]:
    """Render `POST Microsoft.App/jobs/{name}/start` (`JobExecutionTemplate`) body.

    Azure `jobs/start` replaces `containers[0]` for that execution, so the start
    template carries the full digest-pinned container spec plus merged base +
    `HUSSH_WS_*` environment variables.
    """
    validate_worker_job_spec_security(spec, require_worker_principal=False)
    override_map = build_worker_override_env_map(override)
    merged_env = {entry["name"]: entry["value"] for entry in _base_worker_env_list(spec)}
    merged_env.update(override_map)
    body: dict[str, Any] = {
        "containers": [
            {
                "name": WORKER_CONTAINER_NAME,
                "image": spec.image_by_digest.strip(),
                "command": list(WORKER_ENTRYPOINT_COMMAND),
                "args": list(WORKER_ENTRYPOINT_ARGS),
                "resources": {
                    "cpu": _parse_azure_cpu(spec.cpu),
                    "memory": str(spec.memory),
                },
                "env": [{"name": k, "value": v} for k, v in sorted(merged_env.items())],
            }
        ]
    }
    _refuse_azure_metered_keys(body)
    return body


def normalize_azure_job_execution(payload: dict[str, Any]) -> NormalizedWorkerJobRunResult:
    name = str(payload.get("name") or payload.get("id") or "")
    props = payload.get("properties") if isinstance(payload.get("properties"), dict) else payload
    raw_status = str((props or {}).get("status") or "Unknown")
    succeeded = raw_status == "Succeeded"
    return NormalizedWorkerJobRunResult(
        provider_job_mode="azure_container_apps_jobs",
        execution_name=name,
        succeeded=succeeded,
        failed_count=0 if succeeded else 1,
        succeeded_count=1 if succeeded else 0,
        raw_state=raw_status,
    )
