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

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Cloud Build's hard cap on a single build-step arg.
CLOUD_BUILD_MAX_ARG = 10_000

# Refuse to land a change that leaves less than this much room. Without a margin the
# suite goes green at 9,999 and the very next secret ref breaks all three deploy lanes.
REQUIRED_HEADROOM = 500

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


def test_capacity_knobs_travel_packed_and_unpack_to_the_same_names() -> None:
    config = _load("deploy/backend.cloudbuild.yaml") or {}
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = [e for e in step.get("env") or [] if e.startswith("_CLOUD_RUN_CAPACITY=")]
    assert len(packed) == 1, "the capacity knobs must travel as exactly one packed entry"
    for key in (
        "max=${_CLOUD_RUN_MAX_INSTANCES}",
        "cpu=${_CLOUD_RUN_CPU}",
        "no_traffic=${_CLOUD_RUN_NO_TRAFFIC}",
    ):
        assert key in packed[0]
    assert not any(e.startswith("_CLOUD_RUN_CPU=") for e in step.get("env") or [])
    script = (REPO_ROOT / "scripts/deploy/backend-deploy.sh").read_text(encoding="utf-8")
    assert 'cpu) _CLOUD_RUN_CPU="${_value}" ;;' in script
    assert '"--cpu=${_CLOUD_RUN_CPU}"' in script


def test_every_substitution_the_deploy_script_reads_is_fed_through_the_step_env() -> None:
    """Ported from main during the 2026-09-02 sync, adapted to the extracted script.

    Main asserted this against an inline `for n in ...; do v="_${n}"; add_env` loop in
    the build body. This branch moved that body into `scripts/deploy/backend-deploy.sh`
    (the 10,000-character step-arg ceiling), so the same defect now takes a different
    shape: the script reads `${_FOO}`, and Cloud Build only provides it when `_FOO` is
    listed in the step's `env:` field. A name the script reads with no env entry
    silently deploys nothing -- which is exactly what happened to the Gmail monitor
    settings on main, and to `_HUSSH_GEMINI_TEXT_MODEL` on this branch until this sync.
    """
    root = Path(__file__).resolve().parents[2]
    script = (root / "scripts" / "deploy" / "backend-deploy.sh").read_text(encoding="utf-8")
    config = _load("deploy/backend.cloudbuild.yaml")
    assert config is not None
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    provided = {entry.split("=", 1)[0] for entry in step.get("env") or []}
    packed = " ".join(entry for entry in step.get("env") or [] if "," in entry)
    # Comments explain the mechanism using placeholder names (`${_FOO}`), so read only
    # the executable lines -- a doc example is not a substitution the deploy consumes.
    executable = "\n".join(
        line for line in script.splitlines() if not line.lstrip().startswith("#")
    )
    read_by_script = set(re.findall(r"\$\{(_[A-Z0-9_]+)(?::-[^}]*)?\}", executable))
    missing = sorted(
        name
        for name in read_by_script
        if name not in provided and name not in packed and name != "_PACKED"
    )
    assert not missing, (
        "backend-deploy.sh reads these substitutions, but the deploy-backend step does "
        f"not pass them, so Cloud Build leaves them empty: {missing}"
    )
