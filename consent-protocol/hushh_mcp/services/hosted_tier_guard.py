"""The one gate that decides whether hussh may stand up a pod it operates.

Until 2026-08-25 this decision borrowed `dev_simulation_guard`, and that borrowing
was the defect this module fixes. One flag, `HUSHH_DEV_SIMULATION_ENABLED`, gated
two unrelated things:

  1. hussh-managed pod provisioning (`gcp_backend._execute`), and
  2. the reviewer alias-code / phone-test-code bypass (`api/routes/account.py`).

They were coupled only because both were dev-only at the time. Now that the hosted
tier is a legitimate production path (founder directive, 2026-08-25 -- see the north
star's *hosted production tier* section), opening (1) on a lane would silently have
opened (2) on the same lane: turning on a product tier would have turned off phone
verification. Splitting them is the whole reason this file exists, and the split is
asserted by a test rather than trusted.

What this guard is NOT: a dev-only fence. `dev_simulation_guard` carries a list of
forbidden environments because a reviewer bypass must never exist in production. A
hosted pod in production is the intended state, so an environment allowlist here
would encode the doctrine that was just reversed. The question this guard asks is
different, and narrower:

    Is this process explicitly, deliberately configured to run a hosted fleet,
    and does it know WHERE that fleet lives?

Three conditions, all required, absence denies:

  * `HUSSH_HOSTED_POD_TIER_ENABLED` is affirmatively set. Being deployed is not
    consent to create billable per-person compute.
  * The deploy lane is stated. An unnamed lane is untrusted, exactly as in
    `dev_simulation_guard` -- a container that lost its environment must not be
    read as permission.
  * `HUSSH_POD_PROJECT` is explicitly set. A hosted fleet must be AIMED. Without
    it, `gcp_backend._resolve_pod_project` would fall through to ambient
    credentials or `GOOGLE_CLOUD_PROJECT`, and pods would materialise in whatever
    project the hub happens to hold -- the exact inheritance bug that resolver's
    precedence order was written to prevent.

The lane list lives in deployment configuration (which lanes set the flag), not in
this file. That is deliberate: an allowlist here would have to be edited to ship the
tier, and an allowlist that gets edited to ship is not a control.
"""

from __future__ import annotations

import os

# One definition of "which lane am I", imported rather than re-derived. Two copies
# of a lane reader is two things to keep honest, and the sibling module already
# documents why `_DEPLOY_ENV` is the trustworthy signal and the runtime environment
# name is not (the dev hub deliberately reports `uat` for behaviour parity).
from hushh_mcp.services.dev_simulation_guard import deploy_lane, runtime_environment

#: The explicit opt-in. Separate from `HUSHH_DEV_SIMULATION_ENABLED` on purpose --
#: see the module docstring. Never merge these two flags back together.
#:
#: Spelling is load-bearing and the two prefixes in this codebase are NOT
#: interchangeable: pod-fleet variables are `HUSSH_POD_*` / `HUSSH_*` (double-s,
#: the brand) while lane variables are `HUSHH_*`. A one-letter drift here reads as
#: "not opted in", which fails closed and is therefore silent -- the fleet simply
#: never provisions and the message blames the operator's config.
_OPT_IN_FLAG = "HUSSH_HOSTED_POD_TIER_ENABLED"

#: Where the hosted fleet lives. Read here only to assert it was STATED; the
#: resolution itself stays in `gcp_backend._resolve_pod_project`, which owns the
#: precedence order and records which source won on the handle.
_POD_PROJECT_VAR = "HUSSH_POD_PROJECT"


class HostedTierNotPermittedError(RuntimeError):
    """Raised when a hussh-operated pod create is attempted on a lane that has not
    opted into the hosted tier, or has opted in without aiming it."""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _flag(name: str) -> bool:
    return _norm(os.getenv(name)) in {"1", "true", "yes", "on"}


def hosted_pod_project() -> str:
    """The explicitly-configured hosting project, or empty when unstated."""
    return str(os.getenv(_POD_PROJECT_VAR) or "").strip()


def hosted_pod_creates_permitted() -> bool:
    """May this process create a pod that hussh operates?

    Every condition must hold. Any unset signal denies; there is deliberately no
    "unknown" state that resolves to permitted.
    """
    if not _flag(_OPT_IN_FLAG):
        return False
    if not deploy_lane():
        return False
    return bool(hosted_pod_project())


def require_hosted_pod_creates_permitted(what: str = "hosted pod provisioning") -> None:
    """Refuse loudly rather than degrade quietly.

    Callers get an exception, not a falsy return: a create that silently does
    nothing is indistinguishable from one that worked, and the caller would record
    a registry row for a pod that does not exist.
    """
    if hosted_pod_creates_permitted():
        return
    raise HostedTierNotPermittedError(
        f"{what} is refused: it requires {_OPT_IN_FLAG}=1, a stated deploy lane, and "
        f"{_POD_PROJECT_VAR} naming the project whose Cloud Run this fleet lives in. "
        f"Observed opt_in={_flag(_OPT_IN_FLAG)} lane={deploy_lane()!r} "
        f"project={hosted_pod_project()!r} environment={runtime_environment()!r}."
    )


def guard_status() -> dict[str, object]:
    """Why the guard decided what it decided -- for an ops surface, not for auth."""
    return {
        "permitted": hosted_pod_creates_permitted(),
        "opt_in_flag": _OPT_IN_FLAG,
        "opt_in_set": _flag(_OPT_IN_FLAG),
        "deploy_lane": deploy_lane(),
        "runtime_environment": runtime_environment(),
        "pod_project_var": _POD_PROJECT_VAR,
        "pod_project_set": bool(hosted_pod_project()),
    }


__all__ = [
    "HostedTierNotPermittedError",
    "hosted_pod_creates_permitted",
    "require_hosted_pod_creates_permitted",
    "hosted_pod_project",
    "guard_status",
]
