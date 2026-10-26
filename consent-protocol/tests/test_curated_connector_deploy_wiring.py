"""The deploy derives curated connector secrets from the manifests.

Keeps the three places that must agree in step: the checked-in manifests, the
workflow step that turns them into Secret Manager names, and the Cloud Build
loop that mounts them, plus the coverage check that stops a lane silently
dropping the binding."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp.services.curated_connector_manifest import (
    all_manifests,
    get_manifest,
    get_registration_spec,
)
from tests.helpers.production_runtime_profile import production_runtime_profile

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text(encoding="utf-8")
CLOUDBUILD = (REPO_ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
UAT_WORKFLOW = (REPO_ROOT / ".github" / "workflows" / "deploy-uat.yml").read_text(encoding="utf-8")
PROD_WORKFLOW = (REPO_ROOT / ".github" / "workflows" / "deploy-production.yml").read_text(
    encoding="utf-8"
)


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


secrets_script = _load(REPO_ROOT / "scripts" / "ci" / "curated_connector_secrets.py", "ccs")
coverage_check = _load(REPO_ROOT / "scripts" / "ci" / "check-deploy-secret-coverage.py", "cdsc")


def test_the_stdlib_reader_agrees_with_the_validating_loader():
    expected = sorted(
        name for manifest in all_manifests().values() for name in manifest.secret_env_names
    )
    assert secrets_script.secret_names() == expected


def test_a_public_client_contributes_only_its_client_id():
    names = secrets_script.secret_names()
    assert "NOTION_OAUTH_CLIENT_ID" in names
    assert "NOTION_OAUTH_CLIENT_SECRET" not in names
    assert {"HUBSPOT_OAUTH_CLIENT_ID", "HUBSPOT_OAUTH_CLIENT_SECRET"} <= set(names)


def test_deploy_mounts_exactly_the_runtime_manifests_secrets_and_never_a_registration_only_one(
    registration_only_provider,
):
    # The stdlib reader scans only the runtime manifest directory, so a fixture
    # cannot put a registration spec where it would look. Guard the property
    # two other ways: its result must equal the authoritative loader's view of
    # the runtime manifests (a reader that also mounted registration contracts
    # could not match), and it must not know the registration directory at all.
    assert get_registration_spec("pendingco") is not None
    assert registration_only_provider.client_id_env == "PENDINGCO_OAUTH_CLIENT_ID"
    expected = sorted({name for m in all_manifests().values() for name in m.secret_env_names})
    assert secrets_script.secret_names() == expected
    assert "PENDINGCO_OAUTH_CLIENT_ID" not in secrets_script.secret_names()
    assert secrets_script.MANIFEST_DIR.name == "curated_connectors"
    assert "curated_connector_registrations" not in Path(secrets_script.__file__).read_text(
        encoding="utf-8"
    )


def test_a_runtime_manifest_client_id_is_mounted_by_deploy(registration_only_provider):
    # Attio graduated from registration-only to a reviewed runtime manifest, so
    # deploy now mounts its client id; the registration-only fixture still is not.
    manifest = get_manifest("attio")
    assert manifest is not None
    assert get_registration_spec("attio") is None
    names = secrets_script.secret_names()
    assert "ATTIO_OAUTH_CLIENT_ID" in manifest.secret_env_names
    assert "ATTIO_OAUTH_CLIENT_ID" in names
    assert "PENDINGCO_OAUTH_CLIENT_ID" not in names


def test_the_reader_rejects_an_unreadable_manifest(tmp_path):
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(SystemExit):
        secrets_script.secret_names(tmp_path)


def test_the_reader_rejects_a_bad_secret_name(tmp_path):
    (tmp_path / "x.json").write_text(
        '{"oauth": {"clientIdEnv": "lower case", "tokenEndpointAuth": "none"}}', encoding="utf-8"
    )
    with pytest.raises(SystemExit):
        secrets_script.secret_names(tmp_path)


def test_cloud_build_has_one_generic_loop_and_no_per_provider_lines():
    assert "_CURATED_CONNECTOR_SECRETS" in CLOUDBUILD
    assert '"scripts/deploy/backend-deploy.sh"' in CLOUDBUILD
    assert '"_CURATED_CONNECTOR_SECRETS=${_CURATED_CONNECTOR_SECRETS}"' in CLOUDBUILD
    assert 'for s in $(echo "${_CURATED_CONNECTOR_SECRETS}" | tr' in DEPLOY_SCRIPT
    assert 'append_optional_secret "$s" "$s"' in DEPLOY_SCRIPT
    assert "^[A-Z][A-Z0-9_]{1,127}$" in DEPLOY_SCRIPT
    assert "Invalid curated connector secret name." in DEPLOY_SCRIPT
    for name in ("HUBSPOT", "NOTION"):
        assert name not in CLOUDBUILD + DEPLOY_SCRIPT, "provider wiring must stay manifest-derived"


def test_the_coverage_check_sees_the_generic_binding():
    assert "_CURATED_CONNECTOR_SECRETS" in coverage_check.bound_substitutions()


def test_empty_default_secret_binding_retains_missing_lane_enforcement(
    tmp_path, monkeypatch, capsys
):
    secret = "_GOOGLE_DRIVE_PICKER_API_KEY_SECRET"
    assert secret in coverage_check.bound_substitutions()
    assert coverage_check.main() == 0

    baseline = json.loads(coverage_check.BASELINE.read_text(encoding="utf-8"))
    baseline["lanes"]["deploy-dev.yml"]["absent"].remove(secret)
    baseline["lanes"]["deploy-dev.yml"]["reasons"].pop(secret)
    fixture = tmp_path / "coverage.json"
    fixture.write_text(json.dumps(baseline), encoding="utf-8")
    deploy_script = tmp_path / "scripts/deploy/backend-deploy.sh"
    deploy_script.parent.mkdir(parents=True)
    deploy_script.write_text(DEPLOY_SCRIPT, encoding="utf-8")
    monkeypatch.setattr(coverage_check, "BASELINE", fixture)
    monkeypatch.setattr(coverage_check, "REPO_ROOT", tmp_path)

    assert coverage_check.main() == 1
    assert f"deploy-dev.yml: {secret} is bound" in capsys.readouterr().err


def test_the_uat_lane_passes_the_derived_names_and_checks_they_exist():
    assert "_CURATED_CONNECTOR_SECRETS=${{ steps.curated-secrets.outputs.names }}" in UAT_WORKFLOW
    assert "scripts/ci/curated_connector_secrets.py" in UAT_WORKFLOW
    # An enabled latest version, not just an existing secret shell.
    assert "gcloud secrets versions describe latest" in UAT_WORKFLOW
    assert '"${state}" != "ENABLED"' in UAT_WORKFLOW
    assert "HUBSPOT" not in UAT_WORKFLOW and "NOTION" not in UAT_WORKFLOW


def test_the_rollout_flag_still_gates_the_secret_names():
    step = UAT_WORKFLOW.split("Resolve curated connector secrets", 1)[1].split(
        "Deploy backend using Cloud Build", 1
    )[0]
    assert 'CURATED_CONNECTORS_ENABLED}" = "true"' in step
    assert "vars.CURATED_MCP_CONNECTORS_UAT" in step


def test_production_uses_its_own_opt_in_and_fails_before_deploy_on_missing_clients():
    step = PROD_WORKFLOW.split("Resolve production curated connector secrets", 1)[1].split(
        "Resolve production Drive release mode", 1
    )[0]
    assert "vars.CURATED_MCP_CONNECTORS_PROD || 'false'" in step
    assert "scripts/ci/curated_connector_secrets.py" in step
    assert "gcloud secrets versions describe latest" in step
    assert "EXTERNAL_CONNECTOR_CREDENTIAL_KEY" in step
    assert '"${state}" != "ENABLED"' in step
    assert '--project="${{ env.GCP_PROJECT_ID }}"' in step
    assert (
        "_CURATED_CONNECTOR_SECRETS=${{ steps.prod-curated-secrets.outputs.names }}"
        in PROD_WORKFLOW
    )
    assert (
        'elif [ "${{ steps.prod-curated-secrets.outputs.enabled }}" = "true" ]; then'
        in PROD_WORKFLOW
    )
    assert (
        "_EXTERNAL_CONNECTOR_CREDENTIAL_KEY_SECRET=EXTERNAL_CONNECTOR_CREDENTIAL_KEY"
        in PROD_WORKFLOW
    )
    assert (
        "PROD_CURATED_MCP_CONNECTORS: ${{ vars.CURATED_MCP_CONNECTORS_PROD || 'false' }}"
        in PROD_WORKFLOW
    )
    assert '--curated-mcp-connectors "$PROD_CURATED_MCP_CONNECTORS"' in production_runtime_profile(
        PROD_WORKFLOW
    )
    assert "CURATED_MCP_CONNECTORS_UAT" not in PROD_WORKFLOW


def test_registry_import_needs_no_runtime_keys_or_network() -> None:
    """Deployment registry maintenance must not import runtime credential authority."""
    program = """
import socket

def refuse(*args, **kwargs):
    raise AssertionError('network access is forbidden during registry imports')
socket.socket.connect = refuse
from hushh_mcp.services.drive_uat_registry_provisioning import assert_google_drive_uat_registry_target
from hushh_mcp.services.drive_prod_registry_provisioning import assert_google_drive_prod_registry_target
assert_google_drive_uat_registry_target(environment={
    'HUSSH_RELEASE_ENVIRONMENT': 'uat',
    'GCP_PROJECT_ID': 'hushh-pda-uat',
    'CLOUDSQL_INSTANCE_CONNECTION_NAME': 'hushh-pda-uat:us-central1:hushh-uat-pg',
})
"""
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository-owned probe
        [sys.executable, "-B", "-c", program],
        cwd=REPO_ROOT / "consent-protocol",
        env={"PATH": os.environ.get("PATH", ""), "PYTHON_DOTENV_DISABLED": "1"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, "registry import requires runtime credentials or network"
