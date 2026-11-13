"""`/api/_debug/firebase` is local-only, and the dev deployment does not count.

The gate used to be the environment name alone — safe only because the dev
deployment reported `uat`. Now that dev reports `dev`, the name by itself would open
this diagnostic on an internet-reachable service. That is precisely the regression
`docs/reference/dev-environment-setup.md` predicted when it said the string `dev`
must not be used as `ENVIRONMENT`; the prediction was right, so the gate moved
rather than the environment name.

The deploy lane separates the two: written by the deploy workflow for every hosted
lane, absent on a developer's machine.
"""

from __future__ import annotations

import pytest

from api.routes import debug_firebase

_LANES = ("HUSHH_DEPLOY_ENV", "DEPLOY_ENV", "_DEPLOY_ENV")


@pytest.fixture
def clean(monkeypatch):
    for name in (*_LANES, "ENVIRONMENT", "APP_ENV"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_a_developer_machine_still_gets_the_route(clean):
    """No deploy lane means genuinely local, which is what this route is for."""
    clean.setenv("ENVIRONMENT", "development")
    assert debug_firebase._is_dev() is True

    clean.setenv("ENVIRONMENT", "local")
    assert debug_firebase._is_dev() is True


def test_the_hosted_dev_deployment_does_not(clean):
    """The regression this exists to prevent, stated as the case that must fail."""
    clean.setenv("ENVIRONMENT", "dev")
    clean.setenv("HUSHH_DEPLOY_ENV", "dev")
    assert debug_firebase._is_dev() is False


@pytest.mark.parametrize("lane", ["dev", "uat", "staging", "production"])
def test_no_hosted_lane_opens_it(clean, lane):
    clean.setenv("ENVIRONMENT", "dev")
    clean.setenv("HUSHH_DEPLOY_ENV", lane)
    assert debug_firebase._is_dev() is False


def test_the_environment_name_is_still_required(clean):
    """The lane check narrows the route; it must not widen it."""
    clean.setenv("ENVIRONMENT", "uat")
    assert debug_firebase._is_dev() is False

    clean.setenv("ENVIRONMENT", "production")
    assert debug_firebase._is_dev() is False
