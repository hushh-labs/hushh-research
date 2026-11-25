"""Dev and UAT Personal Sandbox (ACE) deploy parity contract for backend-deploy.sh.

Proves that:
1. Shared-dev deploys automatically preserve all 6 ACE runtime env bindings and
   both custody/identity Secret Manager bindings whenever the Edge Gateway and
   secrets exist, deriving URLs dynamically rather than hardcoding Cloud Run hashes.
2. Shared-UAT deploys in ``hushh-pda-uat`` enable ACE Confidential Sandbox parity
   with ``hussh-hosted-pods-uat`` (and never ``HUSHH_DEV_SIMULATION_ENABLED``) when
   the Edge Gateway and both custody secrets exist, and skip cleanly otherwise.
3. Production, manual, non-UAT-project, and commerce-preview deploys emit ZERO ACE
   bindings and stay byte-identical under ``set -u``.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DEPLOY = REPO_ROOT / "scripts" / "deploy" / "backend-deploy.sh"


def _extract_block(begin_marker: str, end_marker: str) -> str:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    return script.split(f"{begin_marker}\n", 1)[1].split(end_marker, 1)[0]


def _run_ace_block(
    *,
    deploy_env: str,
    project_id: str | None = None,
    commerce_prefix: str = "",
    edge_url: str = "https://sandbox-edge-gateway.example.run.app",
    has_seal_secret: bool = True,
    has_master_secret: bool = True,
) -> dict[str, str]:
    dev_block = _extract_block("# BEGIN DEV ACE SANDBOX PARITY", "# END DEV ACE SANDBOX PARITY")
    uat_block = _extract_block("# BEGIN UAT ACE SANDBOX PARITY", "# END UAT ACE SANDBOX PARITY")
    resolved_project = project_id or {
        "dev": "hushh-pda-dev",
        "uat": "hushh-pda-uat",
        "production": "hushh-pda",
    }.get(deploy_env, "hushh-pda")
    harness = f"""
set -euo pipefail
_DEPLOY_ENV="{deploy_env}"
_BACKEND_SERVICE="consent-protocol"
commerce_preview_prefix="{commerce_prefix}"
_REGION="us-central1"
PROJECT_ID="{resolved_project}"
_RUNTIME_SERVICE_ACCOUNT="consent-protocol-runtime@{resolved_project}.iam.gserviceaccount.com"
hub_url=""
env_vars=()
append_optional_env() {{
  if [[ -n "$2" ]]; then env_vars+=("$1=$2"); fi
}}

personal_agent_enabled=""
personal_agent_backend=""
personal_agent_autoprovision=""
gcp_backend_live=""
consent_plane_sa=""
pod_invoker_member=""
user_gcp_live=""
user_gcp_substrate_apply=""
pod_ingress=""
personal_agent_reconcile=""
personal_agent_reachability=""
hosted_pod_tier=""
hosted_pod_project=""
pod_turn_enabled=""
pod_directive_transport=""
pod_data_door=""
pod_local_pkm=""
pod_durable_identity=""
pod_migration=""
pod_files_enabled=""
trusted_device_enabled=""
dev_simulation_enabled=""
agent_sandbox_cutover_enabled=""
hub_storage_prefix_base_url=""
hub_storage_token_provider=""
pod_storage_gateway_gcs_bucket=""
sandbox_edge_public_url=""
source_pod_retirement_sweep_enabled=""
dev_custody_broker_seal_key_secret=""
dev_sandbox_identity_master_key_secret=""

gcloud() {{
  if [[ "$1" == "run" && "$2" == "services" && "$3" == "describe" ]]; then
    if [[ "$4" == "sandbox-edge-gateway" ]]; then
      printf '%s' "{edge_url}"
      return 0
    fi
    printf '%s' "https://consent-protocol.example.run.app"
    return 0
  fi
  if [[ "$1" == "secrets" && "$2" == "describe" ]]; then
    if [[ "$3" == "hussh-custody-broker-seal-key" && "{str(has_seal_secret).lower()}" == "true" ]]; then
      return 0
    fi
    if [[ "$3" == "sandbox-edge-identity-master-key" && "{str(has_master_secret).lower()}" == "true" ]]; then
      return 0
    fi
    return 1
  fi
  return 1
}}

if [[ "${{_DEPLOY_ENV}}" == "dev" && -z "${{commerce_preview_prefix:-}}" ]]; then
  hub_url="https://consent-protocol.example.run.app"
{dev_block}
fi
{uat_block}

printf 'HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED=%s\\n' "${{agent_sandbox_cutover_enabled}}"
printf 'HUSSH_HUB_STORAGE_PREFIX_BASE_URL=%s\\n' "${{hub_storage_prefix_base_url}}"
printf 'HUSSH_HUB_STORAGE_TOKEN_PROVIDER=%s\\n' "${{hub_storage_token_provider}}"
printf 'HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET=%s\\n' "${{pod_storage_gateway_gcs_bucket}}"
printf 'HUSSH_SANDBOX_EDGE_PUBLIC_URL=%s\\n' "${{sandbox_edge_public_url}}"
printf 'HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED=%s\\n' "${{source_pod_retirement_sweep_enabled}}"
printf 'HUSSH_CUSTODY_BROKER_SEAL_KEY=%s\\n' "${{dev_custody_broker_seal_key_secret}}"
printf 'HUSSH_SANDBOX_IDENTITY_MASTER_KEY=%s\\n' "${{dev_sandbox_identity_master_key_secret}}"
printf 'PERSONAL_AGENT_ENABLED=%s\\n' "${{personal_agent_enabled}}"
printf 'HUSSH_TRUSTED_DEVICE_ENABLED=%s\\n' "${{trusted_device_enabled}}"
printf 'HUSSH_USER_GCP_LIVE=%s\\n' "${{user_gcp_live}}"
printf 'HUSSH_USER_GCP_SUBSTRATE_APPLY=%s\\n' "${{user_gcp_substrate_apply}}"
printf 'HUSSH_CONSENT_PLANE_SA=%s\\n' "${{consent_plane_sa}}"
printf 'HUSSH_POD_INGRESS=%s\\n' "${{pod_ingress}}"
printf 'HUSHH_DEV_SIMULATION_ENABLED=%s\\n' "${{dev_simulation_enabled}}"
"""
    proc = subprocess.run(  # noqa: S603 - repository-owned bash guard verification
        ["bash", "-c", harness],  # noqa: S607
        text=True,
        capture_output=True,
        check=True,
    )
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        key, _, value = line.partition("=")
        out[key] = value
    return out


def test_dev_ace_bindings_are_emitted_in_shared_dev_when_resources_exist() -> None:
    result = _run_ace_block(deploy_env="dev")
    assert {k: result[k] for k in list(result)[:8]} == {
        "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED": "1",
        "HUSSH_HUB_STORAGE_PREFIX_BASE_URL": "https://consent-protocol.example.run.app/api/one/pod/storage-gateway",
        "HUSSH_HUB_STORAGE_TOKEN_PROVIDER": "ace_prefix_bearer",
        "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET": "hussh-hosted-pods-dev",
        "HUSSH_SANDBOX_EDGE_PUBLIC_URL": "https://sandbox-edge-gateway.example.run.app",
        "HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED": "true",
        "HUSSH_CUSTODY_BROKER_SEAL_KEY": "hussh-custody-broker-seal-key",
        "HUSSH_SANDBOX_IDENTITY_MASTER_KEY": "sandbox-edge-identity-master-key",
    }


def test_uat_ace_bindings_are_emitted_in_shared_uat_when_resources_exist() -> None:
    result = _run_ace_block(deploy_env="uat", project_id="hushh-pda-uat")
    assert result == {
        "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED": "1",
        "HUSSH_HUB_STORAGE_PREFIX_BASE_URL": "https://consent-protocol.example.run.app/api/one/pod/storage-gateway",
        "HUSSH_HUB_STORAGE_TOKEN_PROVIDER": "ace_prefix_bearer",
        "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET": "hussh-hosted-pods-uat",
        "HUSSH_SANDBOX_EDGE_PUBLIC_URL": "https://sandbox-edge-gateway.example.run.app",
        "HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED": "true",
        "HUSSH_CUSTODY_BROKER_SEAL_KEY": "hussh-custody-broker-seal-key",
        "HUSSH_SANDBOX_IDENTITY_MASTER_KEY": "sandbox-edge-identity-master-key",
        "PERSONAL_AGENT_ENABLED": "true",
        "HUSSH_TRUSTED_DEVICE_ENABLED": "true",
        "HUSSH_USER_GCP_LIVE": "true",
        "HUSSH_USER_GCP_SUBSTRATE_APPLY": "true",
        "HUSSH_CONSENT_PLANE_SA": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "HUSSH_POD_INGRESS": "all",
        "HUSHH_DEV_SIMULATION_ENABLED": "",
    }


@pytest.mark.parametrize("deploy_env", ["production", "prod", "manual", ""])
def test_non_dev_uat_lanes_emit_zero_ace_bindings(deploy_env: str) -> None:
    result = _run_ace_block(deploy_env=deploy_env)
    assert all(value == "" for value in result.values())


def test_uat_in_non_uat_project_emits_zero_ace_bindings() -> None:
    result = _run_ace_block(deploy_env="uat", project_id="hushh-pda")
    assert all(value == "" for value in result.values())


@pytest.mark.parametrize("deploy_env", ["dev", "uat"])
def test_commerce_preview_emits_zero_ace_bindings(deploy_env: str) -> None:
    result = _run_ace_block(deploy_env=deploy_env, commerce_prefix="SCOPE_COMMERCE_SANDBOX_")
    assert all(value == "" for value in result.values())


@pytest.mark.parametrize("deploy_env", ["dev", "uat"])
@pytest.mark.parametrize(
    ("edge_url", "has_seal", "has_master"),
    [
        ("", True, True),
        ("https://sandbox-edge-gateway.example.run.app", False, True),
        ("https://sandbox-edge-gateway.example.run.app", True, False),
    ],
)
def test_ace_block_skips_cleanly_when_edge_or_secret_missing(
    deploy_env: str, edge_url: str, has_seal: bool, has_master: bool
) -> None:
    result = _run_ace_block(
        deploy_env=deploy_env,
        edge_url=edge_url,
        has_seal_secret=has_seal,
        has_master_secret=has_master,
    )
    assert all(value == "" for value in result.values())


def test_backend_deploy_wires_all_ace_bindings_without_hardcoded_dev_hashes() -> None:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    assert "aqahj4iyha" not in script
    for expected in (
        'append_optional_env "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED"',
        'append_optional_env "HUSSH_HUB_STORAGE_PREFIX_BASE_URL"',
        'append_optional_env "HUSSH_HUB_STORAGE_TOKEN_PROVIDER"',
        'append_optional_env "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET"',
        'append_optional_env "HUSSH_SANDBOX_EDGE_PUBLIC_URL"',
        'append_optional_env "HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED"',
        'append_optional_secret "${dev_custody_broker_seal_key_secret}" "HUSSH_CUSTODY_BROKER_SEAL_KEY"',
        'append_optional_secret "${dev_sandbox_identity_master_key_secret}" "HUSSH_SANDBOX_IDENTITY_MASTER_KEY"',
    ):
        assert expected in script


def test_uat_sandbox_edge_reconciler_skips_non_uat_and_rejects_hardcoded_hashes() -> None:
    reconciler = REPO_ROOT / "scripts" / "deploy" / "reconcile-uat-sandbox-edge.sh"
    body = reconciler.read_text(encoding="utf-8")
    assert "aqahj4iyha" not in body
    assert "f2gsa4kfsq" not in body
    assert "@sha256:" in body
    proc = subprocess.run(  # noqa: S603 - repository-owned non-UAT guard verification
        ["bash", str(reconciler)],
        env={"PATH": "/usr/bin:/bin", "GCP_PROJECT_ID": "hushh-pda"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "skipping non-UAT project" in proc.stderr
