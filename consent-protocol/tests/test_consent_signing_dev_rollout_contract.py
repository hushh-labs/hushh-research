"""The Ed25519 consent-signing cutover stays a DEV-lane fact, provably.

Phase 6 stages non-repudiation on dev: `scripts/deploy/backend-deploy.sh` flips
``CONSENT_TOKEN_SIGNING_ALG=ed25519`` only on the dev lane and only when BOTH key
secrets already exist. These tests turn the two claims that matter -- "uat and
production carry none of this" and "a deploy before the mint stays HMAC" -- into
red/green facts instead of review-time assertions, the same way
``test_pod_image_build_contract`` guards the pod-image lane.
"""

from __future__ import annotations

import subprocess

import pytest

from hushh_mcp.consent.token_signing import ALG_ED25519
from tests._deploy_contract import backend_deploy_script

MINT_SCRIPT = "scripts/ops/mint_consent_ed25519_key.py"
KID = "hushh-consent-dev-1"


def _bash(script: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed argv, no shell=True, test-local input
        ["bash", "-c", script],  # noqa: S607 - bash is resolved from PATH by design
        text=True,
        capture_output=True,
        check=False,
    ).stdout


def test_consent_signing_locals_are_pre_initialised_before_assignment_and_append() -> None:
    """`set -u` safety: each local is initialised empty BEFORE the dev gate assigns
    it, and the unconditional append reads it only after both."""
    script = backend_deploy_script()
    ordering = (
        ('consent_signing_alg=""', 'consent_signing_alg="ed25519"', '"CONSENT_TOKEN_SIGNING_ALG"'),
        ('consent_ed25519_kid=""', f'consent_ed25519_kid="{KID}"', '"CONSENT_ED25519_KID"'),
        (
            'dev_consent_ed25519_private_secret=""',
            'dev_consent_ed25519_private_secret="CONSENT_ED25519_PRIVATE_KEY"',
            '"${dev_consent_ed25519_private_secret}"',
        ),
        (
            'dev_consent_ed25519_public_keys_secret=""',
            'dev_consent_ed25519_public_keys_secret="CONSENT_ED25519_PUBLIC_KEYS"',
            '"${dev_consent_ed25519_public_keys_secret}"',
        ),
    )
    for init, assign, read in ordering:
        assert script.index(init) < script.index(assign) < script.index(read), (
            f"{init} must precede its dev-gated assignment, which must precede the append"
        )


@pytest.mark.parametrize("deploy_env", ["uat", "production", "manual"])
def test_consent_signing_locals_are_empty_outside_dev(deploy_env: str) -> None:
    """`append_optional_env`/`append_optional_secret` drop empties, so empty means
    the lane carries none of this by construction rather than by discipline."""
    out = _bash(
        'consent_signing_alg=""; consent_ed25519_kid=""\n'
        'dev_consent_ed25519_private_secret=""; dev_consent_ed25519_public_keys_secret=""\n'
        f'if [[ "{deploy_env}" == "dev" ]]; then\n'
        '  consent_signing_alg="ed25519"\n'
        f'  consent_ed25519_kid="{KID}"\n'
        '  dev_consent_ed25519_private_secret="CONSENT_ED25519_PRIVATE_KEY"\n'
        '  dev_consent_ed25519_public_keys_secret="CONSENT_ED25519_PUBLIC_KEYS"\n'
        "fi\n"
        'echo "alg=${consent_signing_alg} kid=${consent_ed25519_kid} '
        'priv=${dev_consent_ed25519_private_secret} pub=${dev_consent_ed25519_public_keys_secret}"'
    )
    assert out.strip() == "alg= kid= priv= pub="


def test_flip_is_gated_on_both_secrets_existing() -> None:
    """A deploy before the mint must stay HMAC: the assignment sits behind a
    `gcloud secrets describe` for EACH secret, not a lane check alone."""
    script = backend_deploy_script()
    dev_block = script[script.index('if [[ "${_DEPLOY_ENV}" == "dev" ]]; then') :]
    assignment = dev_block.index('consent_signing_alg="ed25519"')
    gate = dev_block[:assignment]
    assert 'gcloud secrets describe CONSENT_ED25519_PRIVATE_KEY --project="$PROJECT_ID"' in gate
    assert 'gcloud secrets describe CONSENT_ED25519_PUBLIC_KEYS --project="$PROJECT_ID"' in gate
    # And the pre-mint path says so out loud rather than silently staying HMAC.
    assert "Ed25519 consent signing: secrets absent; issuance stays HMAC." in script


def test_private_key_is_never_an_env_literal() -> None:
    """The seed rides Secret Manager only; an env literal would put it in every
    deploy log and service description."""
    script = backend_deploy_script()
    assert (
        'append_optional_secret "${dev_consent_ed25519_private_secret}" '
        '"CONSENT_ED25519_PRIVATE_KEY"' in script
    )
    assert 'append_optional_env "CONSENT_ED25519_PRIVATE_KEY"' not in script


def test_public_keys_ride_secret_manager_and_reach_the_hub_env() -> None:
    script = backend_deploy_script()
    assert (
        'append_optional_secret "${dev_consent_ed25519_public_keys_secret}" '
        '"CONSENT_ED25519_PUBLIC_KEYS"' in script
    )


def test_alg_value_is_exactly_the_module_constant() -> None:
    """signing_alg() treats any unrecognized value as HMAC, so a near-miss literal
    would silently ship no cutover at all."""
    script = backend_deploy_script()
    assert f'consent_signing_alg="{ALG_ED25519}"' in script


def test_kid_literal_matches_the_mint_default() -> None:
    """The kid is set in two places -- the deploy script and the mint script -- and
    a mismatch verifies at the hub while fail-closing in every pod."""
    script = backend_deploy_script()
    assert f'consent_ed25519_kid="{KID}"' in script
    from pathlib import Path

    mint = Path(__file__).resolve().parents[1] / MINT_SCRIPT
    assert f'DEFAULT_KID = "{KID}"' in mint.read_text(encoding="utf-8")
