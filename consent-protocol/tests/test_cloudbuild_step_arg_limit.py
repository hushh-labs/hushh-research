"""No Cloud Build step arg may exceed 10,000 characters.

This is the regression guard for a real, repeated outage. Cloud Build caps a single
build-step arg at 10,000 characters. The `deploy-backend` step's bash body USED TO BE
ONE such arg, and it crossed the cap twice:

  * 2026-07-28 (commit 363a9932d, 9,559 -> 10,569 raw) -- every backend deploy failed
    at submission for roughly a week.
  * 2026-08-04 (PR #4791, Wallet Profile, 10,657 -> 11,246 raw) -- the UAT deploy of
    release ba39d0342 failed with:

        INVALID_ARGUMENT: invalid build: invalid .steps field:
        build step 1 arg 1 too long (max: 10000)

`deploy/backend.cloudbuild.yaml` is invoked identically by deploy-dev.yml, deploy-uat.yml
and deploy-production.yml, so one file puts every lane at risk at once. It does not
follow that every lane breaks together: at ba39d0342 UAT (10,282) and dev (10,208) were
over while production (8,937) was under, so production kept deploying while the other
two could not. Nothing surfaces it either way, because gcloud enforces the cap
client-side before any Build resource exists: there is no failed build to open and no
log to read.

WHAT IS ACTUALLY MEASURED. Cloud Build applies substitutions BEFORE enforcing the cap,
so the raw YAML length is not the number that matters -- it is only an upper bound, and
a loose one. The 2026-08-04 breach is the proof: the same raw body (10,657) was UNDER
the cap once substituted for production but OVER it for UAT, because UAT passes longer
substitution values. A raw-only assertion would therefore have called production healthy
while UAT was broken. This module asserts both:

  1. the raw body stays under the cap (cheap, catches gross growth), and
  2. the SUBSTITUTED body stays under the cap for every deploy lane (the real check).

THE CEILING IS NOW GONE, AND THIS GUARD STILL MATTERS. Twice in eight days is not a
sizing problem, it is a shape problem: any body that lives inline grows until it
breaches. `deploy-backend` therefore no longer carries its body at all -- it invokes
`scripts/deploy/backend-deploy.sh` and receives substitutions through the step's `env:`
field, one tiny entry each. Comments in the script are free.

So this module no longer measures a body that can realistically breach; it measures
whichever field of the step is largest, under substitution, per lane. It is kept
because the failure mode it guards is silent (gcloud rejects client-side, so there is
no Build, no log, and no alert) and because re-inlining the body is an easy change for
someone to make. The assertions are deliberately shape-independent: see
`_backend_deploy_fields`.

If a substitution ever needs a value approaching the cap, it does not belong in the
config -- put it in Secret Manager and pass the reference.
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

# Cloud Build's hard cap on a single build-step arg.
CLOUD_BUILD_MAX_ARG = 10_000

# Cloud Build's hard cap on `env` entries in a single build step. A 101st entry rejects every
# backend deploy at submission (dev, UAT and production share the file), before anything changes,
# and nothing else in CI notices.
CLOUD_BUILD_MAX_ENV = 100

# Refuse to land a change that leaves less than this much room. Without a margin the
# suite goes green at 9,999 and the very next secret ref breaks all three deploy lanes.
REQUIRED_HEADROOM = 500

CLOUDBUILD_CONFIGS = [
    "deploy/backend.cloudbuild.yaml",
    "deploy/backend-image.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml",
    "deploy/frontend-image.cloudbuild.yaml",
    "deploy/dev.autodeploy.backend.cloudbuild.yaml",
    "deploy/ci.cloudbuild.yaml",
]

# Workflows that invoke deploy/backend.cloudbuild.yaml, and the lane each one deploys.
BACKEND_DEPLOY_WORKFLOWS = [
    ".github/workflows/deploy-uat.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/deploy-dev.yml",
]

_SUBSTITUTION = re.compile(r"\$\{(_[A-Z0-9_]+)\}")
# `SUBSTITUTIONS="..."` and `SUBSTITUTIONS="${SUBSTITUTIONS}..."` assignments.
_SUBS_ASSIGNMENT = re.compile(
    r'SUBSTITUTIONS="(?:\$\{SUBSTITUTIONS\})?(.*?)"\s*$', re.MULTILINE | re.DOTALL
)
# GitHub Actions expressions are resolved at runtime; stand in a worst-case-ish value.
# 40 chars covers the longest common case, a full git SHA.
_GHA_EXPRESSION = re.compile(r"\$\{\{.*?\}\}")
_GHA_PLACEHOLDER = "X" * 40


def _load(config_path: str) -> dict | None:
    path = REPO_ROOT / config_path
    if not path.exists():  # a lane may not define every config
        return None
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _assert_no_substitutions_in_options(config: dict) -> None:
    misplaced = [key for key in config.get("options", {}) if key.startswith("_")]
    assert not misplaced, f"User substitutions belong under substitutions, not options: {misplaced}"


@pytest.mark.parametrize("config_path", CLOUDBUILD_CONFIGS)
def test_user_substitutions_are_not_cloud_build_options(config_path: str) -> None:
    config = _load(config_path)
    assert config is not None, f"Missing authored Cloud Build config: {config_path}"
    _assert_no_substitutions_in_options(config)


@pytest.mark.parametrize("name", ["_WORKOS_SSO_ENABLED", "_WORKOS_REDIRECT_URI"])
def test_misplaced_optional_defaults_are_refused(name: str) -> None:
    _assert_no_substitutions_in_options({"substitutions": {name: ""}})
    with pytest.raises(AssertionError, match="not options"):
        _assert_no_substitutions_in_options({"options": {name: ""}})


def _backend_deploy_fields() -> list[tuple[str, str]]:
    """Every substitution-bearing field of the deploy-backend step.

    Deliberately shape-independent. The step used to be `args: ["-c", <9k of bash>]`
    and is now `args: ["scripts/deploy/backend-deploy.sh"]` with the substitutions
    handed over through `env:`. Indexing a fixed position (`args[1]`) would silently
    stop checking anything the moment the shape changed -- so this returns ALL args
    and ALL env entries, and the caller asserts on the largest. That keeps the guard
    meaningful in the current shape and still catches a re-inlined body.
    """
    config = _load("deploy/backend.cloudbuild.yaml")
    assert config is not None, "deploy/backend.cloudbuild.yaml is missing"
    for step in config.get("steps") or []:
        if step.get("id") == "deploy-backend":
            fields = [(f"arg {i}", arg) for i, arg in enumerate(step.get("args") or [])]
            fields += [
                (f"env {entry.split('=', 1)[0]}", entry) for entry in (step.get("env") or [])
            ]
            assert fields, "deploy-backend step carries neither args nor env"
            return fields
    raise AssertionError("no step with id 'deploy-backend' in backend.cloudbuild.yaml")


def _default_substitutions() -> dict[str, str]:
    config = _load("deploy/backend.cloudbuild.yaml") or {}
    return {
        key: ("" if value is None else str(value))
        for key, value in (config.get("substitutions") or {}).items()
    }


def _workflow_substitutions(workflow_path: str) -> dict[str, str]:
    path = REPO_ROOT / workflow_path
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for match in _SUBS_ASSIGNMENT.finditer(text):
        for pair in match.group(1).split("##"):
            if "=" not in pair:
                continue
            key, value = pair.split("=", 1)
            key = key.strip()
            if key.startswith("_"):
                values[key] = _GHA_EXPRESSION.sub(_GHA_PLACEHOLDER, value)
    return values


@pytest.mark.parametrize("config_path", CLOUDBUILD_CONFIGS)
def test_no_cloud_build_step_declares_more_env_entries_than_the_limit(config_path: str) -> None:
    config = _load(config_path)
    if config is None:
        pytest.skip(f"{config_path} not present")

    for index, step in enumerate(config.get("steps") or []):
        count = len(step.get("env") or [])
        assert count <= CLOUD_BUILD_MAX_ENV, (
            f"{config_path} step {index} ({step.get('id')}) declares {count} env entries, over "
            f"Cloud Build's {CLOUD_BUILD_MAX_ENV}. gcloud rejects the build at submission, so every "
            f"deploy lane using this file fails. Pack related values into one entry, or move "
            f"them into a script the step sources."
        )


@pytest.mark.skipif(sys.platform == "win32" or not shutil.which("bash"), reason="needs POSIX bash")
def test_the_deploy_script_unpacks_the_packed_workos_values() -> None:
    script = REPO_ROOT / "deploy" / "sso" / "bind_workos.sh"
    stubs = (
        "secrets=BASE=x:latest; PROJECT_ID=synthetic\n"
        'append_optional_secret() { secrets="${secrets},$2=$1:latest"; }\n'
        'append_optional_env() { echo "$1=$2"; }\n'
    )
    packed = "true|https://a.example/login|https://a.example,https://b.example"
    run = subprocess.run(  # noqa: S603 - fixed shell and repository script; fixed inputs
        ["bash", "-c", f"{stubs}source {script}"],
        env={**os.environ, "_WORKOS_CONFIG": packed},
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    assert run.stdout.splitlines() == [
        "WORKOS_SSO_ENABLED=true",
        "WORKOS_REDIRECT_URI=https://a.example/login",
        "WORKOS_REDIRECT_ORIGINS=https://a.example,https://b.example",
    ]


@pytest.mark.parametrize("config_path", CLOUDBUILD_CONFIGS)
def test_no_raw_cloud_build_step_arg_exceeds_the_limit(config_path: str) -> None:
    """Upper bound: the un-substituted body must already fit."""
    config = _load(config_path)
    if config is None:
        pytest.skip(f"{config_path} not present")

    for index, step in enumerate(config.get("steps") or []):
        for arg_index, arg in enumerate(step.get("args") or []):
            size = len(arg)
            assert size < CLOUD_BUILD_MAX_ARG, (
                f"{config_path} step {index} ({step.get('id')}) arg {arg_index} is "
                f"{size} chars, over Cloud Build's {CLOUD_BUILD_MAX_ARG} limit. gcloud "
                f"rejects this config client-side, so NO build is created and every "
                f"deploy lane using this file fails at submission with no log to read. "
                f"Move comments above the step, or move the body into a script the "
                f"step invokes."
            )


@pytest.mark.parametrize("workflow_path", BACKEND_DEPLOY_WORKFLOWS)
def test_substituted_backend_deploy_body_fits_every_lane(workflow_path: str) -> None:
    """The real check: what each lane actually submits must fit, with margin."""
    if not (REPO_ROOT / workflow_path).exists():
        pytest.skip(f"{workflow_path} not present")

    values = _default_substitutions()
    values.update(_workflow_substitutions(workflow_path))

    label, size = max(
        (
            (label, len(_SUBSTITUTION.sub(lambda m: values.get(m.group(1), ""), text)))
            for label, text in _backend_deploy_fields()
        ),
        key=lambda pair: pair[1],
    )
    headroom = CLOUD_BUILD_MAX_ARG - size

    assert size < CLOUD_BUILD_MAX_ARG, (
        f"{workflow_path} would submit a deploy-backend field ({label}) of {size} "
        f"chars after substitution, over Cloud Build's {CLOUD_BUILD_MAX_ARG} limit. "
        f"This lane's deploys fail at submission. Note the raw body may still look "
        f"fine -- lanes differ because they pass different substitution values."
    )
    assert headroom >= REQUIRED_HEADROOM, (
        f"{workflow_path} would submit {size} chars in {label}, only {headroom} under "
        f"Cloud Build's {CLOUD_BUILD_MAX_ARG} limit (need >= {REQUIRED_HEADROOM}). "
        f"This is too close to ship: the next secret ref or env var breaks every "
        f"deploy lane. Keep the step body in scripts/deploy/backend-deploy.sh and "
        f"pass values through the step's env: field, one substitution per entry."
    )


CLOUD_BUILD_MAX_STEP_ENV = 100


def test_no_cloud_build_step_exceeds_the_env_entry_cap() -> None:
    """Cloud Build rejects a step with more than 100 env entries before anything runs.

    Seen live 2026-09-02 on the dev lane: `invalid .steps.env field: build step 3 too
    many envs (max: 100)` after the September main merge pushed deploy-backend to 101.
    The five Cloud Run capacity knobs now travel as one packed _CLOUD_RUN_CAPACITY entry.
    """
    for rel in ("deploy/backend.cloudbuild.yaml", "deploy/frontend.cloudbuild.yaml"):
        config = _load(rel)
        if config is None:
            continue
        for step in config.get("steps") or []:
            count = len(step.get("env") or [])
            assert count <= CLOUD_BUILD_MAX_STEP_ENV, (
                f"{rel} step {step.get('id') or step.get('name')} carries {count} env entries; "
                f"Cloud Build refuses more than {CLOUD_BUILD_MAX_STEP_ENV}"
            )


def test_every_substitution_the_deploy_script_reads_is_fed_through_the_step_env() -> None:
    """Every read reaches the extracted deploy, including packed cold-phase selection.

    Unwired substitutions silently deployed empty Gmail/model settings before this guard.
    The phase shares its existing packed entry and defaults to the ordinary release.
    """
    root = Path(__file__).resolve().parents[2]
    script = (root / "scripts" / "deploy" / "backend-deploy.sh").read_text(encoding="utf-8")
    script += (root / "scripts/deploy/backend-capacity-settings.sh").read_text(encoding="utf-8")
    script += (root / "scripts/deploy/backend-model-settings.sh").read_text(encoding="utf-8")
    script += (root / "scripts/deploy/backend-drive-secret-settings.sh").read_text(encoding="utf-8")
    config = _load("deploy/backend.cloudbuild.yaml")
    assert config is not None
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    assert config["substitutions"]["_PHONE_DEPLOY_PHASE"] == "standard"
    assert any(
        entry.startswith("_IMAGE_SETTINGS=") and entry.endswith("|${_PHONE_DEPLOY_PHASE}")
        for entry in step["env"]
    )
    assert step.get("args") == ["scripts/deploy/backend-deploy.sh"]
    provided = {entry.split("=", 1)[0] for entry in step.get("env") or []}
    for entry in step.get("env") or []:
        provided.update(re.findall(r"\$\{(_[A-Z0-9_]+)\}", entry.split("=", 1)[1]))
    # Comments explain the mechanism using placeholder names (`${_FOO}`), so read only
    # the executable lines -- a doc example is not a substitution the deploy consumes.
    executable = "\n".join(
        line for line in script.splitlines() if not line.lstrip().startswith("#")
    )
    read_by_script = set(re.findall(r"\$\{(_[A-Z0-9_]+)(?::-[^}]*)?\}", executable))
    missing = sorted(name for name in read_by_script if name not in provided and name != "_PACKED")
    assert not missing, (
        "backend-deploy.sh reads these substitutions, but the deploy-backend step does "
        f"not pass them, so Cloud Build leaves them empty: {missing}"
    )


@pytest.mark.parametrize("value", ["", "true", "false", "invalid"])
def test_independent_answer_intake_reaches_the_extracted_deploy(value: str) -> None:
    config = _load("deploy/backend.cloudbuild.yaml")
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = next(e for e in step["env"] if e.startswith("_DRIVE_WORK_DRAIN_SETTINGS="))
    defaults = {**config["substitutions"], "_PKM_ANSWER_REQUESTS_ENABLED": value}
    rendered = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: defaults[m[1]], packed)
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    start = script.index('_PKM_ANSWER_REQUESTS_ENABLED=""')
    parser = script[start : script.index("# Every added control", start)]
    validation_start = script.index('case "${_PKM_ANSWER_REQUESTS_ENABLED:-}" in', start)
    # Exercise the actual answer-intake validation without invoking cloud operations
    # or unrelated payment-secret checks from the deployment script.
    parser += script[validation_start : script.index("esac", validation_start) + 4]
    result = subprocess.run(  # noqa: S603 - fixed repository parser; provider calls excluded
        ["bash", "-c", parser + "\n" + 'printf "%s" "${_PKM_ANSWER_REQUESTS_ENABLED}"'],
        env={**os.environ, "_DRIVE_WORK_DRAIN_SETTINGS": rendered.split("=", 1)[1]},
        text=True,
        capture_output=True,
        check=False,
    )
    if value == "invalid":
        assert result.returncode != 0
        assert result.stdout == ""
    else:
        assert result.returncode == 0, result.stderr
        assert result.stdout == value
    assert (
        'append_optional_env "PKM_ANSWER_REQUESTS_ENABLED" "${_PKM_ANSWER_REQUESTS_ENABLED:-}"'
        in script
    )


def test_retained_answer_mode_secrets_survive_packed_deployment() -> None:
    """Historical settlements keep both mode keys when shared payment mode changes."""
    config = _load("deploy/backend.cloudbuild.yaml")
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = next(e for e in step["env"] if e.startswith("_DRIVE_SECRET_SETTINGS="))
    names = [
        "_PKM_ANSWER_STRIPE_TEST_SECRET_KEY_SECRET",
        "_PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET_SECRET",
        "_PKM_ANSWER_STRIPE_LIVE_SECRET_KEY_SECRET",
        "_PKM_ANSWER_STRIPE_LIVE_WEBHOOK_SECRET_SECRET",
    ]
    values = {
        **config["substitutions"],
        **{name: f"synthetic-secret-{index}" for index, name in enumerate(names)},
    }
    rendered = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: values[m[1]], packed)
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    parser = (REPO_ROOT / "scripts/deploy/backend-drive-secret-settings.sh").read_text()
    # Capture the actual four bindings; no cloud command or secret value is read.
    bindings = "\n".join(
        line
        for line in script.splitlines()
        if line.startswith("append_optional_secret") and any(name in line for name in names)
    )
    capture = 'append_optional_secret() { printf "%s=%s\\n" "$2" "$1"; }\n'
    payload = rendered.split("=", 1)[1]
    duplicate_swap = re.sub(r"answer_test_webhook=[^,]*", "answer_test_secret=duplicate", payload)
    for malformed, supplied in (
        (False, payload),
        (True, payload + ",answer_test_secret=duplicate"),
        (True, duplicate_swap),
    ):
        result = subprocess.run(  # noqa: S603 - fixed repository parser and synthetic substitutions only
            ["bash", "-euc", capture + parser + bindings],
            env={"_DRIVE_SECRET_SETTINGS": supplied},
            text=True,
            capture_output=True,
            check=False,
        )
        if malformed:
            assert result.returncode != 0, "duplicate packed key bypassed the shape guard"
        else:
            assert result.returncode == 0, result.stderr
            assert result.stdout.splitlines() == [f"{name[1:-7]}={values[name]}" for name in names]


def test_cloud_build_upload_includes_the_deploy_shell_and_release_reader():
    from pathspec import GitIgnoreSpec

    rules = (REPO_ROOT / ".gcloudignore").read_text().splitlines()
    upload = GitIgnoreSpec.from_lines(rules)
    for script in (
        "scripts/deploy/backend-deploy.sh",
        "scripts/deploy/backend-capacity-settings.sh",
        "scripts/deploy/verify-managed-vertex-runtime.sh",
        "scripts/deploy/backend-model-settings.sh",
        "scripts/deploy/backend-drive-secret-settings.sh",
        "scripts/deploy/pod-release-env.sh",
        "scripts/deploy/preserve-pod-release.py",
        "scripts/deploy/commerce-preview-bindings.sh",
        "scripts/deploy/scope-commerce-secrets.sh",
    ):
        assert (REPO_ROOT / script).is_file()
        assert not upload.match_file(script), f"Cloud Build would omit {script}"
    assert GitIgnoreSpec.from_lines([*rules, "*.sh"]).match_file(
        "scripts/deploy/pod-release-env.sh"
    ), "The regression control must detect an excluded release reader"


@pytest.mark.parametrize("deploy_env,custom", [("dev", True), ("uat", True), ("dev", False)])
def test_configured_counterpart_secret_references_survive_deploy_extraction(deploy_env, custom):
    config = _load("deploy/backend.cloudbuild.yaml")
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = next(e for e in step["env"] if e.startswith("_REVIEWER_SECRET_SETTINGS="))
    values = {**config["substitutions"]}
    if custom:
        values.update(
            {
                "_REVIEWER_COUNTERPART_UID_SECRET": "OWNER_COUNTERPART_UID",
                "_REVIEWER_COUNTERPART_VAULT_PASSPHRASE_SECRET": "OWNER_COUNTERPART_PHRASE",
            }
        )
    rendered = _SUBSTITUTION.sub(lambda m: values[m[1]], packed).split("=", 1)[1]
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    start = script.index("IFS='|' read -r _REVIEWER_UID_SECRET")
    parser = script[start : script.index("# The Cloud Run capacity knobs", start)]
    start = script.index('append_optional_secret "${_REVIEWER_UID_SECRET}"')
    bindings = script[start : script.index('append_optional_secret "${_RIA_INTELLIGENCE', start)]
    result = subprocess.run(  # noqa: S603 - fixed parser and mount projection, no cloud calls
        [
            "bash",
            "-c",
            'set -eu\nappend_optional_secret() { [ -z "$1" ] || printf \'%s=%s\\n\' "$2" "$1"; }\n'
            + parser
            + bindings,
        ],
        env={
            **os.environ,
            "_REVIEWER_SECRET_SETTINGS": rendered,
            "_DEPLOY_ENV": deploy_env,
            "commerce_preview_prefix": "",
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    expected = (
        {
            "REVIEWER_COUNTERPART_UID=OWNER_COUNTERPART_UID",
            "REVIEWER_COUNTERPART_VAULT_PASSPHRASE=OWNER_COUNTERPART_PHRASE",
        }
        if custom
        else {
            "REVIEWER_COUNTERPART_UID=REVIEWER_COUNTERPART_UID",
            "REVIEWER_COUNTERPART_VAULT_PASSPHRASE=REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
        }
    )
    assert expected <= set(result.stdout.splitlines())


@pytest.mark.parametrize("deploy_env", ["dev", "uat", "production"])
@pytest.mark.parametrize("configured", [False, True])
def test_dev_bank_defaults_preserve_other_lanes_and_explicit_bindings(deploy_env, configured):
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    start = script.index("# Dev's optional bank setup")
    parser = script[start : script.index('case "${_PKM_ANSWER_REQUESTS_ENABLED', start)]
    names = (
        "_STRIPE_CONNECT_SECRET_KEY_SECRET",
        "_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET",
        "_STRIPE_CONNECT_MODE",
    )
    values = ("CUSTOM_KEY", "CUSTOM_WEBHOOK", "live") if configured else ("", "", "")
    result = subprocess.run(  # noqa: S603 - actual deploy parser, no provider/cloud access
        [
            "bash",
            "-eu",
            "-c",
            parser
            + '\nprintf "%s\\n" "${_STRIPE_CONNECT_SECRET_KEY_SECRET}" "${_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET}" "${_STRIPE_CONNECT_MODE}"',
        ],
        env={**os.environ, "_DEPLOY_ENV": deploy_env, **dict(zip(names, values, strict=True))},
        capture_output=True,
        text=True,
        check=True,
    )
    expected = (
        ("STRIPE_CONNECT_SECRET_KEY", "STRIPE_CONNECT_TEST_WEBHOOK_SECRET", "test")
        if deploy_env == "dev" and not configured
        else values
    )
    assert result.stdout.splitlines() == list(expected)


@pytest.mark.parametrize("deploy_env", ["dev", "uat", "production"])
def test_shared_files_pilot_bindings_do_not_enable_existing_or_other_lane_revisions(deploy_env):
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    start = script.index("# Bind the qualified ciphertext pilot")
    end = script.index('append_optional_secret "${_GMAIL_OAUTH_CLIENT_ID_SECRET}"', start)
    result = subprocess.run(  # noqa: S603 - reviewed repository shell block, synthetic environment only
        [
            "bash",
            "-eu",
            "-c",
            'append_optional_secret() { [[ -n "$1" ]] || return 0; printf "%s=%s\\n" "$2" "$1"; }\n'
            + script[start:end]
            + '\nappend_optional_secret "${_EXTERNAL_CONNECTOR_CREDENTIAL_KEY_SECRET}" "EXTERNAL_CONNECTOR_CREDENTIAL_KEY"',
        ],
        env={"_DEPLOY_ENV": deploy_env, "_EXTERNAL_CONNECTOR_CREDENTIAL_KEY_SECRET": ""},
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.splitlines() == (
        [
            "HUSSH_SHARED_FILES_ENABLED=HUSSH_SHARED_FILES_ENABLED",
            "HUSSH_SHARED_FILES_BUCKET=HUSSH_SHARED_FILES_BUCKET",
            "EXTERNAL_CONNECTOR_CREDENTIAL_KEY=EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
        ]
        if deploy_env == "dev"
        else []
    )
