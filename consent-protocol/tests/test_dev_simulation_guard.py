"""The simulation guard must fail CLOSED, and these tests are the argument.

Reviewer-cohort provisioning skips a verified phone and a validated AI key. Those
are the two controls standing between an account and billable compute, so the
guard that permits skipping them is the highest-consequence boolean in the
simulation surface.

The specific hazard being pinned: ``actor_identity_service._runtime_environment``
defaults to ``"development"`` when ENVIRONMENT, HUSHH_DEPLOY_ENV and APP_ENV are
all unset, and the existing review check permits everything that is not
production. A container that loses its environment configuration therefore reads
as a development box. For an email alias code that is an acceptable trade. For
"mint fifty unverified accounts and provision pods for them" it is not, and these
tests exist so nobody re-introduces that default here by symmetry with the older
module.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.dev_simulation_guard import (
    SimulationNotPermittedError,
    guard_status,
    require_simulation_permitted,
    simulation_permitted,
)

_ALL_SIGNALS = (
    "HUSHH_DEV_SIMULATION_ENABLED",
    "ENVIRONMENT",
    "APP_ENV",
    "HUSHH_DEPLOY_ENV",
    "DEPLOY_ENV",
    "_DEPLOY_ENV",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in _ALL_SIGNALS:
        monkeypatch.delenv(name, raising=False)


def test_denies_when_nothing_is_configured():
    """The whole point. No configuration is not evidence of a dev box."""
    assert simulation_permitted() is False


def test_denies_when_only_the_opt_in_is_set(monkeypatch):
    """An opt-in flag alone must not be enough.

    Otherwise a stray environment variable in any deployment turns the bypass on,
    which is exactly the shape of accident this guard exists to survive.
    """
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    assert simulation_permitted() is False


def test_denies_when_only_the_environment_is_dev(monkeypatch):
    """Being a dev box is not consent to mint unverified accounts."""
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert simulation_permitted() is False


def test_permits_only_with_opt_in_AND_a_named_dev_lane(monkeypatch):
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert simulation_permitted() is True


@pytest.mark.parametrize("lane", ["prod", "production", "uat", "staging"])
def test_forbidden_lanes_deny_even_with_full_opt_in(monkeypatch, lane):
    """The redundant wall.

    Already implied by the allowlist, but a future edit that widens the allowlist
    should still hit something. Belt and braces is proportionate when the failure
    mode is unverified accounts in production.
    """
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("_DEPLOY_ENV", lane)
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert simulation_permitted() is False


def test_uat_is_refused_even_though_the_dev_hub_runs_as_uat(monkeypatch):
    """The trap this codebase already contains.

    The dev hub deliberately runs with `_RUNTIME_ENVIRONMENT=uat` for behaviour
    parity with the next lane up. So the runtime name says "uat" on a dev box --
    which means admitting "uat" here to accommodate dev would also admit real
    UAT. The deploy lane is the signal that stays honest.
    """
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert simulation_permitted() is False

    # ...and the same box, read by its deploy lane, is correctly permitted.
    monkeypatch.setenv("_DEPLOY_ENV", "dev")
    assert simulation_permitted() is True


@pytest.mark.parametrize("lane", ["sandbox", "qa", "preview", "", "  "])
def test_unrecognised_deploy_lane_denies(monkeypatch, lane):
    """Because the lane is authoritative, it must also be authoritative when it
    says something nobody anticipated.

    A new lane added to the deploy workflows must be admitted here DELIBERATELY.
    Defaulting an unknown lane to permitted would mean the guard silently
    weakens every time infrastructure grows a new environment.
    """
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("_DEPLOY_ENV", lane)
    # A blank lane falls through to the runtime name, which is unset here.
    assert simulation_permitted() is False


def test_dev_lane_wins_over_a_production_runtime_name(monkeypatch):
    """The inverse of the uat case, stated so the precedence is unambiguous.

    If a box is deployed to dev but somehow carries a production runtime name,
    the lane still decides. That is the same rule, and writing it down stops a
    future reader from "fixing" the precedence in the wrong direction.
    """
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("_DEPLOY_ENV", "dev")
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert simulation_permitted() is True


def test_require_raises_rather_than_returning_falsy(monkeypatch):
    """A refused bypass must be loud.

    A bypass that silently does nothing in production is indistinguishable from
    one that silently works, and the difference only surfaces as a bill.
    """
    with pytest.raises(SimulationNotPermittedError) as excinfo:
        require_simulation_permitted("reviewer cohort provisioning")
    message = str(excinfo.value)
    assert "reviewer cohort provisioning" in message
    # The message must say what was observed, or the first thing anyone does is
    # add a print statement to find out.
    assert "lane=" in message and "environment=" in message


def test_require_is_silent_when_permitted(monkeypatch):
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("_DEPLOY_ENV", "dev")
    require_simulation_permitted()


def test_status_explains_the_decision(monkeypatch):
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "true")
    monkeypatch.setenv("_DEPLOY_ENV", "dev")
    status = guard_status()
    assert status["permitted"] is True
    assert status["opt_in_set"] is True
    assert status["deploy_lane"] == "dev"
    assert "production" in status["forbidden_environments"]


def test_no_environment_default_is_smuggled_in(monkeypatch):
    """Pins the absence of the fail-open default, not just today's behaviour.

    `runtime_environment()` must report emptiness as emptiness. If someone later
    gives it a `"development"` fallback -- matching the older module -- this
    fails, and the test names why that would be wrong.
    """
    from hushh_mcp.services.dev_simulation_guard import runtime_environment

    assert runtime_environment() == ""
