"""Keep the scheduled-mail scheduler UAT-only, OIDC-only and pinned to its drain."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "gmail" / "setup_scheduled_mail_scheduler.sh"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
URI = "https://api.uat.hushh.ai/api/one/email/scheduled/drain?limit=50"
SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda-uat.iam.gserviceaccount.com"


def _run_scheduler_with(tmp_path: Path, **overrides: str) -> subprocess.CompletedProcess[str]:
    """Run the real script with a gcloud stand-in that records any call."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    calls = tmp_path / "gcloud-calls"
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{calls}"\nexit 97\n')
    fake_gcloud.chmod(0o755)
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_URL": "https://api.uat.hushh.ai",
            "OIDC_AUDIENCE": "https://api.uat.hushh.ai",
            **overrides,
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )
    result.gcloud_calls = calls.read_text() if calls.exists() else ""  # type: ignore[attr-defined]
    return result


# A gcloud stand-in that keeps one job's state in a file, so the script's own
# describe/pause/resume decisions run for real.
_STATEFUL_GCLOUD = """
import os
import pathlib
import sys

args = sys.argv[1:]
state_file = pathlib.Path(os.environ["FAKE_JOB_STATE"])
with open(os.environ["FAKE_GCLOUD_CALLS"], "a") as calls:
    calls.write(" ".join(args[:3]) + "\\n")
if args[:2] == ["iam", "service-accounts"]:
    sys.exit(0)
verb = args[2]
state = state_file.read_text() if state_file.exists() else ""
if verb == "describe":
    if not state:
        sys.exit(1)
    if "--format=value(state)" in args:
        print(state)
    else:
        print("\\t".join([state, *os.environ["FAKE_JOB_EVIDENCE"].split("|")]))
elif verb == "create":
    state_file.write_text("ENABLED")
elif verb == "update" and not state:
    sys.exit(1)
elif verb == "pause" and os.environ["FAKE_PAUSE_TAKES"] == "1":
    state_file.write_text("PAUSED")
elif verb == "resume":
    state_file.write_text("ENABLED")
"""


def _run_scheduler_against(
    tmp_path: Path, *, job_state: str | None, enabled: str, pause_takes: bool = True
) -> tuple[subprocess.CompletedProcess[str], list[str], str | None]:
    """Run the real script against a stateful gcloud; return its verbs and final state."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    state = tmp_path / "job-state"
    calls = tmp_path / "gcloud-calls"
    if job_state is not None:
        state.write_text(job_state)
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f"#!{sys.executable}\n{_STATEFUL_GCLOUD}")
    fake_gcloud.chmod(0o755)
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_URL": "https://api.uat.hushh.ai",
            "OIDC_AUDIENCE": "https://api.uat.hushh.ai",
            "MAIL_SCHEDULED_DRAIN_ENABLED": enabled,
            "FAKE_JOB_STATE": str(state),
            "FAKE_GCLOUD_CALLS": str(calls),
            "FAKE_PAUSE_TAKES": "1" if pause_takes else "0",
            "FAKE_JOB_EVIDENCE": "|".join(
                ["* * * * *", URI, "POST", SERVICE_ACCOUNT, "https://api.uat.hushh.ai"]
            ),
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)], env=environment, capture_output=True, check=False, text=True
    )
    lines = calls.read_text().splitlines() if calls.exists() else []
    verbs = [line.split()[2] for line in lines if line.startswith("scheduler jobs ")]
    return result, verbs, state.read_text() if state.exists() else None


@pytest.mark.parametrize("enabled", ["false", "", "TRUE"])
def test_kill_switch_pauses_an_existing_job_and_never_rearms_it(tmp_path: Path, enabled: str):
    result, verbs, final = _run_scheduler_against(tmp_path, job_state="ENABLED", enabled=enabled)

    assert result.returncode == 0, result.stderr
    assert "pause" in verbs
    assert not {"create", "update", "resume"} & set(verbs)
    assert final == "PAUSED"


def test_kill_switch_never_creates_a_missing_job(tmp_path: Path):
    result, verbs, final = _run_scheduler_against(tmp_path, job_state=None, enabled="false")

    assert result.returncode == 0, result.stderr
    assert verbs == ["describe"] and final is None


def test_kill_switch_fails_the_deploy_when_the_job_does_not_pause(tmp_path: Path):
    result, _verbs, final = _run_scheduler_against(
        tmp_path, job_state="ENABLED", enabled="false", pause_takes=False
    )

    assert result.returncode != 0
    assert "not PAUSED" in result.stderr and final == "ENABLED"


def test_enabled_deploy_resumes_a_manually_paused_job(tmp_path: Path):
    """The repository variable, not a manual pause, is the source of truth."""
    result, verbs, final = _run_scheduler_against(tmp_path, job_state="PAUSED", enabled="true")

    assert result.returncode == 0, result.stderr
    assert "update" in verbs and "resume" in verbs and "create" not in verbs
    assert final == "ENABLED"


def test_script_is_executable_and_never_mutates_runtime_iam():
    source = SCRIPT.read_text(encoding="utf-8")

    assert SCRIPT.stat().st_mode & stat.S_IXUSR
    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly UAT_BACKEND_ORIGIN="https://api.uat.hushh.ai"' in source
    assert 'URI="${BACKEND_URL}/api/one/email/scheduled/drain?limit=${BATCH_LIMIT}"' in source
    assert "--oidc-service-account-email" in source and "--oidc-token-audience" in source
    assert "roles/iam.serviceAccountTokenCreator" not in source
    assert "add-iam-policy-binding" not in source
    assert "run services update" not in source


def test_dry_run_prints_the_exact_oidc_job_without_calling_gcloud(tmp_path: Path):
    result = _run_scheduler_with(tmp_path, DRY_RUN="1")

    assert result.returncode == 0, result.stderr
    assert result.gcloud_calls == ""  # type: ignore[attr-defined]
    lines = [line for line in result.stdout.splitlines() if line.startswith("+ ")]
    assert [line.split()[1:5] for line in lines] == [
        ["gcloud", "iam", "service-accounts", "create"],
        ["gcloud", "scheduler", "jobs", "update"],
        ["gcloud", "scheduler", "jobs", "create"],
        ["gcloud", "scheduler", "jobs", "resume"],
    ]
    for job in lines[1:3]:
        assert " mail-scheduled-send-uat " in job
        assert "'--schedule=* * * * *'" in job
        assert f"'--uri={URI}'" in job
        assert "--http-method=POST" in job
        assert f"--oidc-service-account-email={SERVICE_ACCOUNT}" in job
        assert "--oidc-token-audience=https://api.uat.hushh.ai" in job
        assert "--time-zone=Etc/UTC" in job
        assert "--attempt-deadline=300s" in job


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"PROJECT_ID": "hushh-pda"}, "limited to hushh-pda-uat"),
        (
            {"BACKEND_URL": "http://api.uat.hushh.ai", "OIDC_AUDIENCE": "http://api.uat.hushh.ai"},
            "must use HTTPS",
        ),
        (
            {"BACKEND_URL": "https://example.invalid", "OIDC_AUDIENCE": "https://example.invalid"},
            "reviewed UAT backend origin",
        ),
        (
            {"OIDC_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"},
            "must exactly match BACKEND_URL",
        ),
        ({"JOB_NAME": "attacker-job"}, "only configures the reviewed UAT scheduled-mail job"),
        ({"CRON": "*/5 * * * *"}, "only configures the reviewed UAT scheduled-mail job"),
        (
            {"SCHEDULER_SERVICE_ACCOUNT_NAME": "drive-work-drain-sched"},
            "only configures the reviewed UAT scheduled-mail job",
        ),
        ({"BATCH_LIMIT": "101"}, "BATCH_LIMIT must be an integer from 1 through 100"),
        ({"DRY_RUN": "yes"}, "DRY_RUN must be 0 or 1"),
    ],
)
def test_script_refuses_unreviewed_targets_before_any_gcloud_call(
    tmp_path: Path, overrides: dict[str, str], message: str
):
    result = _run_scheduler_with(tmp_path, **overrides)

    assert result.returncode != 0
    assert message in result.stderr
    assert result.gcloud_calls == ""  # type: ignore[attr-defined]


def _steps(workflow: Path) -> list[dict]:
    jobs = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]
    return [step for job in jobs.values() for step in job.get("steps", [])]


def test_uat_activates_the_job_only_after_release_classification():
    steps = _steps(UAT_WORKFLOW)
    ids = [step.get("id") for step in steps]
    step = next(step for step in steps if step.get("id") == "activate-scheduled-mail-drain")

    assert ids.index("classify-uat-release") < ids.index("activate-scheduled-mail-drain")
    assert ids.index("activate-account-deletion") < ids.index("activate-scheduled-mail-drain")
    # Every healthy release applies the kill switch, a frontend-only one too:
    # setting the variable to false must pause the job on the next deploy of
    # any kind, not only the next backend deploy.
    assert step["if"] == "steps.classify-uat-release.outputs.release_failed == 'false'"
    assert "deploy_backend" not in step["if"]
    assert step["env"]["SCHEDULER_SERVICE_ACCOUNT_NAME"] == "mail-scheduled-send"
    assert step["env"]["JOB_NAME"] == "mail-scheduled-send-uat"
    assert step["env"]["BATCH_LIMIT"] == "50"
    # One repository variable both opens the drain route and runs the job.
    switch = "${{ vars.MAIL_SCHEDULED_DRAIN_ENABLED_UAT || 'true' }}"
    assert step["env"]["MAIL_SCHEDULED_DRAIN_ENABLED"] == switch
    assert f'--mail-scheduled-drain-enabled "{switch}"' in UAT_WORKFLOW.read_text(encoding="utf-8")
    assert step["env"]["OIDC_AUDIENCE"] == "${{ env.CONSENT_API_PUBLIC_ORIGIN }}"
    assert "bash deploy/gmail/setup_scheduled_mail_scheduler.sh" in step["run"]
    assert f"'{URI}'" in step["run"]
    assert "Scheduled mail drain scheduler configuration drifted" in step["run"]


def test_production_has_no_scheduled_mail_job():
    production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")

    assert "setup_scheduled_mail_scheduler" not in production
    assert "mail-scheduled-send" not in production
    assert '--mail-scheduled-drain-enabled "false"' in production
