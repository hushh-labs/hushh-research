"""Keep the Calendar follow-ups scheduler UAT-only, OIDC-only and driven by the checked-in gates."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "calendar" / "setup_followup_scheduler.sh"
VERIFY = ROOT / "deploy" / "calendar" / "verify_followup_release.py"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
URI = "https://api.uat.hushh.ai/api/one/calendar/followups/drain?limit=10"
SERVICE_ACCOUNT = "calendar-email-followups@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_ON = "calendar_email_followups=true\ncalendar_email_followup_drain=true\n"
FOLLOWUPS_ONLY = "calendar_email_followups=true\ncalendar_email_followup_drain=false\n"
ALL_OFF = "calendar_email_followups=false\ncalendar_email_followup_drain=false\n"


def _load_verifier():
    spec = importlib.util.spec_from_file_location("verify_followup_release", VERIFY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    tmp_path: Path, *, job_state: str | None, gates: str | None, pause_takes: bool = True
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
    environment = _environment(
        fake_bin,
        FAKE_JOB_STATE=str(state),
        FAKE_GCLOUD_CALLS=str(calls),
        FAKE_PAUSE_TAKES="1" if pause_takes else "0",
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
    return result, verbs, state.read_text() if state.exists() else None


@pytest.mark.parametrize("gates", [FOLLOWUPS_ONLY, ALL_OFF, None])
def test_kill_switch_pauses_an_existing_job_and_never_rearms_it(tmp_path: Path, gates):
    result, verbs, final = _run_scheduler_against(tmp_path, job_state="ENABLED", gates=gates)

    assert result.returncode == 0, result.stderr
    assert "pause" in verbs
    assert not {"create", "update", "resume"} & set(verbs)
    assert final == "PAUSED"


def test_kill_switch_never_creates_a_missing_job(tmp_path: Path):
    result, verbs, final = _run_scheduler_against(tmp_path, job_state=None, gates=ALL_OFF)

    assert result.returncode == 0, result.stderr
    assert verbs == ["describe"] and final is None


def test_kill_switch_fails_the_deploy_when_the_job_does_not_pause(tmp_path: Path):
    result, _verbs, final = _run_scheduler_against(
        tmp_path, job_state="ENABLED", gates=ALL_OFF, pause_takes=False
    )

    assert result.returncode != 0
    assert "not PAUSED" in result.stderr and final == "ENABLED"


def test_enabled_deploy_resumes_a_manually_paused_job(tmp_path: Path):
    """The gate file, not a manual pause, is the source of truth."""
    result, verbs, final = _run_scheduler_against(tmp_path, job_state="PAUSED", gates=DRAIN_ON)

    assert result.returncode == 0, result.stderr
    assert "update" in verbs and "resume" in verbs and "create" not in verbs
    assert final == "ENABLED"


def test_enabled_deploy_creates_a_missing_job_and_verifies_its_oidc_target(tmp_path: Path):
    result, verbs, final = _run_scheduler_against(tmp_path, job_state=None, gates=DRAIN_ON)

    assert result.returncode == 0, result.stderr
    assert "create" in verbs and final == "ENABLED"
    assert "auth=oidc" in result.stdout and SERVICE_ACCOUNT in result.stdout


@pytest.mark.parametrize(
    "gates",
    [
        "",
        "calendar_email_followups=false\ncalendar_email_followup_drain=true\n",
        "calendar_email_followups=true\r\ncalendar_email_followup_drain=true\r\n",
        "calendar_email_followup_drain=true\ncalendar_email_followups=true\n",
    ],
)
def test_a_malformed_gate_file_stops_before_any_gcloud_call(tmp_path: Path, gates: str):
    result = _run_scheduler_with(tmp_path, gates=gates)

    assert result.returncode != 0
    assert "uat-surface-gates.txt" in result.stderr
    assert result.gcloud_calls == ""  # type: ignore[attr-defined]


def test_script_is_executable_and_never_mutates_runtime_iam():
    source = SCRIPT.read_text(encoding="utf-8")

    assert SCRIPT.stat().st_mode & stat.S_IXUSR
    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly UAT_BACKEND_ORIGIN="https://api.uat.hushh.ai"' in source
    assert 'URI="${BACKEND_URL}/api/one/calendar/followups/drain?limit=${BATCH_LIMIT}"' in source
    assert "--oidc-service-account-email" in source and "--oidc-token-audience" in source
    assert "roles/iam.serviceAccountTokenCreator" not in source
    assert "add-iam-policy-binding" not in source
    assert "run services update" not in source


def test_the_job_matches_the_identity_and_audience_the_drain_route_verifies():
    """The route accepts only this audience and this service account in UAT."""
    route = (ROOT / "consent-protocol/api/routes/one/calendar_email_followup_drain.py").read_text(
        encoding="utf-8"
    )

    assert f'"{SERVICE_ACCOUNT}"' in route
    assert '"https://api.uat.hushh.ai"' in route
    assert '@router.post("/drain")' in route and "le=20" in route


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
        assert " calendar-email-followups-uat " in job
        assert "'--schedule=* * * * *'" in job
        assert f"'--uri={URI}'" in job
        assert "--http-method=POST" in job
        assert f"--oidc-service-account-email={SERVICE_ACCOUNT}" in job
        assert "--oidc-token-audience=https://api.uat.hushh.ai" in job
        assert "--time-zone=Etc/UTC" in job
        assert "--attempt-deadline=300s" in job


def test_dry_run_with_the_drain_gate_off_only_ever_pauses(tmp_path: Path):
    result = _run_scheduler_with(tmp_path, gates=FOLLOWUPS_ONLY, DRY_RUN="1")

    assert result.returncode == 0, result.stderr
    lines = [line for line in result.stdout.splitlines() if line.startswith("+ ")]
    assert [line.split()[1:5] for line in lines] == [["gcloud", "scheduler", "jobs", "pause"]]


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
        ({"JOB_NAME": "mail-scheduled-send-uat"}, "only configures the reviewed UAT Calendar"),
        ({"CRON": "*/5 * * * *"}, "only configures the reviewed UAT Calendar"),
        (
            {"SCHEDULER_SERVICE_ACCOUNT_NAME": "mail-scheduled-send"},
            "only configures the reviewed UAT Calendar",
        ),
        ({"BATCH_LIMIT": "21"}, "BATCH_LIMIT must be an integer from 1 through 20"),
        ({"BATCH_LIMIT": "0"}, "BATCH_LIMIT must be an integer from 1 through 20"),
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


def test_uat_applies_the_gates_only_after_a_healthy_backend_release():
    steps = _steps(UAT_WORKFLOW)
    ids = [step.get("id") for step in steps]
    step = next(step for step in steps if step.get("id") == "activate-calendar-followups")

    assert ids.index("classify-uat-release") < ids.index("activate-calendar-followups")
    assert ids.index("activate-account-deletion") < ids.index("activate-calendar-followups")
    # Flags, key binding and job change together, so the job runs with a backend deploy.
    assert step["if"] == (
        "steps.classify-uat-release.outputs.release_failed == 'false' "
        "&& steps.scope.outputs.deploy_backend == 'true'"
    )
    assert step["env"]["SCHEDULER_SERVICE_ACCOUNT_NAME"] == "calendar-email-followups"
    assert step["env"]["JOB_NAME"] == "calendar-email-followups-uat"
    assert step["env"]["BATCH_LIMIT"] == "10"
    assert step["env"]["OIDC_AUDIENCE"] == "${{ env.CONSENT_API_PUBLIC_ORIGIN }}"
    # The gate comes from the file in the deployed commit, never from a repository variable.
    assert "vars." not in json.dumps(step)
    # Main's tooling runs from the preserved copy, so an older application SHA still gets the
    # kill switch applied; the gate file itself is read from the application checkout.
    assert 'bash "${RUNNER_TEMP}/release-tools/calendar/setup_followup_scheduler.sh"' in step["run"]
    assert (
        'python3 "${RUNNER_TEMP}/release-tools/calendar/verify_followup_release.py" verify'
        in step["run"]
    )
    assert "bash deploy/calendar/" not in step["run"]
    assert "--application-sha" in step["run"]
    assert "${{ steps.resolve-sha.outputs.sha }}" in step["run"]


def test_uat_preserves_main_followup_tooling_before_the_application_checkout():
    steps = _steps(UAT_WORKFLOW)
    names = [step.get("name") for step in steps]
    preserve = steps[names.index("Preserve current release tooling")]

    assert names.index("Preserve current release tooling") < names.index("Checkout deployment SHA")
    for tool in ("setup_followup_scheduler.sh", "verify_followup_release.py"):
        assert f"deploy/calendar/{tool}" in preserve["run"]
    assert 'mkdir -p "${RUNNER_TEMP}/release-tools/calendar"' in preserve["run"]


def test_release_evidence_is_uploaded_even_when_verification_fails():
    upload = next(
        step
        for step in _steps(UAT_WORKFLOW)
        if step.get("name") == "Upload Calendar follow-ups release evidence"
    )

    assert upload["if"].startswith("always()")
    assert "uat-calendar-followups-release-evidence.json" in upload["with"]["path"]


def test_production_has_no_calendar_followups_job_or_gate():
    production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")

    assert "setup_followup_scheduler" not in production
    assert "calendar-email-followups" not in production
    assert "uat-surface-gates" not in production


# --- the release verifier ---------------------------------------------------------------------

verifier = _load_verifier()


def _revision(*, followups="true", drain="true", key="reference", image="img@sha256:abc"):
    env = []
    if followups is not None:
        env.append({"name": "CALENDAR_EMAIL_FOLLOWUPS", "value": followups})
    if drain is not None:
        env.append({"name": "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED", "value": drain})
    if key == "reference":
        ref = {"secretKeyRef": {"name": "CALENDAR_EMAIL_FOLLOWUP_KEY", "key": "latest"}}
        env.append({"name": "CALENDAR_EMAIL_FOLLOWUP_KEY", "valueFrom": ref})
    elif key == "plain":
        env.append({"name": "CALENDAR_EMAIL_FOLLOWUP_KEY", "value": "redacted-in-test"})
    return {"spec": {"containers": [{"image": image, "env": env}]}}


@pytest.mark.parametrize(
    ("gates", "revision"),
    [
        (("true", "true"), _revision()),
        (("true", "false"), _revision(drain="false")),
        (("false", "false"), _revision(followups="false", drain="false", key=None)),
    ],
)
def test_a_serving_revision_that_matches_its_gates_has_no_issues(gates, revision):
    assert verifier.problems(gates, verifier.revision_facts(revision)) == []


@pytest.mark.parametrize(
    ("gates", "revision", "expected"),
    [
        (("true", "true"), _revision(followups="false"), "CALENDAR_EMAIL_FOLLOWUPS"),
        (("true", "true"), _revision(drain=None), "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED"),
        (("true", "true"), _revision(key=None), "binding does not match"),
        (("true", "true"), _revision(key="plain"), "secret reference"),
        (("false", "false"), _revision(followups="false", drain="false"), "binding does not match"),
        (("true", "false"), _revision(), "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED"),
    ],
)
def test_a_serving_revision_that_drifts_from_its_gates_is_reported(gates, revision, expected):
    issues = verifier.problems(gates, verifier.revision_facts(revision))

    assert issues and any(expected in issue for issue in issues)


def test_serving_revisions_follow_the_traffic_that_is_actually_served():
    service = {
        "status": {
            "latestReadyRevisionName": "backend-00042",
            "traffic": [
                {"latestRevision": True, "percent": 90},
                {"revisionName": "backend-00041", "percent": 10},
                {"revisionName": "backend-00040", "percent": 0},
            ],
        }
    }

    assert verifier.serving_revisions(service) == [("backend-00041", 10), ("backend-00042", 90)]


def _read_gates(tmp_path: Path, gates: str, *extra: str, gcloud_ok: bool = True):
    """Run the real `read-gates` command; a stand-in gcloud answers the key check."""
    workdir = _workspace(tmp_path, gates)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f"#!/usr/bin/env bash\nexit {0 if gcloud_ok else 1}\n")
    fake_gcloud.chmod(0o755)
    return subprocess.run(  # noqa: S603 - the repository-owned reader in a scratch directory
        [sys.executable, str(VERIFY), "read-gates", "deploy/uat-surface-gates.txt", *extra],
        cwd=workdir,
        env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("gates", [DRAIN_ON, FOLLOWUPS_ONLY, ALL_OFF])
def test_read_gates_prints_the_two_reviewed_values(tmp_path: Path, gates: str):
    result = _read_gates(tmp_path, gates)

    assert result.returncode == 0, result.stderr
    assert tuple(result.stdout.split()) == verifier.parse_gates(gates)


@pytest.mark.parametrize(
    "gates",
    [
        "",
        "# only a comment\n",
        "calendar_email_followups=true\n",
        "calendar_email_followups=TRUE\ncalendar_email_followup_drain=true\n",
        "calendar_email_followups=true \ncalendar_email_followup_drain=true\n",
        "calendar_email_followups=true\r\ncalendar_email_followup_drain=true\r\n",
        "calendar_email_followup_drain=true\ncalendar_email_followups=true\n",
        "calendar_email_followups=false\ncalendar_email_followup_drain=true\n",
        "calendar_email_followups=true\ncalendar_email_followup_drain=true\nextra=true\n",
    ],
)
def test_read_gates_rejects_everything_but_the_three_reviewed_pairs(tmp_path: Path, gates: str):
    result = _read_gates(tmp_path, gates)

    assert result.returncode == 1
    assert result.stdout == ""
    assert "uat-surface-gates.txt must hold" in result.stderr
    with pytest.raises(ValueError):
        verifier.parse_gates(gates)


def test_read_gates_with_a_project_requires_the_sealing_key_only_when_enabled(tmp_path: Path):
    project = ("--project", "hushh-pda-uat")

    enabled = _read_gates(tmp_path / "on", FOLLOWUPS_ONLY, *project, gcloud_ok=False)
    off = _read_gates(tmp_path / "off", ALL_OFF, *project, gcloud_ok=False)
    readable = _read_gates(tmp_path / "ok", FOLLOWUPS_ONLY, *project, gcloud_ok=True)

    assert enabled.returncode == 1 and enabled.stdout == ""
    assert "CALENDAR_EMAIL_FOLLOWUP_KEY is not readable in project hushh-pda-uat" in enabled.stderr
    assert off.returncode == 0 and off.stdout.split() == ["false", "false"]
    assert readable.returncode == 0 and readable.stdout.split() == ["true", "false"]
