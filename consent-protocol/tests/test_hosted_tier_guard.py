"""Managed creation is disabled until sharded capacity and per-pod custody qualify.

Configuration cannot bypass that gate; planning and existing resource inspection
remain available. Reviewer phone-verification and BYOC are separate authorities.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.hosted_tier_guard import (
    HostedTierNotPermittedError,
    hosted_pod_creates_permitted,
)

_SPEC = PodSpec(hushh_id="ha1x", phone_e164_hash="h" * 64, pod_pubkey="p" * 43)

_ALL_VARS = (
    "HUSSH_HOSTED_POD_TIER_ENABLED",
    "HUSHH_DEV_SIMULATION_ENABLED",
    "HUSHH_DEPLOY_ENV",
    "DEPLOY_ENV",
    "_DEPLOY_ENV",
    "HUSSH_POD_PROJECT",
    "ENVIRONMENT",
    "APP_ENV",
)


@pytest.fixture
def clean_env(monkeypatch):
    for name in _ALL_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


class _CountingClient:
    """Records creates so a test can assert that none happened."""

    def __init__(self) -> None:
        self.created: list[dict] = []

    def create_service(self, config):  # pragma: no cover - must never be reached
        self.created.append(config)

    def set_invoker_binding(self, name, member):  # pragma: no cover
        pass

    def wait_ready(self, name):  # pragma: no cover
        return True, {}


# --------------------------------------------------------------------------- #
# 1. The matrix: every leg is required, absence denies.
# --------------------------------------------------------------------------- #


def test_nothing_set_denies(clean_env):
    """The failure mode this guards is a container that lost its environment.

    For a reviewer alias code, reading that as "development" is a defensible
    trade. For "create billable per-person compute" it is not.
    """
    assert hosted_pod_creates_permitted() is False


def test_the_flag_alone_denies(clean_env):
    """Being opted in is not the same as being deployed somewhere known."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    assert hosted_pod_creates_permitted() is False


def test_flag_and_lane_without_a_project_denies(clean_env):
    """A hosted fleet must be AIMED.

    Without `HUSSH_POD_PROJECT` the project resolver falls through to ambient
    credentials or `GOOGLE_CLOUD_PROJECT`, and pods materialise in whatever
    project the hub happens to hold. That inheritance is the exact bug the
    resolver's precedence order exists to prevent, so the guard refuses rather
    than letting the fleet land somewhere nobody named.
    """
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    assert hosted_pod_creates_permitted() is False


def test_lane_and_project_without_the_flag_denies(clean_env):
    """Deployment is not consent. The opt-in is a separate, deliberate act."""
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_configuration_cannot_bypass_capacity_and_custody_qualification(clean_env):
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_production_configuration_is_not_qualification(clean_env):
    """Neither a dev nor production flag proves isolated custody or capacity."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-prod")
    assert hosted_pod_creates_permitted() is False


def test_garbage_flag_values_deny(clean_env):
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "maybe")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")
    assert hosted_pod_creates_permitted() is False


def test_whitespace_only_project_denies(clean_env):
    """An empty-string project is how a substitution that resolved to nothing
    arrives. It must read as unset, not as a project named "  "."""
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "   ")
    assert hosted_pod_creates_permitted() is False


# --------------------------------------------------------------------------- #
# 2. The refusal is loud, and names what was refused.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_live_provisioning_refuses_and_names_the_missing_pieces(clean_env):
    """A bypass that silently does nothing is indistinguishable from one that works.

    So the boundary raises rather than returning falsy, and the message carries
    the three observed signals — which are exactly what someone debugging a
    refused provision needs.
    """
    clean_env.setenv("HUSHH_DEPLOY_ENV", "uat")

    backend = GcpBackend(project="p", region="us-central1", live=True, client=object())

    with pytest.raises(HostedTierNotPermittedError) as excinfo:
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})

    message = str(excinfo.value)
    assert "hussh-managed pod provisioning" in message
    assert "uat" in message
    assert "HUSSH_POD_PROJECT" in message


def test_plan_mode_still_renders_everywhere(clean_env):
    """The refusal is at the live-execution boundary, never at render time.

    Rendering costs nothing and bills nothing, and being able to inspect the
    artifact a lane WOULD produce is how several defects in this workstream were
    found. Moving the guard to render time would close that off for no gain.
    """
    clean_env.setenv("ENVIRONMENT", "production")

    config = GcpBackend(project="p", region="us-central1", live=False).render_deploy_config(_SPEC)

    assert config["metadata"]["name"] == "one-pod-ha1x"


# --------------------------------------------------------------------------- #
# 3. The split held: hosted tier ON does not unlock the phone bypass.
# --------------------------------------------------------------------------- #


def test_opening_the_hosted_tier_does_not_open_the_reviewer_bypass(clean_env):
    """The defect this whole module exists to fix.

    One flag used to gate two unrelated things: hussh-managed provisioning and
    the reviewer alias-code / phone-test-code bypass. They were coupled only
    because both happened to be dev-only. Shipping the hosted tier to a lane
    would therefore have silently disabled phone verification on that lane.

    Asserted from both directions so neither flag can be quietly re-merged into
    the other.
    """
    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-prod")

    assert hosted_pod_creates_permitted() is False
    assert simulation_permitted() is False


def test_the_reviewer_bypass_does_not_open_the_hosted_tier(clean_env):
    clean_env.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")

    from hushh_mcp.services.dev_simulation_guard import simulation_permitted

    assert simulation_permitted() is True
    assert hosted_pod_creates_permitted() is False


# --------------------------------------------------------------------------- #
# 4. Break the guard on purpose. It must fail CLOSED.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_a_broken_guard_creates_nothing(clean_env, monkeypatch):
    """If the guard itself raises, no service may be created.

    The property under test is not "the guard denies" — it is "there is no path
    from a broken guard to a billable create". A guard that fails open is absent
    on exactly the day something is wrong with it, which is the day it matters.
    """
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "hussh-one-pods-dev")

    import hushh_mcp.services.hosted_tier_guard as guard

    def _explode(what: str = "") -> None:
        raise ImportError("simulated broken guard")

    monkeypatch.setattr(guard, "require_hosted_pod_creates_permitted", _explode)

    client = _CountingClient()
    backend = GcpBackend(project="p", region="us-central1", live=True, client=client)

    with pytest.raises(ImportError):
        await backend._execute(_SPEC, {"metadata": {"name": "one-pod-ha1x"}})

    assert client.created == []


def test_configured_existing_maintenance_does_not_enable_new_managed_pods(clean_env):
    from hushh_mcp.services.hosted_tier_guard import require_hosted_pod_maintenance_permitted

    with pytest.raises(HostedTierNotPermittedError):
        require_hosted_pod_maintenance_permitted()
    clean_env.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSSH_POD_PROJECT", "synthetic-existing-fleet")
    require_hosted_pod_maintenance_permitted()
    assert hosted_pod_creates_permitted() is False
