"""Personal Sandbox (ACE) deploy parity contract for backend-deploy.sh (Dev + UAT).

Proves that:
1. Shared-dev deploys automatically preserve all 6 ACE runtime env bindings and
   both custody/identity Secret Manager bindings whenever the Edge Gateway and
   secrets exist, deriving URLs dynamically rather than hardcoding Cloud Run hashes.
2. UAT deploys emit zero-role ACE Personal Sandbox bindings strictly when the UAT
   Edge Gateway and both UAT custody/identity secrets exist, without ever enabling
   Dev simulation flags or shared-SA pod hub auth.
3. Production, manual, and commerce-preview deploys emit ZERO ACE bindings
   and stay byte-identical under ``set -u``.
4. Missing Edge Gateway or secrets on Dev or UAT skip cleanly without aborting.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DEPLOY = REPO_ROOT / "scripts" / "deploy" / "backend-deploy.sh"


def _extract_block(begin: str, end: str) -> str:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    return script.split(f"# {begin}\n", 1)[1].split(f"# {end}", 1)[0]


def _run_ace_blocks(
    *,
    deploy_env: str,
    commerce_prefix: str = "",
    edge_url: str = "https://sandbox-edge-gateway.example.run.app",
    has_seal_secret: bool = True,
    has_master_secret: bool = True,
) -> dict[str, str]:
    dev_block = _extract_block("BEGIN DEV ACE SANDBOX PARITY", "END DEV ACE SANDBOX PARITY")
    uat_block = _extract_block("BEGIN UAT ACE SANDBOX PARITY", "END UAT ACE SANDBOX PARITY")
    harness = f"""
set -euo pipefail
_DEPLOY_ENV="{deploy_env}"
_BACKEND_SERVICE="consent-protocol"
commerce_preview_prefix="{commerce_prefix}"
_REGION="us-central1"
PROJECT_ID="hushh-pda-{deploy_env or "dev"}"
hub_url="https://consent-protocol.example.run.app"

personal_agent_enabled=""
personal_agent_backend=""
pod_turn_enabled=""
pod_directive_transport=""
pod_local_pkm=""
pod_durable_identity=""
dev_simulation_enabled=""
pod_identity_auth=""
agent_sandbox_cutover_enabled=""
hub_storage_prefix_base_url=""
hub_storage_token_provider=""
pod_storage_gateway_gcs_bucket=""
sandbox_edge_public_url=""
source_pod_retirement_sweep_enabled=""
ace_custody_broker_seal_key_secret=""
ace_sandbox_identity_master_key_secret=""
uat_ace_hub_url=""

gcloud() {{
  if [[ "$1" == "run" && "$2" == "services" && "$3" == "describe" ]]; then
    if [[ "$4" == "sandbox-edge-gateway" ]]; then
      printf '%s' "{edge_url}"
      return 0
    fi
    if [[ "$4" == "consent-protocol" ]]; then
      printf '%s' "https://consent-protocol-uat.example.run.app"
      return 0
    fi
    return 1
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
{dev_block}
fi
{uat_block}

printf 'PERSONAL_AGENT_ENABLED=%s\\n' "${{uat_ace_personal_agent_enabled}}"
printf 'PERSONAL_AGENT_BACKEND=%s\\n' "${{uat_ace_personal_agent_backend}}"
printf 'HUSSH_POD_TURN_ENABLED=%s\\n' "${{uat_ace_pod_turn_enabled}}"
printf 'POD_DIRECTIVE_TRANSPORT_ENABLED=%s\\n' "${{uat_ace_pod_directive_transport}}"
printf 'POD_LOCAL_PKM_ENABLED=%s\\n' "${{uat_ace_pod_local_pkm}}"
printf 'POD_DURABLE_IDENTITY_ENABLED=%s\\n' "${{uat_ace_pod_durable_identity}}"
printf 'HUSHH_DEV_SIMULATION_ENABLED=%s\\n' "${{dev_simulation_enabled}}"
printf 'POD_HUB_IDENTITY_AUTH_ENABLED=%s\\n' "${{pod_identity_auth}}"
printf 'UAT_HUSSH_HUB_BASE_URL=%s\\n' "${{uat_ace_hub_url}}"
printf 'HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED=%s\\n' "${{agent_sandbox_cutover_enabled}}"
printf 'HUSSH_HUB_STORAGE_PREFIX_BASE_URL=%s\\n' "${{hub_storage_prefix_base_url}}"
printf 'HUSSH_HUB_STORAGE_TOKEN_PROVIDER=%s\\n' "${{hub_storage_token_provider}}"
printf 'HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET=%s\\n' "${{pod_storage_gateway_gcs_bucket}}"
printf 'HUSSH_SANDBOX_EDGE_PUBLIC_URL=%s\\n' "${{sandbox_edge_public_url}}"
printf 'HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED=%s\\n' "${{source_pod_retirement_sweep_enabled}}"
printf 'HUSSH_CUSTODY_BROKER_SEAL_KEY=%s\\n' "${{ace_custody_broker_seal_key_secret}}"
printf 'HUSSH_SANDBOX_IDENTITY_MASTER_KEY=%s\\n' "${{ace_sandbox_identity_master_key_secret}}"
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
    result = _run_ace_blocks(deploy_env="dev")
    assert result["HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED"] == "1"
    assert (
        result["HUSSH_HUB_STORAGE_PREFIX_BASE_URL"]
        == "https://consent-protocol.example.run.app/api/one/pod/storage-gateway"
    )
    assert result["HUSSH_HUB_STORAGE_TOKEN_PROVIDER"] == "ace_prefix_bearer"
    assert result["HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET"] == "hussh-hosted-pods-dev"
    assert result["HUSSH_SANDBOX_EDGE_PUBLIC_URL"] == "https://sandbox-edge-gateway.example.run.app"
    assert result["HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED"] == "true"
    assert result["HUSSH_CUSTODY_BROKER_SEAL_KEY"] == "hussh-custody-broker-seal-key"
    assert result["HUSSH_SANDBOX_IDENTITY_MASTER_KEY"] == "sandbox-edge-identity-master-key"
    assert result["UAT_HUSSH_HUB_BASE_URL"] == ""


def test_uat_ace_bindings_are_emitted_when_resources_exist_without_dev_flags() -> None:
    result = _run_ace_blocks(deploy_env="uat")
    assert result["PERSONAL_AGENT_ENABLED"] == "true"
    assert result["PERSONAL_AGENT_BACKEND"] == "ace"
    assert result["HUSSH_POD_TURN_ENABLED"] == "true"
    assert result["POD_DIRECTIVE_TRANSPORT_ENABLED"] == "true"
    assert result["POD_LOCAL_PKM_ENABLED"] == "true"
    assert result["POD_DURABLE_IDENTITY_ENABLED"] == "true"
    assert result["HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED"] == "1"
    assert result["UAT_HUSSH_HUB_BASE_URL"] == "https://consent-protocol-uat.example.run.app"
    assert (
        result["HUSSH_HUB_STORAGE_PREFIX_BASE_URL"]
        == "https://consent-protocol-uat.example.run.app/api/one/pod/storage-gateway"
    )
    assert result["HUSSH_HUB_STORAGE_TOKEN_PROVIDER"] == "ace_prefix_bearer"
    assert result["HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET"] == "hussh-hosted-pods-uat"
    assert result["HUSSH_SANDBOX_EDGE_PUBLIC_URL"] == "https://sandbox-edge-gateway.example.run.app"
    assert result["HUSSH_CUSTODY_BROKER_SEAL_KEY"] == "hussh-custody-broker-seal-key"
    assert result["HUSSH_SANDBOX_IDENTITY_MASTER_KEY"] == "sandbox-edge-identity-master-key"
    # UAT must NEVER inherit Dev simulation or shared-SA pod hub auth.
    assert result["HUSHH_DEV_SIMULATION_ENABLED"] == ""
    assert result["POD_HUB_IDENTITY_AUTH_ENABLED"] == ""
    assert result["HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED"] == ""


@pytest.mark.parametrize("deploy_env", ["production", "prod", "manual", ""])
def test_production_and_other_lanes_emit_zero_ace_bindings(deploy_env: str) -> None:
    result = _run_ace_blocks(deploy_env=deploy_env)
    assert all(value == "" for value in result.values())


@pytest.mark.parametrize("deploy_env", ["dev", "uat"])
def test_commerce_preview_emits_zero_ace_bindings(deploy_env: str) -> None:
    result = _run_ace_blocks(deploy_env=deploy_env, commerce_prefix="SCOPE_COMMERCE_SANDBOX_")
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
    result = _run_ace_blocks(
        deploy_env=deploy_env,
        edge_url=edge_url,
        has_seal_secret=has_seal,
        has_master_secret=has_master,
    )
    assert all(value == "" for value in result.values())


def test_backend_deploy_wires_all_ace_bindings_without_hardcoded_hashes() -> None:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    assert "aqahj4iyha" not in script
    assert "f2gsa4kfsq" not in script
    for expected in (
        'append_optional_env "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED"',
        'append_optional_env "HUSSH_HUB_STORAGE_PREFIX_BASE_URL"',
        'append_optional_env "HUSSH_HUB_STORAGE_TOKEN_PROVIDER"',
        'append_optional_env "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET"',
        'append_optional_env "HUSSH_SANDBOX_EDGE_PUBLIC_URL"',
        'append_optional_env "HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED"',
        'append_optional_secret "${ace_custody_broker_seal_key_secret}" "HUSSH_CUSTODY_BROKER_SEAL_KEY"',
        'append_optional_secret "${ace_sandbox_identity_master_key_secret}" "HUSSH_SANDBOX_IDENTITY_MASTER_KEY"',
    ):
        assert expected in script
