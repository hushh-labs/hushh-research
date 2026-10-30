"""Ensure the command card's durable Location APIs are mounted in One's router."""

from api.routes.one import router


def test_one_router_mounts_location_command_runtime_endpoints() -> None:
    """A command-issued card must be able to settle its leased server run."""

    paths = {getattr(route, "path", "") for route in router.routes}

    assert "/api/one/workflows/location/onboarding/runs" in paths
    assert "/api/one/workflows/location/onboarding/runs/{run_id}" in paths
    assert (
        "/api/one/workflows/location/onboarding/runs/{run_id}/interactions/{directive_id}" in paths
    )
