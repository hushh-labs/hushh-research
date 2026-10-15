"""Cloud Build step args and env mappings stay within submission limits.

This is the regression guard for a real, repeated outage. Cloud Build caps a single
build-step arg at 10,000 characters. The `deploy-backend` step's inline bash body is
ONE such arg, and it crossed the cap twice:

  * 2026-07-28 (commit 363a9932d, 9,559 -> 10,569 raw) -- every backend deploy failed
    at submission for roughly a week.
  * 2026-08-04 (PR #4791, Wallet Profile, 10,657 -> 11,246 raw) -- the UAT deploy of
    release ba39d0342 failed with:

        INVALID_ARGUMENT: invalid build: invalid .steps field:
        build step 1 arg 1 too long (max: 10000)

`deploy/backend.cloudbuild.yaml` is invoked identically by deploy-dev.yml, deploy-uat.yml
and deploy-production.yml, so one file breaks all three lanes at once -- including
production. Nothing surfaces it, because gcloud enforces the cap client-side before any
Build resource exists: there is no failed build to open and no log to read.

WHAT IS ACTUALLY MEASURED. Cloud Build applies substitutions BEFORE enforcing the cap,
so the raw YAML length is not the number that matters -- it is only an upper bound, and
a loose one. The 2026-08-04 breach is the proof: the same raw body (10,657) was UNDER
the cap once substituted for production but OVER it for UAT, because UAT passes longer
substitution values. A raw-only assertion would therefore have called production healthy
while UAT was broken. This module asserts both:

  1. the raw body stays under the cap (cheap, catches gross growth), and
  2. the SUBSTITUTED body stays under the cap for every deploy lane (the real check).

WHERE TO PUT COMMENTS. Prose inside the bash body counts against the cap; prose at the
YAML step level does not. Keep explanatory comments above the step, not inside `args`.
If the body itself must grow past the cap, move it into a script the step invokes and
pass substitutions through the step's `env:` field.
"""

from __future__ import annotations

import os
import re
import runpy
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
REQUIRED_ENV_HEADROOM = 20

CLOUDBUILD_CONFIGS = [
    "deploy/backend.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml",
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


def _backend_deploy_body() -> str:
    config = _load("deploy/backend.cloudbuild.yaml")
    assert config is not None, "deploy/backend.cloudbuild.yaml is missing"
    for step in config.get("steps") or []:
        if step.get("id") == "deploy-backend":
            return step["args"][1]
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
    stubs = 'add_secret() { :; }\nadd_env() { echo "$1=$2"; }\n'
    packed = "true|https://a.example/login|https://a.example,https://b.example"
    run = subprocess.run(  # noqa: S603 - fixed shell and repository script; fixed inputs
        ["bash", "-c", f"{stubs}source {script}"],
        env={**os.environ, "_WORKOS_CONFIG": packed},
        capture_output=True,
        text=True,
        check=False,
    )
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

    body = _backend_deploy_body()
    values = _default_substitutions()
    values.update(_workflow_substitutions(workflow_path))

    substituted = _SUBSTITUTION.sub(lambda m: values.get(m.group(1), ""), body)
    size = len(substituted)
    headroom = CLOUD_BUILD_MAX_ARG - size

    assert size < CLOUD_BUILD_MAX_ARG, (
        f"{workflow_path} would submit a deploy-backend arg of {size} chars after "
        f"substitution, over Cloud Build's {CLOUD_BUILD_MAX_ARG} limit. This lane's "
        f"deploys fail at submission. Note the raw body may still look fine -- lanes "
        f"differ because they pass different substitution values."
    )
    assert headroom >= REQUIRED_HEADROOM, (
        f"{workflow_path} would submit {size} chars, only {headroom} under Cloud "
        f"Build's {CLOUD_BUILD_MAX_ARG} limit (need >= {REQUIRED_HEADROOM}). This is "
        f"too close to ship: the next secret ref or env var breaks every deploy lane. "
        f"Move prose above the step, or extract the body into a script."
    )


@pytest.mark.parametrize("config_path", CLOUDBUILD_CONFIGS)
def test_substituted_cloud_build_steps_have_env_headroom(config_path: str) -> None:
    """Cloud Build rejects a build if any step has more than 100 env entries."""
    config = _load(config_path)
    if config is None:
        pytest.skip(f"{config_path} not present")
    lanes = BACKEND_DEPLOY_WORKFLOWS if config_path == "deploy/backend.cloudbuild.yaml" else [None]
    for lane in lanes:
        values = {
            key: "" if value is None else str(value)
            for key, value in (config.get("substitutions") or {}).items()
        }
        if lane:
            values.update(_workflow_substitutions(lane))
        for index, step in enumerate(config.get("steps") or []):
            env = [
                _SUBSTITUTION.sub(
                    lambda match, values=values: values.get(match.group(1), ""), entry
                )
                for entry in step.get("env") or []
            ]
            assert len(env) <= CLOUD_BUILD_MAX_ENV - REQUIRED_ENV_HEADROOM, (
                f"{config_path} {lane or 'defaults'} step {index} ({step.get('id')}) "
                f"has {len(env)} env entries after substitutions; Cloud Build allows "
                f"{CLOUD_BUILD_MAX_ENV}, and this guard requires "
                f"{REQUIRED_ENV_HEADROOM} spare entries."
            )


def test_optional_secret_bundle_is_counted_by_coverage_and_rejects_mapping_drift() -> None:
    """Packed names must still count as bound secrets for all deploy lanes."""
    text = (REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text(encoding="utf-8")
    coverage = runpy.run_path(str(REPO_ROOT / "scripts/ci/check-deploy-secret-coverage.py"))
    parsed = coverage["_bundled_optional_substitutions"](text)
    assert "_STRIPE_SECRET_KEY_SECRET" in parsed
    assert "_GOOGLE_PRIVATE_KEY_SECRET" in parsed
    assert "_WALLET_API_KEY_SECRET" in parsed
    defaults = coverage["_defaults"](text)
    assert set(parsed) <= set(defaults)
    assert {name for name in parsed if defaults.get(name) == ""} <= set(
        coverage["bound_substitutions"]()
    )

    swapped = text.replace(
        "WALLET_API_KEY=${_WALLET_API_KEY_SECRET}",
        "WALLET_API_KEY=${_OPENAI_API_KEY_SECRET}",
        1,
    )
    with pytest.raises(ValueError, match="does not match"):
        coverage["_bundled_optional_substitutions"](swapped)


def test_optional_secret_bundle_fails_closed_on_extra_or_invalid_secret_names() -> None:
    """Exercise the actual bash parser with data that could shift a secret binding."""
    body = _backend_deploy_body()
    start = body.index('IFS="|" read -r -a optional_secret_names')
    end = body.index('for s in $(echo "${_CURATED_CONNECTOR_SECRETS}"', start)
    snippet = body[start:end]
    script = 'set -euo pipefail\nadd_secret() { printf "%s=%s\\n" "$2" "$1"; }\n' + snippet

    def run(bindings: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - repository bash snippet, synthetic bindings only.
            ["bash", "-c", script],
            env={"OPTIONAL_SECRET_NAMES": "FIRST|SECOND", "OPTIONAL_SECRET_BINDINGS": bindings},
            capture_output=True,
            text=True,
            check=False,
        )

    valid = run("FIRST=alpha|SECOND=beta")
    assert valid.returncode == 0, valid.stderr
    assert valid.stdout.splitlines() == ["FIRST=alpha", "SECOND=beta"]
    for invalid in (
        "FIRST=first|INJECTED=other|SECOND=second",
        "FIRST=first|SECOND=second|",
        "FIRST=first|SECOND=bad secret",
        "FIRST=first|SECOND=second\nINJECTED=other",
    ):
        assert run(invalid).returncode != 0


_INDIRECT_LOOP = re.compile(
    r"for n in ([A-Z0-9_ ]+); do\s+v=\"_\$\{n\}\"\s+add_env \"\$\{n\}\" \"\$\{!v\}\"", re.S
)


def test_indirectly_expanded_env_names_are_fed_through_the_step_env_field() -> None:
    """`${!v}` reads a shell variable, which Cloud Build only provides when the
    substitution is passed through the step's `env:` field (there is no
    automapSubstitutions here). A name in the loop without an env entry silently
    deploys nothing, which is what happened to the Gmail monitor settings."""
    config = _load("deploy/backend.cloudbuild.yaml")
    assert config is not None
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    body = step["args"][1]
    loops = _INDIRECT_LOOP.findall(body)
    assert loops, "the deploy-backend body no longer feeds add_env through a loop"
    looped = {name for group in loops for name in group.split()}
    provided = {
        entry.split("=", 1)[0]
        for entry in step.get("env") or []
        if entry.split("=", 1)[1] == "${" + entry.split("=", 1)[0] + "}"
    }
    assert {f"_{name}" for name in looped} <= provided, sorted(
        f"_{name}" for name in looped if f"_{name}" not in provided
    )
    declared = set((config.get("substitutions") or {}).keys())
    assert provided <= declared, sorted(provided - declared)
