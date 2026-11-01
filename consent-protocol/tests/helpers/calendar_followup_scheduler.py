"""Stateful CLI fixture for the real UAT Calendar scheduler helper."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "deploy" / "calendar" / "setup_followup_scheduler.sh"
URI = "https://api.uat.hushh.ai/api/one/calendar/followups/drain?limit=10"
SERVICE_ACCOUNT = "calendar-email-followups@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_ON = "calendar_email_followups=true\ncalendar_email_followup_drain=true\n"
FOLLOWUPS_ONLY = "calendar_email_followups=true\ncalendar_email_followup_drain=false\n"
ALL_OFF = "calendar_email_followups=false\ncalendar_email_followup_drain=false\n"


def _workspace(tmp_path: Path, gates: str | None) -> Path:
    """A scratch repo root holding only the gate file under test."""
    if gates is not None:
        (tmp_path / "deploy").mkdir(parents=True, exist_ok=True)
        (tmp_path / "deploy/uat-surface-gates.txt").write_text(gates)
    return tmp_path


def _environment(bin_dir: Path, **overrides: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{bin_dir}:{environment['PATH']}",
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_URL": "https://api.uat.hushh.ai",
            "OIDC_AUDIENCE": "https://api.uat.hushh.ai",
            **overrides,
        }
    )
    return environment


def _run_scheduler_with(
    tmp_path: Path, gates: str | None = DRAIN_ON, **overrides: str
) -> subprocess.CompletedProcess[str]:
    """Run the real script with a gcloud stand-in that records any call."""
    workdir = _workspace(tmp_path, gates)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    calls = tmp_path / "gcloud-calls"
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{calls}"\nexit 97\n')
    fake_gcloud.chmod(0o755)
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        cwd=workdir,
        env=_environment(fake_bin, **overrides),
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
    identity = state_file.with_name("identity-created")
    if args[2] == "describe" and os.environ["FAKE_NEW_IDENTITY"] == "1" and not identity.exists():
        sys.exit(1)
    if args[2] == "create":
        identity.touch()
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
    counter = state_file.with_name("create-attempts")
    attempt = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(attempt))
    if attempt <= int(os.environ["FAKE_CREATE_FAILURES"]):
        print("ERROR: (gcloud.scheduler.jobs.create.http) " + os.environ["FAKE_CREATE_ERROR"] + ": fixed fixture failure", file=sys.stderr)
        sys.exit(1)
    state_file.write_text("ENABLED")
elif verb == "update" and not state:
    sys.exit(1)
elif verb == "pause" and os.environ["FAKE_PAUSE_TAKES"] == "1":
    state_file.write_text("PAUSED")
elif verb == "resume":
    state_file.write_text("ENABLED")
"""


def _run_scheduler_against(
    tmp_path: Path,
    *,
    job_state: str | None,
    gates: str | None,
    pause_takes: bool = True,
    new_identity: bool = False,
    create_failures: int = 0,
    create_error: str = "NOT_FOUND",
) -> tuple[subprocess.CompletedProcess[str], list[str], str | None]:
    """Run the real script against a stateful gcloud; return its verbs and final state."""
    workdir = _workspace(tmp_path, gates)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    state = tmp_path / "job-state"
    calls = tmp_path / "gcloud-calls"
    if job_state is not None:
        state.write_text(job_state)
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f"#!{sys.executable}\n{_STATEFUL_GCLOUD}")
    fake_gcloud.chmod(0o755)
    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text(
        f"#!{sys.executable}\nimport os,sys\n"
        'with open(os.environ["FAKE_GCLOUD_CALLS"], "a") as output:\n'
        '    output.write("sleep " + sys.argv[1] + "\\n")\n'
    )
    fake_sleep.chmod(0o755)
    environment = _environment(
        fake_bin,
        FAKE_JOB_STATE=str(state),
        FAKE_GCLOUD_CALLS=str(calls),
        FAKE_PAUSE_TAKES="1" if pause_takes else "0",
        FAKE_NEW_IDENTITY="1" if new_identity else "0",
        FAKE_CREATE_FAILURES=str(create_failures),
        FAKE_CREATE_ERROR=create_error,
        FAKE_JOB_EVIDENCE="|".join(
            ["* * * * *", URI, "POST", SERVICE_ACCOUNT, "https://api.uat.hushh.ai"]
        ),
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        cwd=workdir,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )
    lines = calls.read_text().splitlines() if calls.exists() else []
    verbs = [line.split()[2] for line in lines if line.startswith("scheduler jobs ")]
    result.sleep_delays = [int(line.split()[1]) for line in lines if line.startswith("sleep ")]
    return result, verbs, state.read_text() if state.exists() else None
