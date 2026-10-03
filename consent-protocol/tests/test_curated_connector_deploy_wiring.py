"""The deploy derives curated connector secrets from the manifests.

Keeps the three places that must agree in step: the checked-in manifests, the
workflow step that turns them into Secret Manager names, and the Cloud Build
loop that mounts them, plus the coverage check that stops a lane silently
dropping the binding."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from hushh_mcp.services.curated_connector_manifest import (
    all_manifests,
    get_manifest,
    get_registration_spec,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDBUILD = (REPO_ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
UAT_WORKFLOW = (REPO_ROOT / ".github" / "workflows" / "deploy-uat.yml").read_text(encoding="utf-8")


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


def test_a_registration_only_client_id_is_never_mounted_by_deploy():
    assert get_registration_spec("attio") is not None
    assert get_manifest("attio") is None
    assert "ATTIO_OAUTH_CLIENT_ID" not in secrets_script.secret_names()


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
    assert 'add_secret "$s" "$s"' in CLOUDBUILD
    for name in ("HUBSPOT", "NOTION"):
        assert name not in CLOUDBUILD, "provider names must not be wired into the build file"


def test_the_coverage_check_sees_the_generic_binding():
    assert "_CURATED_CONNECTOR_SECRETS" in coverage_check.bound_substitutions()


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
