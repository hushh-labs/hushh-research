"""Teardown must run against the backend that BUILT the pod, not the process default.

`provision()` has always routed per person via `_backend_for(spec)`. `deprovision()`
used `self._backend`. That asymmetry was an erasure defect, not an inconsistency: for
someone on their own cloud, teardown ran against hushh's default backend -- or
NullBackend, which answers success without doing anything -- and then deleted the
registry row. The only record of WHERE that person's pod lived went with it, leaving a
live, billing Cloud Run service in a customer's project that nothing could name.

It reaches `api/routes/account.py`, the one path where "we deleted everything" has to be
true, and it is not flag-gated there.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)


class _Spy:
    """Stands in for a backend and records whether it was asked to tear anything down."""

    def __init__(self, backend_id: str = "spy") -> None:
        self.backend_id = backend_id
        self.torn_down: list[str] = []

    async def provision(self, spec: Any) -> Any:  # pragma: no cover - unused here
        raise AssertionError("provision must not be called during teardown")

    async def deprovision(self, external_agent_id: str) -> None:
        self.torn_down.append(external_agent_id)


class _Registry:
    def __init__(self, row: dict | None) -> None:
        self.row = row
        self.tombstones: list[dict] = []
        self.deleted: list[str] = []

    async def get(self, user_id: str):
        return self.row

    async def tombstone(self, **kwargs):
        self.tombstones.append(kwargs)

    async def delete(self, user_id: str):
        self.deleted.append(user_id)


class _Grant:
    async def revoke_standing_pkm_read(self, user_id: str, ledger: Any = None) -> None:
        return None


def _byoc_row() -> dict:
    return {
        "user_id": "uid-1",
        "hushh_id": "ha1_abc",
        "external_agent_id": "one-pod-ha1-abc",
        "deployment_target": "user_gcp",
        "user_cloud_project": "their-own-project",
        "user_cloud_region": "us-central1",
        "user_cloud_bootstrap_sa": "one-bootstrap@their-own-project.iam.gserviceaccount.com",
    }


async def test_a_byoc_pod_is_not_torn_down_against_the_deployment_default():
    """The load-bearing assertion.

    The injected backend is the process default. For a person whose row names their own
    cloud it must NOT be the thing teardown talks to -- if it is, the real service in
    their project is never touched and the row that named it is then deleted.

    Broken on purpose: restore `await self._backend.deprovision(external_agent_id)` and
    the spy records the call.
    """
    default_backend = _Spy("gcp")
    registry = _Registry(_byoc_row())
    service = PersonalAgentProvisioningService(
        registry=registry, grant=_Grant(), backend=default_backend
    )

    await service.deprovision(user_id="uid-1")

    assert default_backend.torn_down == [], (
        "a BYOC pod was torn down against the deployment's own backend; the service in "
        "the person's project survives and the row that named it is now gone"
    )


async def test_teardown_still_uses_the_injected_backend_when_the_row_names_no_target():
    """Rows with no per-person target are the deployment's, and must not change.

    This is what keeps every existing caller and every test that passes a fake backend
    working: absent a target, the injected backend IS the right answer.
    """
    default_backend = _Spy("gcp")
    row = {"hushh_id": "ha1_abc", "external_agent_id": "one-pod-ha1-abc"}
    service = PersonalAgentProvisioningService(
        registry=_Registry(row), grant=_Grant(), backend=default_backend
    )

    await service.deprovision(user_id="uid-1")

    assert default_backend.torn_down == ["one-pod-ha1-abc"]


async def test_a_row_is_still_tombstoned_and_deleted_when_teardown_cannot_reach_the_host():
    """Teardown into a revoked project fails, and erasure must still complete.

    A person revoking their grant before deleting their account is their right, not an
    error. Blocking teardown on it would leave them unable to delete their account at
    all -- the worse outcome of the two.
    """
    registry = _Registry(_byoc_row())
    service = PersonalAgentProvisioningService(
        registry=registry, grant=_Grant(), backend=_Spy("gcp")
    )

    await service.deprovision(user_id="uid-1")

    assert registry.deleted == ["uid-1"]
    assert registry.tombstones and registry.tombstones[0]["hushh_id"] == "ha1_abc"
    # The tombstone still names the service, so an orphan is identifiable after the row
    # is gone.
    assert registry.tombstones[0]["external_agent_id"] == "one-pod-ha1-abc"


async def test_a_missing_row_is_still_a_safe_idempotent_teardown():
    registry = _Registry(None)
    backend = _Spy("gcp")
    service = PersonalAgentProvisioningService(registry=registry, grant=_Grant(), backend=backend)

    await service.deprovision(user_id="uid-1")

    assert backend.torn_down == []
    assert registry.deleted == ["uid-1"]
