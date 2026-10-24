"""UAT rollout must survive deploys without broadening connector admission."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ops/sync_backend_runtime_secrets.py"
WORKFLOW = ROOT / ".github/workflows/deploy-uat.yml"
CANDIDATE_SECRET_NAME = "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"


def _module():
    spec = importlib.util.spec_from_file_location("sync_backend_runtime_secrets", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _args(
    *,
    environment="uat",
    cohort="",
    all_users="false",
    prod_cohort="",
    prod_all_users="false",
    candidate_secret="",
    project=None,
    **flags,
):
    values = {name: "false" for name in _module().CONNECTOR_ROLLOUT_FLAGS}
    values.update(flags)
    return Namespace(
        project=project or ("hushh-pda" if environment == "production" else "hushh-pda-uat"),
        environment=environment,
        connector_internal_owner_cohort=cohort,
        connector_uat_all_users=all_users,
        connector_production_owner_cohort=prod_cohort,
        connector_production_all_users=prod_all_users,
        production_drive_candidate_secret=candidate_secret,
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


def test_explicit_all_users_mode_accepts_enabled_uat_features():
    _module()._validate_connector_rollout(
        _args(
            all_users="true",
            google_drive_connection="true",
            drive_document_sharing="true",
        )
    )


@pytest.mark.parametrize(
    "feature", ["gmail_chat_reads", "drive_four_group_index", "drive_period_packets"]
)
def test_enabled_feature_requires_a_cohort_or_all_users_mode(feature):
    with pytest.raises(ValueError, match="require a lane-specific cohort or all-users mode"):
        _module()._validate_connector_rollout(_args(**{feature: "true"}))


def test_period_packets_are_independent_and_refuse_non_uat_activation():
    module = _module()
    module._validate_connector_rollout(_args())
    module._validate_connector_rollout(_args(all_users="true", drive_period_packets="true"))
    for environment in ("dev", "production"):
        with pytest.raises(ValueError, match="period packets rollout is limited to UAT"):
            module._validate_connector_rollout(
                _args(environment=environment, all_users="true", drive_period_packets="true")
            )


def test_four_group_hosted_compilers_default_off_and_require_explicit_uat_activation():
    for lane in ("dev", "uat", "production"):
        workflow = (ROOT / f".github/workflows/deploy-{lane}.yml").read_text(encoding="utf-8")
        argument = (
            "--drive-four-group-index \"${{ vars.DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED || 'false' }}\""
            if lane == "uat"
            else '--drive-four-group-index "false"'
        )
        assert argument in workflow
        # UAT has its own explicit, default-off activation. Other lanes stay off.
        if lane != "production":
            assert '"${drive_group_args[@]}"' in workflow
            assert "if grep -q -- '--drive-four-group-index'" in workflow


@pytest.mark.parametrize("lane,requested", [("dev", "false"), ("uat", "false"), ("uat", "true")])
@pytest.mark.parametrize("supports_groups", [False, True])
@pytest.mark.parametrize("feature", ["four-group-index", "period-packets-enabled"])
def test_selected_sha_compiler_preserves_flag_compatibility(
    tmp_path, lane, requested, supports_groups, feature
):
    # Execute the actual workflow guard against both parser generations. An
    # unconditional new CLI option used to make a supported old SHA undeployable.
    bash = shutil.which("bash")
    if sys.platform == "win32":
        git = shutil.which("git")
        candidate = Path(git).resolve().parents[1] / "bin/bash.exe" if git else None
        bash = str(candidate) if candidate and candidate.is_file() else None
    if not bash:
        pytest.skip("The deployment shell compatibility test requires bash")
    workflow_lane = "uat" if feature == "period-packets-enabled" else lane
    workflow = (ROOT / f".github/workflows/deploy-{workflow_lane}.yml").read_text(encoding="utf-8")
    variable = (
        "drive_period_packet_args" if feature == "period-packets-enabled" else "drive_group_args"
    )
    guard = re.search(rf"(?ms)^ +{variable}=\(\)\n.*?^ +fi$", workflow)
    assert guard is not None
    script = tmp_path / "scripts/ops/sync_backend_runtime_secrets.py"
    script.parent.mkdir(parents=True)
    script.write_text(
        "import argparse,json\np=argparse.ArgumentParser()\n"
        + (
            f'p.add_argument("--drive-{feature}", choices=["true","false"])\n'
            if supports_groups
            else ""
        )
        + "print(json.dumps(vars(p.parse_args())))\n",
        encoding="utf-8",
    )
    # GitHub renders this expression before handing the step to Bash. Exercise
    # both UAT values without accessing or changing any repository variable.
    rendered_guard = guard[0].replace(
        "${{ vars.DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED || 'false' }}", requested
    )
    command = (
        "set -euo pipefail\n"
        + f'UAT_DRIVE_PERIOD_PACKETS_ENABLED="{requested}"\n'
        + rendered_guard
        # Bash 3's nounset treats an empty array as unset; the hosted Bash 5
        # expands it to zero arguments. Preserve that call shape on both hosts.
        + f'\nif [ "${{#{variable}[@]}}" -eq 0 ]; then\n'
        + '  "$COMPAT_PYTHON" scripts/ops/sync_backend_runtime_secrets.py\n'
        + "else\n"
        + f'  "$COMPAT_PYTHON" scripts/ops/sync_backend_runtime_secrets.py "${{{variable}[@]}}"\n'
        + "fi\n"
    )
    import os

    result = subprocess.run(  # noqa: S603 - actual authored workflow guard and synthetic local parser
        [bash, "-c", command],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "COMPAT_PYTHON": sys.executable},
        timeout=10,
    )
    assert json.loads(result.stdout) == (
        {f"drive_{feature.replace('-', '_')}": requested} if supports_groups else {}
    )


@pytest.mark.parametrize("environment", ["production", "dev", "local", "test"])
def test_hosted_connector_rollout_is_limited_to_uat(environment):
    module = _module()
    with pytest.raises(ValueError, match="limited to UAT"):
        module._validate_connector_rollout(_args(environment=environment, cohort="owner-a"))
    with pytest.raises(ValueError, match="limited to UAT"):
        module._validate_connector_rollout(
            _args(environment=environment, cohort="owner-a", google_drive_connection="true")
        )
    with pytest.raises(ValueError, match="limited to UAT"):
        module._validate_connector_rollout(_args(environment=environment, all_users="true"))


def test_production_drive_requires_explicit_production_audience():
    module = _module()
    module._validate_connector_rollout(
        _args(
            environment="production",
            prod_all_users="true",
            candidate_secret=CANDIDATE_SECRET_NAME,
            google_drive_live="true",
        )
    )
    with pytest.raises(ValueError, match="per-release candidate secret"):
        module._validate_connector_rollout(
            _args(
                environment="production",
                prod_all_users="true",
                candidate_secret=CANDIDATE_SECRET_NAME.removesuffix("_1"),
                google_drive_live="true",
            )
        )
    with pytest.raises(ValueError, match="production project"):
        module._validate_connector_rollout(
            _args(
                environment="production",
                project="hushh-pda-uat",
                prod_all_users="true",
                candidate_secret=CANDIDATE_SECRET_NAME,
                google_drive_live="true",
            )
        )
    with pytest.raises(ValueError, match="lane-specific cohort or all-users"):
        module._validate_connector_rollout(
            _args(
                environment="production",
                candidate_secret=CANDIDATE_SECRET_NAME,
                google_drive_live="true",
            )
        )
    with pytest.raises(ValueError, match="limited to production"):
        module._validate_connector_rollout(
            _args(environment="uat", prod_all_users="true", google_drive_live="true")
        )
    with pytest.raises(ValueError, match="cannot be combined"):
        module._validate_connector_rollout(
            _args(
                environment="production",
                prod_all_users="true",
                prod_cohort="owner-a",
                candidate_secret=CANDIDATE_SECRET_NAME,
                google_drive_live="true",
            )
        )


def test_production_candidate_config_never_opens_canonical_serving_secret():
    module = _module()
    args = _args(
        environment="production",
        prod_all_users="true",
        candidate_secret=CANDIDATE_SECRET_NAME,
        google_drive_live="true",
        drive_document_sharing="true",
    )
    canonical, candidate = module._split_production_drive_candidate_config(
        args,
        {
            "google_drive_live": "true",
            "drive_document_sharing": "true",
            "connector_production_all_users": "true",
            "environment": "production",
        },
    )
    assert candidate and candidate["google_drive_live"] == "true"
    assert candidate["connector_production_all_users"] == "true"
    assert canonical is None
    disabled_args = _args(environment="production")
    canonical, candidate = module._split_production_drive_candidate_config(
        disabled_args, {"google_drive_live": "false", "environment": "production"}
    )
    assert canonical == {"google_drive_live": "false", "environment": "production"}
    assert candidate is None
    disabled_args.production_drive_candidate_secret = CANDIDATE_SECRET_NAME
    canonical, candidate = module._split_production_drive_candidate_config(
        disabled_args,
        {"google_drive_live": "false", "environment": "production"},
    )
    assert canonical is None
    assert candidate == {"google_drive_live": "false", "environment": "production"}
    with pytest.raises(ValueError, match="per-release candidate secret"):
        module._validate_connector_rollout(
            _args(environment="production", candidate_secret="unreviewed-secret")  # noqa: S106
        )


def test_all_users_mode_cannot_be_combined_with_cohort():
    with pytest.raises(ValueError, match="cannot be combined"):
        _module()._validate_connector_rollout(
            _args(cohort="owner-a", all_users="true", google_drive_connection="true")
        )


@pytest.mark.parametrize("value", ["", "all", "1", "enabled"])
def test_malformed_all_users_mode_is_rejected(value):
    with pytest.raises(ValueError, match="must be true or false"):
        _module()._validate_connector_rollout(_args(all_users=value))


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
        "UAT_CURATED_MCP_CONNECTORS": ("CURATED_MCP_CONNECTORS_UAT", "--curated-mcp-connectors"),
    }
    for env_name, (variable, argument) in expected.items():
        assert f"{env_name}: ${{{{ vars.{variable} || 'false' }}}}" in step
        assert f'{argument} "${env_name}"' in step
    assert (
        "UAT_CONNECTOR_INTERNAL_OWNER_COHORT: ${{ vars.CONNECTOR_INTERNAL_OWNER_COHORT_UAT || '' }}"
    ) in step
    assert '--connector-internal-owner-cohort "$UAT_CONNECTOR_INTERNAL_OWNER_COHORT"' in step
    assert ("UAT_CONNECTOR_ALL_USERS: ${{ vars.CONNECTOR_UAT_ALL_USERS_UAT || 'false' }}") in step
    assert '--connector-uat-all-users "$UAT_CONNECTOR_ALL_USERS"' in step
    assert "_validate_connector_rollout(args)" in SCRIPT.read_text(encoding="utf-8")


def test_uat_backend_deploy_reconciles_drive_redirects_after_migrations():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    step = workflow.split("- name: Apply UAT DB migrations behind account deletion fence", 1)[
        1
    ].split("- name: ", 1)[0]
    assert "if: steps.scope.outputs.deploy_backend == 'true'" in step
    assert "export HUSSH_RELEASE_ENVIRONMENT=uat" in step
    assert 'export CLOUDSQL_INSTANCE_CONNECTION_NAME="${UAT_CLOUDSQL_INSTANCE}"' in step
    migration = step.index("db/migrate.py --release")
    activation = step.index("reconcile_google_drive_uat_connector.py --activate")
    verification = step.index("reconcile_google_drive_uat_connector.py\n")
    release_guard = step.index("db_migration_release_guard.py")
    assert migration < activation < verification < release_guard
