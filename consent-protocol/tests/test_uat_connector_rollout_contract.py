"""UAT rollout must survive deploys without broadening connector admission."""

from __future__ import annotations

import importlib.util
import sys
from argparse import Namespace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ops/sync_backend_runtime_secrets.py"
WORKFLOW = ROOT / ".github/workflows/deploy-uat.yml"


def _module():
    spec = importlib.util.spec_from_file_location("sync_backend_runtime_secrets", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _args(*, environment="uat", cohort="", **flags):
    values = {name: "false" for name in _module().CONNECTOR_ROLLOUT_FLAGS}
    values.update(flags)
    return Namespace(
        environment=environment,
        connector_internal_owner_cohort=cohort,
        **values,
    )


def test_default_off_and_exact_uat_cohort_are_accepted():
    module = _module()
    module._validate_connector_rollout(_args())
    module._validate_connector_rollout(
        _args(
            cohort="synthetic-owner-a,synthetic-owner-b",
            google_drive_connection="true",
            drive_document_sharing="true",
        )
    )


def test_enabled_feature_requires_a_nonempty_exact_cohort():
    with pytest.raises(ValueError, match="require exact Firebase UIDs"):
        _module()._validate_connector_rollout(_args(gmail_chat_reads="true"))


@pytest.mark.parametrize("environment", ["production", "dev", "local", "test"])
def test_hosted_connector_rollout_is_limited_to_uat(environment):
    module = _module()
    with pytest.raises(ValueError, match="limited to UAT"):
        module._validate_connector_rollout(_args(environment=environment, cohort="owner-a"))
    with pytest.raises(ValueError, match="limited to UAT"):
        module._validate_connector_rollout(
            _args(environment=environment, cohort="owner-a", google_drive_connection="true")
        )


@pytest.mark.parametrize(
    "cohort",
    [
        "*",
        "all",
        "owner-a,ALL",
        "owner-a,",
        ",owner-a",
        "owner-a,owner a",
        "owner-a,owner-a",
        "x" * 129,
        ",".join(f"owner-{index}" for index in range(26)),
    ],
)
def test_malformed_cohort_is_rejected_before_secret_access(cohort):
    with pytest.raises(ValueError, match="distinct exact Firebase UIDs"):
        _module()._validate_connector_rollout(_args(cohort=cohort))


def test_governed_uat_workflow_wires_every_flag_and_cohort_as_environment_data():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    step = workflow.split("- name: Sync canonical hosted runtime secrets", 1)[1].split(
        "- name: Build and pin backend image", 1
    )[0]
    expected = {
        "UAT_CONNECTIONS_PANEL_V2": ("CONNECTIONS_PANEL_V2_UAT", "--connections-panel-v2"),
        "UAT_GOOGLE_DRIVE_CONNECTION": ("GOOGLE_DRIVE_CONNECTION_UAT", "--google-drive-connection"),
        "UAT_GOOGLE_DRIVE_PICKER": ("GOOGLE_DRIVE_PICKER_UAT", "--google-drive-picker"),
        "UAT_DRIVE_DOCUMENT_INDEXING": ("DRIVE_DOCUMENT_INDEXING_UAT", "--drive-document-indexing"),
        "UAT_DRIVE_DOCUMENT_SHARING": ("DRIVE_DOCUMENT_SHARING_UAT", "--drive-document-sharing"),
        "UAT_GMAIL_CHAT_READS": ("GMAIL_CHAT_READS_UAT", "--gmail-chat-reads"),
        "UAT_GOOGLE_DRIVE_CHAT_READS": ("GOOGLE_DRIVE_CHAT_READS_UAT", "--google-drive-chat-reads"),
    }
    for env_name, (variable, argument) in expected.items():
        assert f"{env_name}: ${{{{ vars.{variable} || 'false' }}}}" in step
        assert f'{argument} "${env_name}"' in step
    assert (
        "UAT_CONNECTOR_INTERNAL_OWNER_COHORT: ${{ vars.CONNECTOR_INTERNAL_OWNER_COHORT_UAT || '' }}"
    ) in step
    assert '--connector-internal-owner-cohort "$UAT_CONNECTOR_INTERNAL_OWNER_COHORT"' in step
    assert "_validate_connector_rollout(args)" in SCRIPT.read_text(encoding="utf-8")
