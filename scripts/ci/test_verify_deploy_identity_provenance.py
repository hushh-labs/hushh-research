#!/usr/bin/env python3
# ruff: noqa: S101
"""The deploy-identity detector must fail on the drifts it was built to catch.

Runnable as a plain script (`python3 scripts/ci/test_verify_deploy_identity_provenance.py`)
because that is the idiom `scripts/ci/repo-governance-check.sh` actually executes.
The pytest-style files next to it in this directory are never run by anything -- a
test that cannot run is the same defect as a remediation with no detector, which is
the very gap the module under test exists to close.

Every case below drives the REAL record file, not a fabricated one. A fixture copy
of the setup script would pass forever while the real record drifted underneath it.
"""

from __future__ import annotations

import json
import subprocess

from deploy_identity_roles_cases import (
    test_cleanup_scheduler_existing_role_has_exact_authority_and_setup,
    test_cleanup_scheduler_drift_or_wrong_principal_never_passes,
    test_cleanup_scheduler_record_rejects_expansion_and_missing_permissions,
    MOD as MOD,
    REAL as REAL,
    RECORD as RECORD,
    REPO_ROOT as REPO_ROOT,
    WORKFLOW as WORKFLOW,
    _args as _args,
    _live_provider as _live_provider,
    _live_policy as _live_policy,
    _live_custom_role as _live_custom_role,
    _verify_with as _verify_with,
    _reasons as _reasons,
    test_drive_prerequisite_record_closes_only_the_three_missing_reads as test_drive_prerequisite_record_closes_only_the_three_missing_reads,
    test_custom_reader_record_cannot_grant_write_authority as test_custom_reader_record_cannot_grant_write_authority,
    test_custom_reader_record_requires_an_active_stage as test_custom_reader_record_requires_an_active_stage,
    _run_role_setup as _run_role_setup,
    test_role_setup_distinguishes_missing_existing_and_unavailable_metadata as test_role_setup_distinguishes_missing_existing_and_unavailable_metadata,
    test_live_custom_role_read_uses_the_recorded_project_and_role as test_live_custom_role_read_uses_the_recorded_project_and_role,
    test_missing_or_inactive_custom_role_never_passes as test_missing_or_inactive_custom_role_never_passes,
    test_custom_role_missing_or_extra_permission_is_caught as test_custom_role_missing_or_extra_permission_is_caught,
)


# -- the record is read, not retyped ---------------------------------------------------


def test_the_real_record_parses_and_interpolates() -> None:
    """If this breaks, every expectation below is silently empty."""
    assert REAL["PROD_PROJECT_ID"] == "hushh-pda"
    assert "${" not in REAL["DEPLOY_SERVICE_ACCOUNT_EMAIL"], (
        "an unresolved ${...} reached the expectation; the record reader stopped "
        "understanding the form the script uses"
    )
    assert REAL["DEPLOY_SERVICE_ACCOUNT_EMAIL"].endswith("@hushh-pda.iam.gserviceaccount.com")
    assert "roles/run.admin" in REAL["DEPLOY_PROJECT_ROLES"]
    assert len(REAL["DEPLOY_PROJECT_ROLES"]) >= 6


def test_the_record_as_committed_is_coherent() -> None:
    """The offline half must be green against the real files, or it is noise."""
    report = MOD.verify(_args())
    assert report["ok"], f"the committed record fails its own invariants: {report['failures']}"
    assert report["record_checked"] and not report["live_checked"]


def test_record_only_never_reads_cloud_authority() -> None:
    def refuse(_args):
        raise AssertionError("Record-only attempted a cloud read")

    original = MOD._gcloud_json
    MOD._gcloud_json = refuse
    try:
        assert MOD.verify(_args())["ok"] is True
    finally:
        MOD._gcloud_json = original


# -- the drift each check exists to catch ----------------------------------------------


def test_dropping_the_ref_clause_is_caught() -> None:
    """The single highest-consequence widening: still named, no longer pinned."""
    widened = dict(REAL)
    widened["ATTRIBUTE_CONDITION"] = (
        "assertion.sub == 'repo:hushh-labs/hushh-research:environment:production'"
    )
    assert "condition_does_not_pin_a_ref" in {f["reason"] for f in MOD.audit_record(widened, None)}


def test_a_condition_for_another_environment_is_caught() -> None:
    renamed = dict(REAL)
    renamed["GITHUB_ENVIRONMENT"] = "prod"
    assert "condition_subject_disagrees_with_record" in {
        f["reason"] for f in MOD.audit_record(renamed, None)
    }


def test_a_workflow_that_requests_a_different_environment_is_caught() -> None:
    reasons = {
        f["reason"] for f in MOD.audit_record(REAL, "jobs:\n  deploy:\n    environment: staging\n")
    }
    assert "workflow_environment_disagrees_with_record" in reasons


def test_a_deploy_role_that_can_grant_authority_is_caught() -> None:
    escalated = dict(REAL)
    escalated["DEPLOY_PROJECT_ROLES"] = [
        *REAL["DEPLOY_PROJECT_ROLES"],
        "roles/iam.securityAdmin",
    ]
    assert "deploy_role_can_grant_authority" in {
        f["reason"] for f in MOD.audit_record(escalated, None)
    }


def test_a_mapping_without_the_bound_attribute_is_caught() -> None:
    unmapped = dict(REAL)
    unmapped["ATTRIBUTE_MAPPING"] = "google.subject=assertion.sub"
    assert "mapping_drops_an_attribute_the_binding_consumes" in {
        f["reason"] for f in MOD.audit_record(unmapped, None)
    }


# -- live comparison -------------------------------------------------------------------


def test_a_matching_provider_and_policy_pass() -> None:
    report = _verify_with(_live_provider(), _live_policy())
    assert report["ok"], report["failures"]
    assert report["live_checked"]


def test_existing_production_release_workloads_have_recorded_authority() -> None:
    """Regression: the live release account failed admission on its existing gates.

    These independently observed bindings serve SQL migration, backup posture,
    optional backup creation, and cleanup Scheduler activation/log evidence.
    They must be declared by the one grant record, not exempted by the detector.
    The privilege-creep negative control below still rejects any undeclared role.
    """
    policy = _live_policy()
    member = f"serviceAccount:{REAL['DEPLOY_SERVICE_ACCOUNT_EMAIL']}"
    for role in (
        "roles/cloudsql.client",
        "roles/cloudsql.viewer",
        "roles/logging.viewer",
        "projects/hushh-pda/roles/accountDeletionSchedulerOperator",
        "projects/hushh-pda/roles/predeployBackupOperator",
    ):
        if not any(binding["role"] == role for binding in policy["bindings"]):
            policy["bindings"].append({"role": role, "members": [member]})
    report = _verify_with(_live_provider(), policy)
    assert report["ok"], report["failures"]


def test_a_console_edited_condition_is_caught() -> None:
    """The console is the way this actually drifts: edited live, never in the record."""
    provider = _live_provider()
    provider["attributeCondition"] = "assertion.repository == 'hushh-labs/hushh-research'"
    assert "provider_condition_drift" in _reasons(_verify_with(provider, _live_policy()))


def test_a_swapped_issuer_is_caught() -> None:
    provider = _live_provider()
    provider["oidc"] = {"issuerUri": "https://token.example.invalid"}
    assert "provider_issuer_drift" in _reasons(_verify_with(provider, _live_policy()))


def test_privilege_creep_on_the_deploy_account_is_caught() -> None:
    """Nothing breaks when a role is ADDED, so nothing else would ever surface it."""
    policy = _live_policy()
    policy["bindings"].append(
        {
            "role": "roles/owner",
            "members": [f"serviceAccount:{REAL['DEPLOY_SERVICE_ACCOUNT_EMAIL']}"],
        }
    )
    report = _verify_with(_live_provider(), policy)
    assert "deploy_role_granted_outside_the_record" in _reasons(report)


def test_a_revoked_role_is_caught() -> None:
    policy = _live_policy()
    policy["bindings"] = [b for b in policy["bindings"] if b["role"] != "roles/run.admin"]
    report = _verify_with(_live_provider(), policy)
    assert "deploy_role_missing" in _reasons(report)


# -- honest degradation ----------------------------------------------------------------


def test_a_refused_read_is_never_reported_as_a_pass() -> None:
    """The lane's identity may deploy, not read IAM. That must not read as green."""

    def _refuse(_args):
        raise subprocess.CalledProcessError(
            1, "gcloud", stderr="PERMISSION_DENIED private-cloud-error-canary"
        )

    original = MOD._gcloud_json
    MOD._gcloud_json = _refuse
    try:
        report = MOD.verify(_args(record_only=False))
    finally:
        MOD._gcloud_json = original

    assert report["ok"] is False, (
        "a refused live read reported ok. 'I could not look' must never be recorded "
        "as 'I looked and it was fine' -- that is the failure mode this whole file "
        "exists to prevent, one layer up."
    )
    assert report["classifications"] == ["deploy_identity_unverifiable"]
    assert report["live_checked"] is False
    assert report["unverifiable"]["reason"] == "live_read_refused"
    assert report["unverifiable"]["detail"] == (
        "Production deploy identity or custom role could not be read."
    )
    assert "private-cloud-error-canary" not in json.dumps(report)


def test_a_missing_record_fails_loudly() -> None:
    try:
        MOD.verify(_args(record="deploy/iam/does-not-exist.sh"))
    except MOD.RecordError:
        return
    raise AssertionError("a missing record must raise, never yield an empty expectation")


def test_backup_monitor_uses_production_main_and_read_only_identity() -> None:
    # Governance runs with the runner's plain Python, before project dependency
    # installation. Keep this source-contract check standard-library-only.
    workflow = (REPO_ROOT / ".github/workflows/prod-cloudsql-backup-posture.yml").read_text()
    lines = {line.strip() for line in workflow.splitlines()}
    assert "environment: production" in lines
    assert (
        "if: github.repository == 'hushh-labs/hushh-research' && github.ref == 'refs/heads/main'"
        in lines
    )
    assert "service_account: ${{ vars.GCP_BACKUP_SERVICE_ACCOUNT }}" in lines
    assert any(line.startswith("uses: google-github-actions/auth@") for line in lines)
    assert any(line.startswith("uses: google-github-actions/setup-gcloud@") for line in lines)
    assert MOD.audit_record(REAL, workflow) == []
    setup = (REPO_ROOT / "deploy/iam/setup_production_backup_wif.sh").read_text()
    assert "readonly PERMISSIONS=cloudsql.instances.get,cloudsql.backupRuns.list" in setup
    assert "--env=production" in setup
    assert "verify-deploy-identity-provenance.py" in setup
    assert "roles/cloudsql.client" not in setup
    assert "service-accounts keys create" not in setup


def main() -> int:
    tests = [
        test_cleanup_scheduler_existing_role_has_exact_authority_and_setup,
        test_cleanup_scheduler_drift_or_wrong_principal_never_passes,
        test_cleanup_scheduler_record_rejects_expansion_and_missing_permissions,
        test_backup_monitor_uses_production_main_and_read_only_identity,
        test_the_real_record_parses_and_interpolates,
        test_the_record_as_committed_is_coherent,
        test_record_only_never_reads_cloud_authority,
        test_dropping_the_ref_clause_is_caught,
        test_a_condition_for_another_environment_is_caught,
        test_a_workflow_that_requests_a_different_environment_is_caught,
        test_a_deploy_role_that_can_grant_authority_is_caught,
        test_a_mapping_without_the_bound_attribute_is_caught,
        test_a_matching_provider_and_policy_pass,
        test_existing_production_release_workloads_have_recorded_authority,
        test_drive_prerequisite_record_closes_only_the_three_missing_reads,
        test_custom_reader_record_cannot_grant_write_authority,
        test_custom_reader_record_requires_an_active_stage,
        test_role_setup_distinguishes_missing_existing_and_unavailable_metadata,
        test_live_custom_role_read_uses_the_recorded_project_and_role,
        test_missing_or_inactive_custom_role_never_passes,
        test_custom_role_missing_or_extra_permission_is_caught,
        test_a_console_edited_condition_is_caught,
        test_a_swapped_issuer_is_caught,
        test_privilege_creep_on_the_deploy_account_is_caught,
        test_a_revoked_role_is_caught,
        test_a_refused_read_is_never_reported_as_a_pass,
        test_a_missing_record_fails_loudly,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
