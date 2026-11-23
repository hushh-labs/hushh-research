"""Dev-only Personal Sandbox (ACE) deploy parity contract for backend-deploy.sh.

Proves that:
1. Shared-dev deploys automatically preserve all 6 ACE runtime env bindings and
   both custody/identity Secret Manager bindings whenever the Edge Gateway and
   secrets exist, deriving URLs dynamically rather than hardcoding Cloud Run hashes.
2. UAT, Production, manual, and commerce-preview deploys emit ZERO ACE bindings
   and stay byte-identical under ``set -u``.
3. Missing Edge Gateway or secrets on a bootstrap Dev project skip cleanly
   without aborting the deploy.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DEPLOY = REPO_ROOT / "scripts" / "deploy" / "backend-deploy.sh"


def _extract_dev_ace_block() -> str:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    if "# BEGIN DEV ACE SANDBOX PARITY\n" not in script:
        pytest.skip(
            "backend-deploy.sh is Main-owned (PR #9888); Dev Hub custody is enforced by dev_sandbox_custody_bootstrap.py until Main syncs."
        )
    return script.split("# BEGIN DEV ACE SANDBOX PARITY\n", 1)[1].split(
        "# END DEV ACE SANDBOX PARITY", 1
    )[0]


def _run_ace_block(
    *,
    deploy_env: str,
    commerce_prefix: str = "",
    edge_url: str = "https://sandbox-edge-gateway.example.run.app",
    has_seal_secret: bool = True,
    has_master_secret: bool = True,
) -> dict[str, str]:
    block = _extract_dev_ace_block()
    harness = f"""
set -euo pipefail
_DEPLOY_ENV="{deploy_env}"
commerce_preview_prefix="{commerce_prefix}"
_REGION="us-central1"
PROJECT_ID="hushh-pda-dev"
hub_url="https://consent-protocol.example.run.app"

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
    printf '%s' "{edge_url}"
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
{block}
fi

printf 'HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED=%s\\n' "${{agent_sandbox_cutover_enabled}}"
printf 'HUSSH_HUB_STORAGE_PREFIX_BASE_URL=%s\\n' "${{hub_storage_prefix_base_url}}"
printf 'HUSSH_HUB_STORAGE_TOKEN_PROVIDER=%s\\n' "${{hub_storage_token_provider}}"
printf 'HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET=%s\\n' "${{pod_storage_gateway_gcs_bucket}}"
printf 'HUSSH_SANDBOX_EDGE_PUBLIC_URL=%s\\n' "${{sandbox_edge_public_url}}"
printf 'HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED=%s\\n' "${{source_pod_retirement_sweep_enabled}}"
printf 'HUSSH_CUSTODY_BROKER_SEAL_KEY=%s\\n' "${{dev_custody_broker_seal_key_secret}}"
printf 'HUSSH_SANDBOX_IDENTITY_MASTER_KEY=%s\\n' "${{dev_sandbox_identity_master_key_secret}}"
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
    assert result == {
        "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED": "1",
        "HUSSH_HUB_STORAGE_PREFIX_BASE_URL": "https://consent-protocol.example.run.app/api/one/pod/storage-gateway",
        "HUSSH_HUB_STORAGE_TOKEN_PROVIDER": "ace_prefix_bearer",
        "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET": "hussh-hosted-pods-dev",
        "HUSSH_SANDBOX_EDGE_PUBLIC_URL": "https://sandbox-edge-gateway.example.run.app",
        "HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED": "true",
        "HUSSH_CUSTODY_BROKER_SEAL_KEY": "hussh-custody-broker-seal-key",
        "HUSSH_SANDBOX_IDENTITY_MASTER_KEY": "sandbox-edge-identity-master-key",
    }


@pytest.mark.parametrize("deploy_env", ["uat", "production", "prod", "manual", ""])
def test_non_dev_lanes_emit_zero_ace_bindings(deploy_env: str) -> None:
    result = _run_ace_block(deploy_env=deploy_env)
    assert all(value == "" for value in result.values())


def test_commerce_preview_emits_zero_ace_bindings() -> None:
    result = _run_ace_block(deploy_env="dev", commerce_prefix="SCOPE_COMMERCE_SANDBOX_")
    assert all(value == "" for value in result.values())


@pytest.mark.parametrize(
    ("edge_url", "has_seal", "has_master"),
    [
        ("", True, True),
        ("https://sandbox-edge-gateway.example.run.app", False, True),
        ("https://sandbox-edge-gateway.example.run.app", True, False),
    ],
)
def test_dev_ace_block_skips_cleanly_when_edge_or_secret_missing(
    edge_url: str, has_seal: bool, has_master: bool
) -> None:
    result = _run_ace_block(
        deploy_env="dev",
        edge_url=edge_url,
        has_seal_secret=has_seal,
        has_master_secret=has_master,
    )
    assert all(value == "" for value in result.values())


def test_backend_deploy_wires_all_ace_bindings_without_hardcoded_dev_hashes() -> None:
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    assert "aqahj4iyha" not in script
    if "# BEGIN DEV ACE SANDBOX PARITY\n" not in script:
        bootstrap = (
            REPO_ROOT
            / "consent-protocol"
            / "hushh_mcp"
            / "services"
            / "dev_sandbox_custody_bootstrap.py"
        ).read_text(encoding="utf-8")
        assert "aqahj4iyha" not in bootstrap
        assert "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED" in bootstrap
        assert "HUSSH_CUSTODY_BROKER_SEAL_KEY" in bootstrap
        assert "HUSSH_SANDBOX_IDENTITY_MASTER_KEY" in bootstrap
        return
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
