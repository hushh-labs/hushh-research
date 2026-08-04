"""No Cloud Build step arg may exceed 10,000 characters.

This is the regression guard for a real, week-long outage. Cloud Build caps a single
build-step arg at 10,000 characters. The `deploy-backend` step's inline body crossed that
on 2026-07-28 (commit 363a9932d, 9,559 -> 10,569) and from that moment EVERY backend
deploy failed at submission with:

    INVALID_ARGUMENT: invalid build: invalid .steps field:
    build step 2 arg 1 too long (max: 10000)

`deploy/backend.cloudbuild.yaml` is invoked identically by deploy-dev.yml, deploy-uat.yml
and deploy-production.yml, so one file broke all three lanes at once -- including
production. Nothing surfaced it for a week, because gcloud enforces the cap client-side
before any Build resource exists: there is no failed build to open, no log to read, and
the lanes had simply not been dispatched in that window.

Had this assertion existed, it would have failed on the commit that introduced the
breach, in the PR that introduced it.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Cloud Build's hard cap on a single build-step arg.
CLOUD_BUILD_MAX_ARG = 10_000

CLOUDBUILD_CONFIGS = [
    "deploy/backend.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml",
    "deploy/dev.autodeploy.backend.cloudbuild.yaml",
]


@pytest.mark.parametrize("config_path", CLOUDBUILD_CONFIGS)
def test_no_cloud_build_step_arg_exceeds_the_limit(config_path: str) -> None:
    path = REPO_ROOT / config_path
    if not path.exists():  # a lane may not define every config
        pytest.skip(f"{config_path} not present")

    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    for index, step in enumerate(config.get("steps") or []):
        for arg_index, arg in enumerate(step.get("args") or []):
            size = len(arg)
            assert size < CLOUD_BUILD_MAX_ARG, (
                f"{config_path} step {index} ({step.get('id')}) arg {arg_index} is "
                f"{size} chars, over Cloud Build's {CLOUD_BUILD_MAX_ARG} limit. gcloud "
                f"rejects this config client-side, so NO build is created and every "
                f"deploy lane using this file fails at submission with no log to read. "
                f"Move the body into a script the step invokes."
            )
