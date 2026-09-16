import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SETUP = REPO_ROOT / "deploy/gmail/setup_personal_information_request_monitor_scheduler.sh"
PROJECT = "scheduler-test-project"
BACKEND = "https://backend.example.test"


def _workflow_identity() -> str:
    workflow = yaml.safe_load((REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text())
    return workflow["env"][
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SCHEDULER_SERVICE_ACCOUNT_ID"
    ]


def test_uat_deploy_wires_the_personal_gmail_monitor_identity() -> None:
    workflow = (REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")

    identity = _workflow_identity()
    # The real IAM create contract, rather than an assertion of one chosen name.
    # https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/create
    assert re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", identity)
    assert f"SCHEDULER_SERVICE_ACCOUNT_NAME:-{identity}" in SETUP.read_text()
    assert "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUTH_ENABLED=true" in workflow
    assert (
        "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUDIENCE=${{ env.CONSENT_API_PUBLIC_ORIGIN }}"
    ) in workflow
    assert (
        "_GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SERVICE_ACCOUNT_EMAIL=${{ "
        "env.GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SCHEDULER_SERVICE_ACCOUNT_ID "
        "}}@${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in workflow
    assert "Activate personal Gmail monitor" in workflow
    assert "deploy/gmail/setup_personal_information_request_monitor_scheduler.sh" in workflow


def _run_setup(
    tmp_path: Path,
    *,
    existing_job: bool = False,
    existing_account: bool | None = None,
    **overrides: str,
):
    """Exercise the real shell adapter against strict local CLI contracts."""
    account_exists = existing_job if existing_account is None else existing_account
    state_path = tmp_path / "state.json"
    calls_path = tmp_path / "calls.jsonl"
    state_path.write_text(
        json.dumps(
            {
                "accounts": [f"{_workflow_identity()}@{PROJECT}.iam.gserviceaccount.com"]
                if account_exists
                else [],
                "job": {} if existing_job else None,
            }
        )
    )
    gcloud = tmp_path / "gcloud"
    gcloud.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json, os, re, sys
from pathlib import Path
args = sys.argv[1:]
state_path = Path(os.environ["MOCK_STATE"])
state = json.loads(state_path.read_text())
with Path(os.environ["MOCK_CALLS"]).open("a") as log:
    log.write(json.dumps(args) + "\n")
project = os.environ["PROJECT_ID"]
def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)
if args[:3] == ["iam", "service-accounts", "describe"]:
    sys.exit(0 if args[3] in state["accounts"] else 1)
elif args[:3] == ["iam", "service-accounts", "create"]:
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args[3]):
        fail("IAM account ID violates the 6-30 character RFC1035 contract")
    state["accounts"].append(args[3] + "@" + project + ".iam.gserviceaccount.com")
elif args[:3] == ["scheduler", "jobs", "describe"]:
    if state["job"] is None:
        sys.exit(1)
    if any(arg.startswith("--format=") for arg in args):
        job = state["job"]
        print("\t".join(["ENABLED", job["schedule"], job["uri"], job["http-method"],
                         job["oidc-service-account-email"], job["oidc-token-audience"]]))
elif args[:2] == ["scheduler", "jobs"] and args[2] in ("create", "update"):
    flags = dict(arg[2:].split("=", 1) for arg in args if arg.startswith("--") and "=" in arg)
    header_flag = "headers" if args[2] == "create" else "update-headers"
    if header_flag not in flags or (args[2] == "update" and "headers" in flags):
        fail("Unsupported scheduler header flag for " + args[2])
    state["job"] = flags
else:
    fail("Unexpected gcloud command")
state_path.write_text(json.dumps(state))
"""
    )
    gcloud.chmod(0o755)
    result = subprocess.run(  # noqa: S603 - fixed repo script, isolated local gcloud stub
        ["bash", str(SETUP)],
        env={
            "PATH": f"{tmp_path}{os.pathsep}{os.defpath}",
            "PROJECT_ID": PROJECT,
            "BACKEND_URL": BACKEND,
            "MOCK_STATE": str(state_path),
            "MOCK_CALLS": str(calls_path),
            **overrides,
        },
        text=True,
        capture_output=True,
        check=False,
    )
    calls = (
        [json.loads(line) for line in calls_path.read_text().splitlines()]
        if calls_path.exists()
        else []
    )
    return result, calls, json.loads(state_path.read_text())


def test_scheduler_does_not_mutate_the_client_service_account_policy() -> None:
    setup = SETUP.read_text(encoding="utf-8")
    assert "iam service-accounts add-iam-policy-binding" not in setup
    assert "roles/iam.serviceAccountTokenCreator" not in setup


def test_scheduler_recovers_when_account_exists_but_job_does_not(tmp_path: Path) -> None:
    result, calls, state = _run_setup(
        tmp_path,
        existing_account=True,
        existing_job=False,
    )
    assert result.returncode == 0, result.stderr
    assert not any(call[:3] == ["iam", "service-accounts", "create"] for call in calls)
    assert any(call[:4] == ["scheduler", "jobs", "create", "http"] for call in calls)
    assert state["job"]["oidc-service-account-email"] == (
        f"{_workflow_identity()}@{PROJECT}.iam.gserviceaccount.com"
    )


@pytest.mark.parametrize("existing_job", [False, True])
def test_scheduler_create_and_update_keep_the_same_oidc_identity(tmp_path, existing_job):
    result, calls, state = _run_setup(tmp_path, existing_job=existing_job)
    assert result.returncode == 0, result.stderr
    verb = "update" if existing_job else "create"
    assert any(call[:4] == ["scheduler", "jobs", verb, "http"] for call in calls)
    assert state["job"]["oidc-service-account-email"] == (
        f"{_workflow_identity()}@{PROJECT}.iam.gserviceaccount.com"
    )
    assert state["job"]["oidc-token-audience"] == BACKEND
    assert state["job"]["uri"] == f"{BACKEND}/api/one/email/information-requests/scan-enabled"


def test_email_override_creates_the_requested_account(tmp_path):
    email = f"custom-monitor@{PROJECT}.iam.gserviceaccount.com"
    result, calls, state = _run_setup(tmp_path, SCHEDULER_SERVICE_ACCOUNT_EMAIL=email)
    assert result.returncode == 0, result.stderr
    assert ["iam", "service-accounts", "create", "custom-monitor"] in [call[:4] for call in calls]
    assert state["accounts"] == [email]
    assert state["job"]["oidc-service-account-email"] == email


@pytest.mark.parametrize("identity", ["short", "a" * 31, "invalid_name", "1invalid", "invalid-"])
def test_invalid_account_id_is_rejected_before_any_cloud_call(tmp_path, identity):
    result, calls, _ = _run_setup(tmp_path, SCHEDULER_SERVICE_ACCOUNT_NAME=identity)
    assert result.returncode != 0
    assert "SCHEDULER_SERVICE_ACCOUNT_NAME" in result.stderr
    assert calls == []


@pytest.mark.parametrize("identity", ["a" * 6, "a" * 30])
def test_valid_account_id_length_boundaries(tmp_path, identity):
    result, _, _ = _run_setup(tmp_path, SCHEDULER_SERVICE_ACCOUNT_NAME=identity)
    assert result.returncode == 0, result.stderr


def test_cross_project_email_override_is_rejected_before_any_cloud_call(tmp_path):
    result, calls, _ = _run_setup(
        tmp_path,
        SCHEDULER_SERVICE_ACCOUNT_EMAIL="custom-monitor@another-project.iam.gserviceaccount.com",
    )
    assert result.returncode != 0
    assert "PROJECT_ID" in result.stderr
    assert calls == []
