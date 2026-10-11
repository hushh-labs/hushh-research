"""Deploy-config contract for the Apple Wallet pass signing material.

Three separate files have to agree on three secret names or the pass never
signs, and the failure is invisible until someone taps *Add to Apple Wallet* in
production:

- ``scripts/ci/provision_wallet_pass_certificate.py`` **writes** the PEMs into
  Secret Manager under fixed names;
- ``hushh_mcp/runtime_settings.py`` **reads** them out of the process
  environment under those same names;
- ``deploy/backend.cloudbuild.yaml`` is the only thing that connects the two,
  and it had no idea they existed. Cloud Run would have started with all three
  unset, the signing service would have answered a permanent 503, and
  provisioning the certificate — an irreversible act that consumes a finite
  Apple slot — would have changed nothing.

The wiring is deliberately *optional* (``add_secret`` probes with
``gcloud secrets describe`` and skips what is absent), so this contract can land
and deploy safely long before the certificate exists. These tests exist so the
name agreement cannot silently drift afterwards.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"
PROVISION_SCRIPT = REPO_ROOT / "scripts" / "ci" / "provision_wallet_pass_certificate.py"
RUNTIME_SETTINGS = REPO_ROOT / "consent-protocol" / "hushh_mcp" / "runtime_settings.py"

PEM_ENV_NAMES = ("WALLET_PASS_CERT_PEM", "WALLET_PASS_KEY_PEM", "WALLET_PASS_WWDR_PEM")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_the_deploy_passes_every_pem_through_to_cloud_run() -> None:
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        expected = f'add_secret "${{_{env_name}_SECRET}}" "{env_name}"'
        assert expected in cloudbuild, f"{env_name} is never wired into the deploy"


def test_each_pem_substitution_defaults_to_its_canonical_secret_name() -> None:
    """Defaulted rather than empty, so the first deploy after the certificate is
    minted picks the material up with no further change to the deploy config."""
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        match = re.search(rf"^  _{env_name}_SECRET:\s*(\S+)\s*$", cloudbuild, flags=re.MULTILINE)
        assert match, f"_{env_name}_SECRET has no substitution default"
        assert match.group(1) == env_name


def test_the_deploy_names_match_the_names_provisioning_writes() -> None:
    """The provisioning script is the only writer of these secrets; a rename on
    either side would leave Cloud Run pointed at a secret that never exists."""
    provisioning = _read(PROVISION_SCRIPT)

    for env_name in PEM_ENV_NAMES:
        assert f'"{env_name}"' in provisioning, f"provisioning does not write {env_name}"


def test_the_deploy_names_match_the_names_the_runtime_reads() -> None:
    runtime = _read(RUNTIME_SETTINGS)

    for env_name in PEM_ENV_NAMES:
        assert f'{env_name}_ENV = "{env_name}"' in runtime


def test_the_pems_stay_optional_so_the_deploy_survives_their_absence() -> None:
    """``add_secret`` is what keeps an un-provisioned environment
    deployable. Promoting these to the mandatory ``secrets=`` string would break
    every deploy in every project until the certificate is minted."""
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        assert f"{env_name}=${{_{env_name}_SECRET}}:latest" not in cloudbuild


def test_temporary_card_sharing_flag_reaches_runtime_and_defaults_off() -> None:
    cloudbuild = _read(CLOUDBUILD)
    assert any(
        "WALLET_CARD_ACCESS_ENABLED" in names.split()
        for names in re.findall(r"for n in (.+); do", cloudbuild)
    )
    assert '"_WALLET_CARD_ACCESS_ENABLED=${_WALLET_CARD_ACCESS_ENABLED}"' in cloudbuild
    assert '  _WALLET_CARD_ACCESS_ENABLED: "false"' in cloudbuild


def test_uat_enables_temporary_card_sharing_with_its_encryption_key() -> None:
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    assert (
        "##_WALLET_CARD_ACCESS_ENABLED=${{ vars.WALLET_CARD_ACCESS_UAT_ENABLED || 'true' }}"
        in workflow
    )
    assert "##_DIRECT_MESSAGE_ENCRYPTION_KEY_V1_SECRET=DIRECT_MESSAGE_ENCRYPTION_KEY_V1" in workflow
    manifest = _read(REPO_ROOT / "consent-protocol/db/release_migration_manifest.json")
    assert '"302_wallet_temporary_card_access.sql"' in manifest
    production = _read(REPO_ROOT / ".github/workflows/deploy-production.yml")
    assert "_WALLET_CARD_ACCESS_ENABLED=true" not in production


@pytest.mark.parametrize("supports_flag", [False, True])
@pytest.mark.parametrize("flag_value", ["true", "false"])
def test_uat_card_sharing_substitution_preserves_historical_deploys(
    tmp_path: Path, supports_flag: bool, flag_value: str
) -> None:
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    guard = re.search(
        r"(?m)^          if grep -q [^\n]*_WALLET_CARD_ACCESS_ENABLED[^\n]*\n"
        r"(?:^          .*\n)*?^          fi$",
        workflow,
    )
    assert guard, "UAT must guard new substitutions against the selected build config"
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    (deploy / "backend.cloudbuild.yaml").write_text(
        'substitutions:\n  _WALLET_CARD_ACCESS_ENABLED: "false"\n'
        if supports_flag
        else 'substitutions:\n  _BACKEND_SERVICE: "consent-protocol"\n',
        encoding="utf-8",
    )
    script = guard.group().replace(
        "${{ vars.WALLET_CARD_ACCESS_UAT_ENABLED || 'true' }}", flag_value
    )
    result = subprocess.run(  # noqa: S603 - Checked-in workflow code and fixed test values.
        [
            "bash",
            "-euc",
            'SUBSTITUTIONS="_BACKEND_SERVICE=consent-protocol"\n'
            + script
            + '\nprintf "%s" "$SUBSTITUTIONS"',
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    expected = "_BACKEND_SERVICE=consent-protocol"
    if supports_flag:
        expected += f"##_WALLET_CARD_ACCESS_ENABLED={flag_value}"
    assert result.stdout == expected
