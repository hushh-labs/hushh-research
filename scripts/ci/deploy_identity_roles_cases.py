"""Shared custom-role fixtures and drift cases for the mandatory IAM owner test."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RECORD = REPO_ROOT / "deploy" / "iam" / "setup_production_github_wif.sh"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-production.yml"


def _module():
    path = Path(__file__).with_name("verify-deploy-identity-provenance.py")
    spec = importlib.util.spec_from_file_location(
        "verify_deploy_identity_provenance", path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _module()
REAL = MOD.load_record(RECORD)


def _args(**overrides) -> argparse.Namespace:
    base = {
        "record": str(RECORD),
        "workflow": str(WORKFLOW),
        "record_only": True,
        "provider_json": "",
        "iam_policy_json": "",
        "custom_role_json": "",
        "scheduler_role_json": "",
        "report_path": "",
    }
    base.update(overrides)
    return argparse.Namespace(**base)


def _live_provider() -> dict:
    return {
        "attributeCondition": REAL["ATTRIBUTE_CONDITION"],
        "attributeMapping": MOD.mapping_pairs(REAL["ATTRIBUTE_MAPPING"]),
        "oidc": {"issuerUri": MOD.GITHUB_ISSUER},
        "state": "ACTIVE",
    }


def _live_policy() -> dict:
    member = f"serviceAccount:{REAL['DEPLOY_SERVICE_ACCOUNT_EMAIL']}"
    return {
        "bindings": [
            {"role": role, "members": [member]} for role in REAL["DEPLOY_PROJECT_ROLES"]
        ]
    }


def _live_custom_role() -> dict:
    return {
        "name": REAL["PREREQUISITE_READ_ROLE"],
        "includedPermissions": list(REAL["PREREQUISITE_READ_PERMISSIONS"]),
        "stage": REAL["PREREQUISITE_READ_ROLE_STAGE"],
    }


def _live_scheduler_role() -> dict:
    return {
        "name": REAL["CLEANUP_SCHEDULER_ROLE"],
        "includedPermissions": list(REAL["CLEANUP_SCHEDULER_PERMISSIONS"]),
        "stage": REAL["CLEANUP_SCHEDULER_ROLE_STAGE"],
    }


def _verify_with(
    provider: dict,
    policy: dict,
    custom_role: dict | None = None,
    *,
    scheduler_role=None,
) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        provider_path = Path(tmp) / "provider.json"
        policy_path = Path(tmp) / "policy.json"
        role_path = Path(tmp) / "custom-role.json"
        scheduler_path = Path(tmp) / "scheduler-role.json"
        provider_path.write_text(json.dumps(provider), encoding="utf-8")
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        role_path.write_text(
            json.dumps(_live_custom_role() if custom_role is None else custom_role),
            encoding="utf-8",
        )
        scheduler_path.write_text(
            json.dumps(
                _live_scheduler_role() if scheduler_role is None else scheduler_role
            )
        )
        return MOD.verify(
            _args(
                record_only=False,
                provider_json=str(provider_path),
                iam_policy_json=str(policy_path),
                custom_role_json=str(role_path),
                scheduler_role_json=str(scheduler_path),
            )
        )


def _reasons(report: dict) -> set[str]:
    return {failure["reason"] for failure in report["failures"]}


def test_drive_prerequisite_record_closes_only_the_three_missing_reads() -> None:
    assert REAL["PREREQUISITE_READ_ROLE"] == (
        "projects/hushh-pda/roles/productionDrivePrerequisiteReader"
    )
    assert REAL["DEPLOY_PROJECT_ROLES"].count(REAL["PREREQUISITE_READ_ROLE"]) == 1
    assert set(REAL["PREREQUISITE_READ_PERMISSIONS"]) == {
        "apikeys.keys.list",
        "apikeys.keys.getKeyString",
        "resourcemanager.projects.getIamPolicy",
    }
    assert len(REAL["PREREQUISITE_READ_PERMISSIONS"]) == 3
    assert REAL["PREREQUISITE_READ_ROLE_STAGE"] == "GA"
    assert MOD.verify(_args())["expected"]["prerequisiteReadRole"]["stage"] == "GA"


def test_custom_reader_record_cannot_grant_write_authority() -> None:
    widened = {
        **REAL,
        "PREREQUISITE_READ_PERMISSIONS": ["resourcemanager.projects.setIamPolicy"],
    }
    assert "prerequisite_read_role_record_invalid" in {
        failure["reason"] for failure in MOD.audit_record(widened, None)
    }


def test_custom_reader_record_requires_an_active_stage() -> None:
    for stage in (None, "UNKNOWN", "DISABLED", {}, False):
        changed = {**REAL, "PREREQUISITE_READ_ROLE_STAGE": stage}
        assert "prerequisite_read_role_record_invalid" in {
            failure["reason"] for failure in MOD.audit_record(changed, None)
        }


def _run_role_setup(list_exit: int, names: str, *, cleanup=False):
    # Execute the real setup function with a shell-local CLI stub, never gcloud.
    declarations = RECORD.read_text().split("command -v gcloud", 1)[0]
    stub = """
gcloud() {
  printf '%s\n' "$*" >> "${ROLE_TEST_CALL_LOG}"
  case "$1 $2 $3" in
    'iam roles list')
      printf '%s' "${ROLE_TEST_NAMES}"
      printf 'private-cloud-error-canary' >&2
      return "${ROLE_TEST_LIST_EXIT}" ;;
    'iam roles create'|'iam roles update') return 0 ;;
    *) return 99 ;;
  esac
}
"${ROLE_TEST_FUNCTION}"
"""
    with tempfile.TemporaryDirectory() as tmp:
        calls = Path(tmp) / "calls"
        result = subprocess.run(  # noqa: S603 -- real function, fixed shell-local fake CLI.
            ["/bin/bash"],
            input=declarations + stub,
            text=True,
            capture_output=True,
            timeout=5,
            env={
                **os.environ,
                "ROLE_TEST_CALL_LOG": str(calls),
                "ROLE_TEST_NAMES": names,
                "ROLE_TEST_LIST_EXIT": str(list_exit),
                "ROLE_TEST_FUNCTION": "configure_cleanup_scheduler_role"
                if cleanup
                else "configure_prerequisite_read_role",
            },
            check=False,
        )
        return result, calls.read_text().splitlines()


def test_role_setup_distinguishes_missing_existing_and_unavailable_metadata() -> None:
    role = REAL["PREREQUISITE_READ_ROLE"]
    for list_exit, names, action in (
        (0, "", "create"),
        (0, role, "update"),
        (1, "", ""),
    ):
        result, calls = _run_role_setup(list_exit, names)
        assert (
            calls[0]
            == f"iam roles list --project=hushh-pda --filter=name={role} --format=value(name)"
        )
        assert result.returncode == (0 if action else 1)
        if action:
            assert len(calls) == 2
            assert calls[1].startswith(
                f"iam roles {action} {REAL['PREREQUISITE_READ_ROLE_ID']} "
            )
            assert (
                "--permissions=" + ",".join(REAL["PREREQUISITE_READ_PERMISSIONS"])
                in calls[1]
            )
            assert "--project=hushh-pda" in calls[1]
            assert "--stage=" + REAL["PREREQUISITE_READ_ROLE_STAGE"] in calls[1]
        else:
            assert len(calls) == 1
            assert (
                result.stderr.strip()
                == "Unable to inspect the production prerequisite read role."
            )
        assert "private-cloud-error-canary" not in result.stderr


def test_live_custom_role_read_uses_the_recorded_project_and_role() -> None:
    calls = []

    def read(args):
        calls.append(args)
        if args[:2] == ["iam", "roles"]:
            return (
                _live_scheduler_role()
                if args[3] == REAL["CLEANUP_SCHEDULER_ROLE_ID"]
                else _live_custom_role()
            )
        return _live_policy() if args[0] == "projects" else _live_provider()

    original = MOD._gcloud_json
    MOD._gcloud_json = read
    try:
        assert MOD.verify(_args(record_only=False))["ok"] is True
    finally:
        MOD._gcloud_json = original
    assert len(calls) == 4
    assert calls[-1] == [
        "iam",
        "roles",
        "describe",
        REAL["CLEANUP_SCHEDULER_ROLE_ID"],
        f"--project={REAL['PROD_PROJECT_ID']}",
    ]


def test_missing_or_inactive_custom_role_never_passes() -> None:
    without_stage = _live_custom_role()
    del without_stage["stage"]
    for changed, reason in (
        ({}, "prerequisite_read_role_missing_or_mismatched"),
        (
            {"name": "projects/other/roles/reader"},
            "prerequisite_read_role_missing_or_mismatched",
        ),
        ({**_live_custom_role(), "deleted": True}, "prerequisite_read_role_inactive"),
        (
            {**_live_custom_role(), "stage": "DISABLED"},
            "prerequisite_read_role_inactive",
        ),
        (without_stage, "prerequisite_read_role_stage_drift"),
        *(
            (
                {**_live_custom_role(), "stage": stage},
                "prerequisite_read_role_stage_drift",
            )
            for stage in (None, "UNKNOWN", {}, "ALPHA")
        ),
    ):
        report = _verify_with(_live_provider(), _live_policy(), changed)
        assert report["ok"] is False
        assert reason in _reasons(report)


def test_custom_role_missing_or_extra_permission_is_caught() -> None:
    expected = REAL["PREREQUISITE_READ_PERMISSIONS"]
    for permissions in (
        *(list(set(expected) - {permission}) for permission in expected),
        [*expected, "resourcemanager.projects.setIamPolicy"],
    ):
        report = _verify_with(
            _live_provider(),
            _live_policy(),
            {**_live_custom_role(), "includedPermissions": permissions},
        )
        assert report["ok"] is False
        assert "prerequisite_read_role_permissions_drift" in _reasons(report)


def test_cleanup_scheduler_existing_role_has_exact_authority_and_setup() -> None:
    assert (
        REAL["CLEANUP_SCHEDULER_ROLE"]
        == "projects/hushh-pda/roles/accountDeletionSchedulerOperator"
    )
    assert len(REAL["CLEANUP_SCHEDULER_PERMISSIONS"]) == 8
    assert set(REAL["CLEANUP_SCHEDULER_PERMISSIONS"]) == {
        "cloudscheduler.jobs." + verb
        for verb in ("create", "enable", "get", "list", "pause", "run", "update")
    } | {"cloudscheduler.locations.list"}
    assert (
        MOD.verify(_args())["expected"]["cleanupSchedulerRole"]
        == _live_scheduler_role()
    )
    for names, action in (("", "create"), (REAL["CLEANUP_SCHEDULER_ROLE"], "update")):
        result, calls = _run_role_setup(0, names, cleanup=True)
        assert result.returncode == 0 and len(calls) == 2
        assert calls[1].startswith(
            f"iam roles {action} {REAL['CLEANUP_SCHEDULER_ROLE_ID']} "
        )
        assert (
            "--permissions=" + ",".join(REAL["CLEANUP_SCHEDULER_PERMISSIONS"])
            in calls[1]
        )
        assert "--stage=GA" in calls[1] and "--project=hushh-pda" in calls[1]
    result, calls = _run_role_setup(1, "", cleanup=True)
    assert result.returncode == 1 and len(calls) == 1
    assert "private-cloud-error-canary" not in result.stderr


def test_cleanup_scheduler_drift_or_wrong_principal_never_passes() -> None:
    for defect in (
        None,
        "pause",
        "enable",
        "extra",
        "wrong_principal",
        "additional_principal",
        "condition",
        "missing",
        "stage",
        "deleted",
    ):
        role, policy = _live_scheduler_role(), _live_policy()
        binding = next(
            row
            for row in policy["bindings"]
            if row["role"] == REAL["CLEANUP_SCHEDULER_ROLE"]
        )
        if defect in {"pause", "enable"}:
            role["includedPermissions"].remove("cloudscheduler.jobs." + defect)
        elif defect == "extra":
            role["includedPermissions"].append("cloudscheduler.jobs.delete")
        elif defect == "wrong_principal":
            binding["members"] = [
                "serviceAccount:other@hushh-pda.iam.gserviceaccount.com"
            ]
        elif defect == "additional_principal":
            binding["members"].append(
                "serviceAccount:other@hushh-pda.iam.gserviceaccount.com"
            )
        elif defect == "condition":
            binding["condition"] = {"expression": "false"}
        elif defect == "missing":
            role = {}
        elif defect == "stage":
            role["stage"] = "DISABLED"
        elif defect == "deleted":
            role["deleted"] = True
        report = _verify_with(_live_provider(), policy, scheduler_role=role)
        assert report["ok"] is (defect is None), (defect, report)


def test_cleanup_scheduler_record_rejects_expansion_and_missing_permissions() -> None:
    for permissions in (
        [],
        REAL["CLEANUP_SCHEDULER_PERMISSIONS"][:-1],
        [*REAL["CLEANUP_SCHEDULER_PERMISSIONS"], "cloudscheduler.jobs.delete"],
        [
            permission.replace("jobs.create", "jobs.unreviewed.create")
            for permission in REAL["CLEANUP_SCHEDULER_PERMISSIONS"]
        ],
    ):
        changed = {**REAL, "CLEANUP_SCHEDULER_PERMISSIONS": permissions}
        assert "cleanup_scheduler_role_record_invalid" in {
            failure["reason"] for failure in MOD.audit_record(changed, None)
        }
