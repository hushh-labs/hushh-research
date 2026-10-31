"""The UAT Calendar follow-ups gates are checked in, fail closed and cost no Cloud Build substitution.

The combined UAT build sits at Cloud Build's 200-substitution ceiling, so the gates are a data file
read from the commit being deployed. Enabling binds the existing sealing key and refuses to deploy
when that secret is unreadable. Dev and production never read the file.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY = REPO_ROOT / "scripts/deploy/backend-deploy.sh"
VERIFY = REPO_ROOT / "deploy/calendar/verify_followup_release.py"
GATES = REPO_ROOT / "deploy/uat-surface-gates.txt"
KEY = "CALENDAR_EMAIL_FOLLOWUP_KEY"
BASE_SECRETS = "BASE=x:latest"
FOLLOWUPS_ON = "calendar_email_followups=true\n"
DRAIN_ON = "calendar_email_followup_drain=true\n"
FOLLOWUPS_OFF = "calendar_email_followups=false\n"
DRAIN_OFF = "calendar_email_followup_drain=false\n"
COMMENT = "# comment\n\n"
APPEND = re.compile(r'^append_optional_env "CALENDAR_EMAIL_FOLLOWUP[A-Z_]*" ".*"$', re.M)


def _gate_block() -> str:
    match = re.search(
        r"# UAT gates ride in the deployed commit.*?" + KEY + r"=" + KEY + r':latest"\n',
        DEPLOY.read_text(),
        re.S,
    )
    assert match, "the follow-up gate block is missing from backend-deploy.sh"
    return match.group(0)


def _appends() -> list[str]:
    return APPEND.findall(DEPLOY.read_text())


def _run(
    tmp_path: Path,
    *,
    gates: str | None,
    deploy_env: str = "uat",
    project: str = "hushh-pda-uat",
    secret_readable: bool = True,
    reader_present: bool = True,
) -> subprocess.CompletedProcess:
    """Run the deploy script's real gate lines in a scratch checkout with a stand-in gcloud."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    gcloud = bin_dir / "gcloud"
    gcloud.write_text(f"#!/usr/bin/env bash\nexit {0 if secret_readable else 1}\n")
    gcloud.chmod(0o755)
    (bin_dir / "python3").symlink_to(sys.executable)
    if reader_present:
        (tmp_path / "deploy/calendar").mkdir(parents=True, exist_ok=True)
        shutil.copy(VERIFY, tmp_path / "deploy/calendar/verify_followup_release.py")
    if gates is not None:
        (tmp_path / "deploy").mkdir(exist_ok=True)
        (tmp_path / "deploy/uat-surface-gates.txt").write_text(gates)
    script = "\n".join(
        [
            "set -euo pipefail",
            f"_DEPLOY_ENV={deploy_env}",
            f"PROJECT_ID={project}",
            f"secrets={BASE_SECRETS}",
            'env_log=""',
            'append_optional_env() { [[ -z "$2" ]] || env_log+="$1=$2,"; }',
            _gate_block(),
            *_appends(),
            'printf "%s|%s" "${env_log}" "${secrets}"',
        ]
    )
    return subprocess.run(  # noqa: S603 - Stand-in gcloud in a scratch directory, no cloud calls.
        ["bash", "-c", script],
        cwd=tmp_path,
        env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"},
        capture_output=True,
        text=True,
        check=False,
    )


ENV_OFF = "CALENDAR_EMAIL_FOLLOWUPS=false,CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED=false,"
ENV_FOLLOWUPS = "CALENDAR_EMAIL_FOLLOWUPS=true,CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED=false,"
ENV_BOTH = "CALENDAR_EMAIL_FOLLOWUPS=true,CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED=true,"
BOUND = f"{BASE_SECRETS},{KEY}={KEY}:latest"


def test_both_gates_off_set_the_flags_false_and_bind_nothing(tmp_path):
    result = _run(tmp_path, gates=COMMENT + FOLLOWUPS_OFF + DRAIN_OFF)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"{ENV_OFF}|{BASE_SECRETS}"


def test_gates_off_never_need_the_key(tmp_path):
    result = _run(tmp_path, gates=FOLLOWUPS_OFF + DRAIN_OFF, secret_readable=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"{ENV_OFF}|{BASE_SECRETS}"


def test_followups_without_drain_binds_the_existing_key_only(tmp_path):
    result = _run(tmp_path, gates=COMMENT + FOLLOWUPS_ON + DRAIN_OFF)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"{ENV_FOLLOWUPS}|{BOUND}"


def test_both_gates_on_bind_the_key_and_keep_every_other_secret(tmp_path):
    result = _run(tmp_path, gates=COMMENT + FOLLOWUPS_ON + DRAIN_ON)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"{ENV_BOTH}|{BOUND}"


def test_enabled_without_a_readable_key_stops_before_any_revision_exists(tmp_path):
    result = _run(tmp_path, gates=FOLLOWUPS_ON + DRAIN_ON, secret_readable=False)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "not readable" in result.stderr


MALFORMED = [
    "",
    "# only a comment\n",
    "calendar_email_followups=true\n",
    "calendar_email_followups=yes\ncalendar_email_followup_drain=false\n",
    "calendar_email_followups=TRUE\ncalendar_email_followup_drain=true\n",
    "calendar_email_followups=true \ncalendar_email_followup_drain=true\n",
    "calendar_email_followups=true\r\ncalendar_email_followup_drain=true\r\n",
    "calendar_email_followup_drain=true\ncalendar_email_followups=true\n",
    "calendar_email_followups=true\ncalendar_email_followups=false\ncalendar_email_followup_drain=false\n",
    "calendar_email_followups=true\ncalendar_email_followup_drain=true\nextra=true\n",
    # The drain cannot run without the routes it drains.
    "calendar_email_followups=false\ncalendar_email_followup_drain=true\n",
]


@pytest.mark.parametrize("gates", MALFORMED)
def test_a_malformed_gate_file_stops_the_deploy_instead_of_guessing(tmp_path, gates):
    result = _run(tmp_path, gates=gates)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "uat-surface-gates.txt" in result.stderr


def test_a_commit_without_gates_deploys_unchanged_and_needs_no_reader(tmp_path):
    """An older application SHA is built with main's script but has neither file."""
    result = _run(tmp_path, gates=None, reader_present=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"|{BASE_SECRETS}"


@pytest.mark.parametrize(
    "deploy_env,project",
    [
        ("dev", "hushh-pda-uat"),
        ("production", "hushh-pda-uat"),
        ("uat", "hushh-pda"),
        ("uat", "some-other-project"),
    ],
)
def test_only_the_reviewed_uat_project_reads_the_gates(tmp_path, deploy_env, project):
    result = _run(
        tmp_path,
        gates=FOLLOWUPS_ON + DRAIN_ON,
        deploy_env=deploy_env,
        project=project,
        secret_readable=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"|{BASE_SECRETS}"


def test_the_checked_in_gates_are_a_reviewed_pair():
    import importlib.util

    spec = importlib.util.spec_from_file_location("verify_followup_release", VERIFY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.parse_gates(GATES.read_text()) in module.VALID_GATES


def test_the_gates_and_their_reader_are_uploaded_with_the_build_source():
    from pathspec import GitIgnoreSpec

    rules = (REPO_ROOT / ".gcloudignore").read_text().splitlines()
    spec = GitIgnoreSpec.from_lines(rules)
    for shipped in ("deploy/uat-surface-gates.txt", "deploy/calendar/verify_followup_release.py"):
        assert not spec.match_file(shipped), f"Cloud Build would omit {shipped}"
    # Negative control: the matcher does exclude a path an ignore rule names.
    assert GitIgnoreSpec.from_lines([*rules, "*.txt"]).match_file("deploy/uat-surface-gates.txt")
    assert GitIgnoreSpec.from_lines([*rules, "*.py"]).match_file(
        "deploy/calendar/verify_followup_release.py"
    )


def test_the_gate_reader_adds_no_sourced_helper_to_the_release_tooling_closure():
    """A new file sourced by backend-deploy.sh must join the production and UAT preserved-tool lists.

    Older application SHAs are deployed with main's backend-deploy.sh over their own checkout, where
    a new helper would not exist. The deploy script only calls the reader when the commit carries
    the gate file (which arrives together with the reader), and it sources nothing new, so that
    closure and the production release workflow stay untouched.
    """
    assert not re.search(r"(?m)^\s*source .*(uat-surface-gates|calendar)", DEPLOY.read_text())
    assert (
        "uat-surface-gates"
        not in (REPO_ROOT / ".github/workflows/deploy-production.yml").read_text()
    )
    assert (
        "verify_followup_release"
        not in (REPO_ROOT / ".github/workflows/deploy-production.yml").read_text()
    )


def test_the_gates_consume_no_cloud_build_substitution_or_env_entry():
    for name in ("backend", "frontend"):
        text = (REPO_ROOT / f"deploy/{name}.cloudbuild.yaml").read_text()
        assert "FOLLOWUP" not in text, f"{name} build config must not carry follow-up settings"
    config = yaml.safe_load((REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text())
    step = next(item for item in config["steps"] if item.get("id") == "deploy-backend")
    assert len(step["env"]) <= 100
    for workflow in (REPO_ROOT / ".github/workflows").glob("deploy-*.yml"):
        assert "_CALENDAR_EMAIL_FOLLOWUP" not in workflow.read_text(), workflow.name


def test_the_runtime_receives_exactly_the_two_flags_the_routes_read_and_one_key_binding():
    text = DEPLOY.read_text()
    assert _appends() == [
        'append_optional_env "CALENDAR_EMAIL_FOLLOWUPS" "${calendar_followups_gate}"',
        'append_optional_env "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED" "${calendar_followup_drain_gate}"',
    ]
    assert text.count(f"{KEY}={KEY}:latest") == 1  # the single binding of the existing secret
    # Only the follow-up routes read these flags: none appear as a literal value anywhere else.
    assert 'CALENDAR_EMAIL_FOLLOWUPS" "true"' not in text
    assert 'CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED" "true"' not in text
