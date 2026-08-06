"""The one gate that decides whether simulation bypasses may exist at all.

Reviewer-cohort provisioning skips the two controls that otherwise stand between
an account and billable compute: a verified phone and a validated AI key. That is
correct for a development environment and catastrophic anywhere else, so the
decision gets its own module, one function, and a fail-CLOSED rule.

Fail-closed matters here specifically. The existing review-mode check
(``actor_identity_service._may_return_review_alias_code``) asks "is this
production?" and permits everything else — while ``_runtime_environment()``
defaults to ``"development"`` when ``ENVIRONMENT``, ``HUSHH_DEPLOY_ENV`` and
``APP_ENV`` are ALL unset. So a container that lost its environment configuration
is treated as a development box and the bypass turns on. For an alias code that
is a defensible trade. For "provision fifty pods with no verification" it is not.

This module therefore inverts the question. A bypass is permitted only when the
environment **positively asserts** that it is a development lane AND an explicit
opt-in flag is set. Absence of configuration denies. There is deliberately no
"unknown" state that resolves to permitted.
"""

from __future__ import annotations

import os

#: The only environment names that may run simulation bypasses.
#:
#: `uat` is deliberately absent even though the dev hub RUNS with the uat runtime
#: identity for behaviour parity. That parity is exactly why the runtime name
#: cannot be trusted as a lane signal here -- the dev lane reports `uat`, so
#: admitting `uat` would admit real UAT too. The deploy lane is read separately.
_SIMULATION_ENVIRONMENTS = frozenset({"dev", "development", "local", "test", "testing"})

#: Environments where a bypass is refused even if everything else lines up.
#: Redundant with the allowlist by construction; kept because a future edit that
#: widens the allowlist should still hit a wall at production.
_FORBIDDEN_ENVIRONMENTS = frozenset({"prod", "production", "uat", "staging"})

#: The explicit opt-in. Being in a dev environment is not sufficient on its own --
#: a developer's laptop is a dev environment and should not silently gain the
#: ability to mint unverified accounts.
_OPT_IN_FLAG = "HUSHH_DEV_SIMULATION_ENABLED"

#: The deploy lane, which is the honest signal. `_DEPLOY_ENV` is set by the deploy
#: workflow and, unlike the runtime environment name, is not deliberately skewed.
_DEPLOY_LANE_VARS = ("HUSHH_DEPLOY_ENV", "DEPLOY_ENV", "_DEPLOY_ENV")


class SimulationNotPermittedError(RuntimeError):
    """Raised when simulation machinery is reached outside a development lane."""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _flag(name: str) -> bool:
    return _norm(os.getenv(name)) in {"1", "true", "yes", "on"}


def deploy_lane() -> str:
    """The lane this process was deployed into, or empty when unstated.

    Empty is a real answer and is treated as untrusted, not as development.
    """
    for name in _DEPLOY_LANE_VARS:
        value = _norm(os.getenv(name))
        if value:
            return value
    return ""


def runtime_environment() -> str:
    """The runtime environment name, or empty when unstated.

    Deliberately does NOT default to ``development``. The default in
    ``actor_identity_service`` is the fail-open behaviour this module exists to
    avoid; repeating it here would defeat the whole point.
    """
    for name in ("ENVIRONMENT", "APP_ENV", "HUSHH_DEPLOY_ENV"):
        value = _norm(os.getenv(name))
        if value:
            return value
    return ""


def simulation_permitted() -> bool:
    """May this process run reviewer-cohort / simulation bypasses?

    Every condition must hold. Any unset or unrecognised signal denies.
    """
    if not _flag(_OPT_IN_FLAG):
        return False

    lane = deploy_lane()
    environment = runtime_environment()

    # The deploy lane is AUTHORITATIVE whenever it is stated, and the runtime
    # environment is then ignored entirely.
    #
    # That is not a shortcut, it is forced: the dev hub deliberately runs with
    # `_RUNTIME_ENVIRONMENT=uat` for behaviour parity with the next lane up. So
    # the runtime name reads "uat" on a dev box and "uat" on real UAT -- it
    # cannot separate them, and a rule that let it veto would refuse the exact
    # environment this guard exists to permit. `_DEPLOY_ENV` is written by the
    # deploy workflow per lane and stays honest, so it decides.
    if lane:
        return lane in _SIMULATION_ENVIRONMENTS

    # No deploy lane stated: fall back to the runtime name, and be strict with
    # it. Both an explicit refusal and an unrecognised value deny.
    if environment in _FORBIDDEN_ENVIRONMENTS:
        return False
    return environment in _SIMULATION_ENVIRONMENTS


def require_simulation_permitted(what: str = "simulation") -> None:
    """Refuse loudly rather than degrade quietly.

    Callers get an exception, not a falsy return, because a bypass that silently
    does nothing in production is indistinguishable from one that silently works.
    """
    if simulation_permitted():
        return
    raise SimulationNotPermittedError(
        f"{what} is refused: it requires {_OPT_IN_FLAG}=1 AND a deploy lane or "
        f"runtime environment naming one of {sorted(_SIMULATION_ENVIRONMENTS)}. "
        f"Observed lane={deploy_lane()!r} environment={runtime_environment()!r}."
    )


def guard_status() -> dict[str, object]:
    """Why the guard decided what it decided — for an ops surface, not for auth."""
    return {
        "permitted": simulation_permitted(),
        "opt_in_flag": _OPT_IN_FLAG,
        "opt_in_set": _flag(_OPT_IN_FLAG),
        "deploy_lane": deploy_lane(),
        "runtime_environment": runtime_environment(),
        "permitted_environments": sorted(_SIMULATION_ENVIRONMENTS),
        "forbidden_environments": sorted(_FORBIDDEN_ENVIRONMENTS),
    }


__all__ = [
    "SimulationNotPermittedError",
    "simulation_permitted",
    "require_simulation_permitted",
    "guard_status",
    "deploy_lane",
    "runtime_environment",
]
