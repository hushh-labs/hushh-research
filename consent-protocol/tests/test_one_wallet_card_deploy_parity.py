"""Deploy-config contract for the Apple Wallet pass signing material.

Three separate files have to agree on three secret names or the pass never
signs, and the failure is invisible until someone taps *Add to Apple Wallet* in
production:

- ``scripts/ci/provision_wallet_pass_certificate.py`` **writes** the PEMs into
  Secret Manager under fixed names;
- ``hushh_mcp/runtime_settings.py`` **reads** them out of the process
  environment under those same names;
- the backend deploy config is the only thing that connects the two, and it had
  no idea they existed. Cloud Run would have started with all three unset, the
  signing service would have answered a permanent 503, and provisioning the
  certificate — an irreversible act that consumes a finite Apple slot — would
  have changed nothing.

That deploy config is now two files: ``deploy/backend.cloudbuild.yaml`` owns the
``substitutions:`` defaults and the ``env:`` list, while the behaviour — the
``append_optional_secret`` calls included — moved to
``scripts/deploy/backend-deploy.sh`` to get under Cloud Build's 10,000-character
per-arg cap. Assertions about *wiring* therefore read the combined surface; the
assertion about *defaults* still reads the YAML, which is where they live.

The wiring is deliberately *optional* (``add_secret`` probes with
``gcloud secrets describe`` and skips what is absent), so this contract can land
and deploy safely long before the certificate exists. These tests exist so the
name agreement cannot silently drift afterwards.
"""

from __future__ import annotations

import re
from pathlib import Path

from tests._deploy_contract import backend_deploy_surface

REPO_ROOT = Path(__file__).resolve().parents[2]

CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"
PROVISION_SCRIPT = REPO_ROOT / "scripts" / "ci" / "provision_wallet_pass_certificate.py"
RUNTIME_SETTINGS = REPO_ROOT / "consent-protocol" / "hushh_mcp" / "runtime_settings.py"

PEM_ENV_NAMES = ("WALLET_PASS_CERT_PEM", "WALLET_PASS_KEY_PEM", "WALLET_PASS_WWDR_PEM")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_the_deploy_passes_every_pem_through_to_cloud_run() -> None:
    surface = backend_deploy_surface()

    for env_name in PEM_ENV_NAMES:
        expected = f'append_optional_secret "${{_{env_name}_SECRET}}" "{env_name}"'
        assert expected in surface, f"{env_name} is never wired into the deploy"


def test_every_pem_substitution_reaches_the_deploy_script() -> None:
    """The YAML's `env:` list is the only way a substitution reaches the script.

    Splitting the step body out introduced a failure mode that did not exist while
    it was inline: the `append_optional_secret` call can be present in the script
    and the value still arrive empty, because nothing passed `${_FOO}` over. That
    would silently un-wire the pass signing material with every other assertion
    here still green.
    """
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        key = f"_{env_name}_SECRET"
        assert f'- "{key}=${{{key}}}"' in cloudbuild, (
            f"{key} is never handed to scripts/deploy/backend-deploy.sh via the "
            f"deploy-backend step's env: list, so it arrives unset at deploy time"
        )


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
