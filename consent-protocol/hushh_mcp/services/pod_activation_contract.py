# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Single-image pod activation essentials and multi-cloud upgrade clearance contract.

Because every private pod runs the same immutable container image (``Dockerfile.pod``),
build-time dependencies (Python runtime, isolated ``/opt/browser`` worker, local
multilingual embedding model, action catalog vectors, non-root UID 10001) are baked
once. What varies per deployment target (``gcp``, ``ace``, ``user_gcp``, ``user_azure``,
``user_aws``) is a bounded set of runtime connection surfaces:

1. **Container & Platform Incarnation Surface:** service/revision identity env vars
   read by ``pod_platform`` so upgrade admission and erasure fences match Hub records.
2. **Hub Authority & Door Surface:** Hub control URL, caller identity allowlist, and
   pod signing/encryption keypairs.
3. **Storage & Key Custody Surface:** commit-log object store URI + custody mode/key.
4. **Runtime Model Provider Surface:** universal owner-sealed AI key (``byok_per_turn``)
   across every cloud PLUS each target's cloud-native standing model identity and
   precondition check.
5. **Upgrade Clearance Surface:** digest compatibility chain, target update admission,
   host sandbox qualification, and per-host browser qualification receipts.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hushh_mcp.services.model_access_policy import (
    ACTIVATION_BYOK_PER_TURN,
    ACTIVATION_FLEET_ADC,
    ACTIVATION_USER_ADC,
    ACTIVATION_USER_AWS_BEDROCK,
    ACTIVATION_USER_AZURE_MI,
    model_access_for,
)
from hushh_mcp.services.pod_ai_selection_seal import SUPPORTED_PROVIDERS
from hushh_mcp.services.pod_platform import _PLATFORM_NAME_PAIRS
from hushh_mcp.services.pod_release import (
    approved_browser_qualification,
    image_digest,
    qualified_owner_update_host,
    upgrade_is_supported,
)
from hushh_mcp.services.provider_capability_registry import (
    PROVIDER_CAPABILITY_REGISTRY,
    ProviderTargetSpec,
    validate_target_custody_mode,
)


@dataclass(frozen=True)
class PodImageStaticEssentials:
    """Build-once invariants baked into ``Dockerfile.pod`` across every cloud."""

    entrypoint_script: str = "/opt/browser/pod_entrypoint.py"
    non_root_uid: int = 10001
    single_worker_invariant: bool = True
    pod_mode_env: str = "HUSSH_POD_MODE=1"
    baked_embedding_env: str = (
        "HUSHH_DRIVE_EMBEDDING_MODEL_DIR=/opt/hushh/models/multilingual-e5-small"
    )
    isolated_browser_venv: str = "/opt/browser/venv"
    exposed_port: int = 8080


POD_IMAGE_STATIC_ESSENTIALS = PodImageStaticEssentials()


@dataclass(frozen=True)
class PodTargetActivationSpec:
    """Complete runtime connection checklist for activating and upgrading a pod target."""

    target_id: str
    workload_platform: str
    incarnation_env_pair: tuple[str, str]
    platform_sets_incarnation_natively: bool
    required_runtime_env: tuple[str, ...]
    custody_required_env_by_mode: Mapping[str, tuple[str, ...]]
    standing_model_activation: str
    standing_model_precondition: str
    universal_byok_activation: str = ACTIVATION_BYOK_PER_TURN
    universal_sealed_providers: tuple[str, ...] = SUPPORTED_PROVIDERS


POD_TARGET_ACTIVATION_ESSENTIALS: dict[str, PodTargetActivationSpec] = {
    "gcp": PodTargetActivationSpec(
        target_id="gcp",
        workload_platform="gcp",
        incarnation_env_pair=_PLATFORM_NAME_PAIRS["gcp"],
        platform_sets_incarnation_natively=True,
        required_runtime_env=(
            "HUSSH_HUB_BASE_URL",
            "POD_IDLE_GRACE_SECONDS",
        ),
        custody_required_env_by_mode={
            "ephemeral": (),
            "fleet_hkdf": (),
            "owner_kms": ("HUSSH_POD_KMS_KEY",),
            "ace_envelope": (),
            "hub_broker": ("HUSSH_HUB_BASE_URL",),
        },
        standing_model_activation=ACTIVATION_FLEET_ADC,
        standing_model_precondition="pod_managed_model_enabled",
    ),
    "ace": PodTargetActivationSpec(
        target_id="ace",
        workload_platform="ace",
        incarnation_env_pair=_PLATFORM_NAME_PAIRS["ace"],
        platform_sets_incarnation_natively=False,
        required_runtime_env=(
            "HUSSH_HUB_BASE_URL",
            "POD_STORAGE_BACKEND",
            "POD_STORAGE_PREFIX_TOKEN_URL",
            "POD_STORAGE_PREFIX_BEARER_TOKEN",
            "HUSSH_POD_CUSTODY_MODE",
            "ACE_SANDBOX_ID",
            "ACE_SANDBOX_REVISION",
            "APP_SIGNING_KEY",
        ),
        custody_required_env_by_mode={
            "ephemeral": (),
            "ace_envelope": ("HUSSH_POD_ACE_SEAL_SCALAR",),
            "hub_broker": ("HUSSH_HUB_BASE_URL",),
        },
        standing_model_activation=ACTIVATION_FLEET_ADC,
        standing_model_precondition="pod_managed_model_enabled",
    ),
    "user_gcp": PodTargetActivationSpec(
        target_id="user_gcp",
        workload_platform="gcp",
        incarnation_env_pair=_PLATFORM_NAME_PAIRS["gcp"],
        platform_sets_incarnation_natively=True,
        required_runtime_env=(
            "HUSSH_HUB_BASE_URL",
            "POD_STORAGE_BACKEND",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_GCS_PREFIX",
            "HUSSH_POD_HUB_CALLER_EMAILS",
            "APP_SIGNING_KEY",
        ),
        custody_required_env_by_mode={
            "owner_kms": ("HUSSH_POD_KMS_KEY",),
            "ace_envelope": (),
        },
        standing_model_activation=ACTIVATION_USER_ADC,
        standing_model_precondition="byoc_vertex_preconditions",
    ),
    "user_azure": PodTargetActivationSpec(
        target_id="user_azure",
        workload_platform="azure",
        incarnation_env_pair=_PLATFORM_NAME_PAIRS["azure"],
        platform_sets_incarnation_natively=True,
        required_runtime_env=(
            "HUSSH_HUB_BASE_URL",
            "POD_STORAGE_BACKEND",
            "POD_STORAGE_AZURE_BLOB_URL",
            "AZURE_CLIENT_ID",
            "HUSSH_POD_HUB_CALLER_EMAILS",
            "APP_SIGNING_KEY",
        ),
        custody_required_env_by_mode={
            "owner_vault": ("HUSSH_POD_KEY_VAULT_KEY",),
            "ace_envelope": (),
        },
        standing_model_activation=ACTIVATION_USER_AZURE_MI,
        standing_model_precondition="azure_openai_managed_identity_binding",
    ),
    "user_aws": PodTargetActivationSpec(
        target_id="user_aws",
        workload_platform="aws",
        incarnation_env_pair=_PLATFORM_NAME_PAIRS["aws"],
        platform_sets_incarnation_natively=False,
        required_runtime_env=(
            "HUSSH_HUB_BASE_URL",
            "POD_STORAGE_BACKEND",
            "POD_STORAGE_S3_URI",
            "HUSSH_POD_CUSTODY_MODE",
            "HUSSH_AWS_SERVICE_NAME",
            "HUSSH_AWS_TASK_REVISION",
            "HUSSH_POD_HUB_CALLER_EMAILS",
        ),
        custody_required_env_by_mode={
            "owner_kms": ("HUSSH_POD_AWS_KMS_KEY_ARN",),
            "ace_envelope": (),
        },
        standing_model_activation=ACTIVATION_USER_AWS_BEDROCK,
        standing_model_precondition="byoc_aws_bedrock_preconditions",
    ),
}


def verify_dockerfile_pod_essentials(dockerfile_path: Path) -> tuple[str, ...]:
    """Return any missing build-once invariants in ``Dockerfile.pod`` (empty == healthy)."""
    text = dockerfile_path.read_text(encoding="utf-8")
    missing: list[str] = []
    required_snippets = (
        ("entrypoint", POD_IMAGE_STATIC_ESSENTIALS.entrypoint_script),
        ("non_root_uid", f"--uid {POD_IMAGE_STATIC_ESSENTIALS.non_root_uid}"),
        ("pod_mode_env", POD_IMAGE_STATIC_ESSENTIALS.pod_mode_env),
        ("baked_embedding_model", POD_IMAGE_STATIC_ESSENTIALS.baked_embedding_env),
        (
            "offline_vector_bake",
            "HF_HUB_OFFLINE=1 python -m scripts.ops.bake_action_catalog_vectors",
        ),
        ("isolated_browser_venv", POD_IMAGE_STATIC_ESSENTIALS.isolated_browser_venv),
        ("exposed_port", f"EXPOSE {POD_IMAGE_STATIC_ESSENTIALS.exposed_port}"),
    )
    for label, snippet in required_snippets:
        if snippet not in text:
            missing.append(label)
    return tuple(missing)


def extract_env_map(
    env_entries: Sequence[Mapping[str, Any]] | Mapping[str, Any],
    *,
    secret_entries: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, str]:
    """Normalize Cloud Run, Azure Container Apps, ACE, or ECS env + secrets into a dict."""
    if isinstance(env_entries, Mapping):
        out = {str(k): str(v) for k, v in env_entries.items() if v is not None}
    else:
        out = {}
        for item in env_entries:
            name = str(item.get("name") or item.get("Name") or "").strip()
            if not name:
                continue
            if "value" in item or "Value" in item:
                val = item.get("value") if "value" in item else item.get("Value")
                out[name] = str(val if val is not None else "")
            elif (
                "valueFrom" in item
                or "ValueFrom" in item
                or "secretRef" in item
                or "secretName" in item
            ):
                out[name] = "<secret-ref>"
    if secret_entries:
        for sec in secret_entries:
            sec_name = str(sec.get("name") or sec.get("Name") or "").strip()
            if sec_name:
                out[sec_name] = "<secret-ref>"
    return out


def evaluate_pod_activation_readiness(
    target: str,
    *,
    rendered_env: Sequence[Mapping[str, Any]] | Mapping[str, Any],
    rendered_secrets: Sequence[Mapping[str, Any]] | None = None,
    model_provider: str = "gemini",
    coordinates: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """Verify every essential surface needed to bring a pod active on ``target``."""
    target_key = str(target or "").strip()
    provider_spec: ProviderTargetSpec | None = PROVIDER_CAPABILITY_REGISTRY.get(target_key)
    activation_spec = POD_TARGET_ACTIVATION_ESSENTIALS.get(target_key)
    if provider_spec is None or activation_spec is None:
        return {
            "target": target_key,
            "ready": False,
            "missingSurfaces": ("unknown_deployment_target",),
            "modelVerdict": model_access_for(target_key, model_provider).as_dict(),
        }

    env_map = extract_env_map(rendered_env, secret_entries=rendered_secrets)
    missing: list[str] = []

    if coordinates is not None:
        for coord in provider_spec.required_coordinates:
            if not str(coordinates.get(coord) or "").strip():
                missing.append(f"coordinate:{coord}")

    for env_name in activation_spec.required_runtime_env:
        if not str(env_map.get(env_name) or "").strip():
            missing.append(f"env:{env_name}")

    if target_key == "user_aws" and not str(env_map.get("APP_SIGNING_KEY") or "").strip():
        missing.append("secret:APP_SIGNING_KEY")

    custody_mode = str(env_map.get("HUSSH_POD_CUSTODY_MODE") or provider_spec.default_custody_mode)
    try:
        validate_target_custody_mode(target=target_key, custody_mode=custody_mode)
    except ValueError:
        missing.append(f"custody_mode_invalid:{custody_mode}")
    else:
        for custody_env in activation_spec.custody_required_env_by_mode.get(custody_mode, ()):
            if not str(env_map.get(custody_env) or "").strip():
                missing.append(f"custody_env:{custody_env}")

    verdict = model_access_for(target_key, model_provider)
    if not verdict.can_serve:
        missing.append(f"model_access:{model_provider}")

    return {
        "target": target_key,
        "workloadPlatform": activation_spec.workload_platform,
        "incarnationEnvPair": activation_spec.incarnation_env_pair,
        "platformSetsIncarnationNatively": activation_spec.platform_sets_incarnation_natively,
        "custodyMode": custody_mode,
        "modelVerdict": verdict.as_dict(),
        "standingModelPrecondition": activation_spec.standing_model_precondition,
        "supportedSealedAiProviders": activation_spec.universal_sealed_providers,
        "missingSurfaces": tuple(missing),
        "ready": len(missing) == 0,
    }


def evaluate_multi_cloud_upgrade_clearance(
    *,
    release_metadata: Mapping[str, Any] | None,
    installed_image: str,
    targets: Sequence[str] | None = None,
    model_provider: str = "gemini",
    require_browser_qualification: bool = False,
) -> dict[str, dict[str, Any]]:
    """Evaluate upgrade clearance across all registered clouds for a single pod release.

    Produces a deterministic per-target report so operators and automated rollouts
    never upgrade blindly or strand an un-cleared cloud target.
    """
    selected_targets = (
        tuple(targets) if targets is not None else tuple(PROVIDER_CAPABILITY_REGISTRY)
    )
    release_dict = dict(release_metadata) if isinstance(release_metadata, Mapping) else None
    target_image = str((release_dict or {}).get("image") or "")
    target_digest = image_digest(target_image) or ""
    approval_wrapper = {"releaseMetadata": release_dict} if release_dict is not None else None

    report: dict[str, dict[str, Any]] = {}
    for target_id in selected_targets:
        spec = PROVIDER_CAPABILITY_REGISTRY.get(target_id)
        act = POD_TARGET_ACTIVATION_ESSENTIALS.get(target_id)
        if spec is None or act is None:
            report[target_id] = {
                "target": target_id,
                "status": "blocked",
                "cleared": False,
                "blockingGates": ("unknown_target",),
            }
            continue

        blocking: list[str] = []
        digest_ok = upgrade_is_supported(release_dict, installed_image)
        if not digest_ok:
            blocking.append("digest_not_in_supported_upgrade_lineage")

        if spec.tenancy == "owner_cloud":
            update_admitted = qualified_owner_update_host(target_id, {})
            if not update_admitted:
                blocking.append("owner_update_not_qualified")
        else:
            update_admitted = spec.registry_sql_admitted
            if not update_admitted:
                blocking.append("hosted_target_not_sql_admitted")

        sandbox_ok = spec.sandbox_capability.execution_qualified
        if not sandbox_ok:
            blocking.append("sandbox_not_execution_qualified")

        browser_receipt = (
            approved_browser_qualification(
                approval_wrapper,
                target_image,
                host_kind=spec.default_host_kind,
            )
            if target_image
            else None
        )
        browser_ok = browser_receipt is not None
        if require_browser_qualification and not browser_ok:
            blocking.append(f"missing_browser_qualification:{spec.default_host_kind}")

        model_verdict = model_access_for(target_id, model_provider)
        if not model_verdict.can_serve:
            blocking.append(f"model_access_refused:{model_provider}")

        cleared = len(blocking) == 0
        report[target_id] = {
            "target": target_id,
            "providerFamily": spec.provider_family,
            "tenancy": spec.tenancy,
            "hostKind": spec.default_host_kind,
            "targetDigest": target_digest,
            "digestLineageCleared": digest_ok,
            "targetUpdateAdmitted": update_admitted,
            "sandboxExecutionQualified": sandbox_ok,
            "browserQualificationAttached": browser_ok,
            "modelProviderCleared": model_verdict.can_serve,
            "standingModelActivation": act.standing_model_activation,
            "supportedSealedAiProviders": act.universal_sealed_providers,
            "blockingGates": tuple(blocking),
            "cleared": cleared,
            "status": "cleared" if cleared else "gated",
        }
    return report


__all__ = [
    "POD_IMAGE_STATIC_ESSENTIALS",
    "POD_TARGET_ACTIVATION_ESSENTIALS",
    "PodImageStaticEssentials",
    "PodTargetActivationSpec",
    "evaluate_multi_cloud_upgrade_clearance",
    "evaluate_pod_activation_readiness",
    "extract_env_map",
    "verify_dockerfile_pod_essentials",
]
