"""The backend deploy contract's full text — the YAML plus the script it now invokes.

The `deploy-backend` body moved out of `deploy/backend.cloudbuild.yaml` and into
`scripts/deploy/backend-deploy.sh` because Cloud Build caps a single build-step arg at
10,000 characters; the body outgrew that on 2026-07-28 and broke every backend deploy on
all three lanes. See the script's header for the full account.

Assertions about what the deploy *does* must therefore read both files. The split is:

  * the **YAML** still owns the step wiring, the `substitutions:` defaults, and the
    `env:` list that hands values to the script (and those `${_FOO}` tokens must stay in
    the YAML — `deploy-dev.yml`'s skew guard greps for them);
  * the **script** owns the behaviour — every gcloud call, guard and env assembly.

Helpers here are deliberately not fixtures: several of these test modules are plain
functions with no pytest fixture plumbing.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"
BACKEND_DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy" / "backend-deploy.sh"


def backend_deploy_script() -> str:
    """Just the deploy behaviour — what used to be the step's inline `args[-1]`."""
    return BACKEND_DEPLOY_SCRIPT.read_text(encoding="utf-8")


def backend_deploy_surface() -> str:
    """YAML + script, for assertions that do not care which file carries the line."""
    return (
        BACKEND_CLOUDBUILD.read_text(encoding="utf-8") + "\n" + backend_deploy_script()
    )
