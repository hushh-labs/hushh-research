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

import argparse
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RECORD = REPO_ROOT / "deploy" / "iam" / "setup_production_github_wif.sh"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-production.yml"


def _module():
    path = Path(__file__).with_name("verify-deploy-identity-provenance.py")
    spec = importlib.util.spec_from_file_location("verify_deploy_identity_provenance", path)
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
        "bindings": [{"role": role, "members": [member]} for role in REAL["DEPLOY_PROJECT_ROLES"]]
    }


def _verify_with(provider: dict, policy: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        provider_path = Path(tmp) / "provider.json"
        policy_path = Path(tmp) / "policy.json"
        provider_path.write_text(json.dumps(provider), encoding="utf-8")
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        return MOD.verify(
            _args(
                record_only=False,
                provider_json=str(provider_path),
                iam_policy_json=str(policy_path),
            )
        )


def _reasons(report: dict) -> set[str]:
    return {failure["reason"] for failure in report["failures"]}


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
    escalated["DEPLOY_PROJECT_ROLES"] = [*REAL["DEPLOY_PROJECT_ROLES"], "roles/iam.securityAdmin"]
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
        raise subprocess.CalledProcessError(1, "gcloud", stderr="PERMISSION_DENIED")

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
    assert "PERMISSION_DENIED" in report["unverifiable"]["detail"]


def test_a_missing_record_fails_loudly() -> None:
    try:
        MOD.verify(_args(record="deploy/iam/does-not-exist.sh"))
    except MOD.RecordError:
        return
    raise AssertionError("a missing record must raise, never yield an empty expectation")


def main() -> int:
    tests = [
        test_the_real_record_parses_and_interpolates,
        test_the_record_as_committed_is_coherent,
        test_dropping_the_ref_clause_is_caught,
        test_a_condition_for_another_environment_is_caught,
        test_a_workflow_that_requests_a_different_environment_is_caught,
        test_a_deploy_role_that_can_grant_authority_is_caught,
        test_a_mapping_without_the_bound_attribute_is_caught,
        test_a_matching_provider_and_policy_pass,
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
