"""PLG build projections and secret bindings retain their closed contracts."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "deploy/plg/bind_secrets.sh"
BACKEND_BINDINGS = ROOT / "scripts/deploy/commerce-preview-bindings.sh"


@pytest.mark.parametrize("lane", ["uat"])
def test_owner_bindings_are_project_pinned_without_cross_lane_keys(lane):
    project = "hushh-pda" if lane == "production" else f"hushh-pda-{lane}"
    common = {"ONE_PLG_ATTEMPT_EMAIL_SECRET", "ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS"}
    allowed = (
        {
            "ONE_PLG_EXPORT_SECRET",
            "ONE_PLG_EXPORT_ACCOUNT_IDS",
            "ONE_PLG_SUBSCRIPTION_SECRET",
            "ONE_PLG_AUDIENCE_SECRET",
            "ONE_PLG_REPORTING_POLICY_JSON",
            "ONE_PLG_OWNER_EXPORT_SECRET",
            "ONE_PLG_OWNER_ACCOUNT_IDS",
        }
        if lane == "production"
        else {
            f"ONE_PLG_{lane.upper()}_EXPORT_SECRET",
            f"ONE_PLG_ACTIVITY_{lane.upper()}_ACCOUNT_IDS",
        }
    ) | common
    script = r"""
set -euo pipefail
gcloud() { printf '%s\n' ENABLED; }
append_optional_secret() { printf '%s\n' "$1"; }
source "$1" "$2" "$3"
"""
    bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "bash"
    result = subprocess.run(  # noqa: S603 -- fixed helper, finite lanes and mocked CLI; no cloud access
        [bash, "-c", script, "plg-owned-bindings", HELPER.as_posix(), lane, project],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert set(result.stdout.splitlines()) == allowed
    wrong = subprocess.run(  # noqa: S603 -- fixed helper and explicit negative fixture project
        [bash, "-c", script, "plg-owned-bindings", HELPER.as_posix(), lane, "foreign-project"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert wrong.returncode != 0 and not wrong.stdout.strip()
    disabled = subprocess.run(  # noqa: S603 -- fixed mocked disabled-version response
        [
            bash,
            "-c",
            script.replace("ENABLED", "DISABLED"),
            "plg-disabled-bindings",
            HELPER.as_posix(),
            lane,
            project,
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert not disabled.stdout.strip()
    preview_script = script.replace(
        "gcloud() { printf '%s\\n' ENABLED; }", "gcloud() { echo unexpected-read >&2; return 75; }"
    )
    preview = subprocess.run(  # noqa: S603 -- fixed preview namespace and mocked CLI
        [
            bash,
            "-c",
            "_SECRET_PREFIX=ISOLATED_PREVIEW_\n" + preview_script,
            "plg-preview-bindings",
            HELPER.as_posix(),
            lane,
            project,
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert not preview.stdout.strip() and not preview.stderr.strip()


@pytest.mark.parametrize(
    ("profile", "state", "audience", "policy", "expected"),
    [
        ("production", "ENABLED", "DISABLED", "DISABLED", 2),
        ("production", "DISABLED", "DISABLED", "DISABLED", 1),
        ("production", "", "DISABLED", "DISABLED", 1),
        ("production", "error", "DISABLED", "DISABLED", 1),
        ("production", "DISABLED", "ENABLED", "DISABLED", 2),
        ("production", "ENABLED", "ENABLED", "DISABLED", 3),
        ("production", "DISABLED", "ENABLED", "ENABLED", 3),
        ("production", "ENABLED", "ENABLED", "ENABLED", 4),
        ("production", "ENABLED", "ENABLED", "error", 3),
        ("dev", "ENABLED", "ENABLED", "ENABLED", 0),
    ],
)
@pytest.mark.parametrize("subscription", ["ENABLED", "DISABLED"])
def test_binding_requires_enabled_versions_in_production(
    profile, state, audience, policy, expected, subscription
):
    bash = shutil.which("bash")
    if os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        bash = str(candidate) if candidate.is_file() else None
    if not bash:
        pytest.skip("Bash is required for the production deploy helper")
    script = r"""
set -euo pipefail
PROJECT_ID="$4"
_SECRET_PREFIX=""
secrets=""
gcloud() {
  [[ "$*" == *"--project=$PROJECT_ID"* ]] || return 17
  if [[ "$1 $2" == "secrets describe" ]]; then return 0; fi
  if [[ "$*" == *'--secret=ONE_PLG_EXPORT_ACCOUNT_IDS'* ]]; then
    [[ "$PLG_TEST_SECOND_STATE" != error ]] || return 1
    printf '%s\n' "$PLG_TEST_SECOND_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_AUDIENCE_SECRET'* ]]; then
    printf '%s\n' "$PLG_TEST_AUDIENCE_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_REPORTING_POLICY_JSON'* ]]; then
    [[ "$PLG_TEST_POLICY_STATE" != error ]] || return 1
    printf '%s\n' "$PLG_TEST_POLICY_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_SUBSCRIPTION_SECRET'* ]]; then
    printf '%s\n' "$PLG_TEST_SUBSCRIPTION_STATE"
  elif [[ "$*" == *'--secret=ONE_PLG_EXPORT_SECRET'* ]]; then
    printf '%s\n' ENABLED
  else
    printf '%s\n' DISABLED
  fi
}
source "$1"
source "$2" "$3" "$PROJECT_ID"
printf '%s\n' "$secrets"
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper and synthetic CLI, no cloud access
        [
            bash,
            "-c",
            script,
            "plg-bindings",
            BACKEND_BINDINGS.as_posix(),
            HELPER.as_posix(),
            profile,
            "hushh-pda" if profile == "production" else f"hushh-pda-{profile}",
        ],
        env={
            **os.environ,
            "PLG_TEST_SECOND_STATE": state,
            "PLG_TEST_AUDIENCE_STATE": audience,
            "PLG_TEST_POLICY_STATE": policy,
            "PLG_TEST_SUBSCRIPTION_STATE": subscription,
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    actual = [value for value in result.stdout.strip().split(",") if value]
    assert len(actual) == expected + int(profile == "production" and subscription == "ENABLED")
    bindings = []
    if profile == "production":
        bindings += ["ONE_PLG_EXPORT_SECRET:ONE_PLG_EXPORT_SECRET"]
        if state == "ENABLED":
            bindings += ["ONE_PLG_EXPORT_ACCOUNT_IDS:ONE_PLG_EXPORT_ACCOUNT_IDS"]
        if subscription == "ENABLED":
            bindings += ["ONE_PLG_SUBSCRIPTION_SECRET:ONE_PLG_SUBSCRIPTION_SECRET"]
    if profile == "production" and audience == "ENABLED":
        bindings += ["ONE_PLG_AUDIENCE_SECRET:ONE_PLG_AUDIENCE_SECRET"]
    if profile == "production" and policy == "ENABLED":
        bindings += ["ONE_PLG_REPORTING_POLICY_JSON:ONE_PLG_REPORTING_POLICY_JSON"]
    assert actual == [value.replace(":", "=", 1) + ":latest" for value in bindings]


@pytest.mark.parametrize(
    ("project", "prefix", "exit_code", "bound"),
    [
        ("hushh-pda-uat", "", 0, True),
        ("hushh-pda", "", 1, False),
        ("hushh-pda-uat", "preview_", 0, False),
    ],
)
def test_uat_binding_stays_in_its_project_and_excludes_previews(project, prefix, exit_code, bound):
    script = r"""
set -euo pipefail
_SECRET_PREFIX=$3
gcloud() {
    [[ "$*" == *'--project=hushh-pda-uat'* ]] || return 1
    [[ "$*" != *'_ACCOUNT_IDS'* ]] || return 1
    printf '%s\n' ENABLED
}
append_optional_secret() { printf '%s=%s\n' "$1" "$2"; }
source "$1" uat "$2"
"""
    result = subprocess.run(  # noqa: S603 -- fixed helper, synthetic gcloud
        ["bash", "-c", script, "plg-uat", str(HELPER), project, prefix],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == exit_code
    assert result.stdout.splitlines() == (
        [
            "ONE_PLG_UAT_EXPORT_SECRET=ONE_PLG_UAT_EXPORT_SECRET",
            "ONE_PLG_ATTEMPT_EMAIL_SECRET=ONE_PLG_ATTEMPT_EMAIL_SECRET",
        ]
        if bound
        else []
    )


def test_observation_projection_follows_split_literals_and_rejects_expressions():
    import runpy

    root = HELPER.parents[2]
    generator = runpy.run_path(
        str(root / "consent-protocol/scripts/generate_plg_observation_contract.py")
    )
    source = generator["SOURCE"].read_text()
    actions = generator["ACTIONS"].read_text()
    compile_contract = generator["compile_contract"]
    contract = compile_contract(source, actions_source=actions)
    assert "export_saved" in contract["events"]["one_memory_action"]
    changed = compile_contract(
        source, actions_source=actions.replace('"export_saved"', '"export_changed"')
    )
    assert "export_changed" in changed["events"]["one_memory_action"]
    assert changed["sourceDigest"] != contract["sourceDigest"]
    with pytest.raises(ValueError, match="literal enums"):
        compile_contract(source, actions_source=actions.replace('"export_saved"', "runtimeValue()"))
