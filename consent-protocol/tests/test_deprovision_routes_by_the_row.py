"""Retained teardown coordinates survive until owner-held erasure is proved.

Historical host-routing tests were superseded by the shared account guard.
Keep this CI entrypoint while proving that no destructive backend is reached.
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.services.account_service import (
    AccountService,
    PersonalAgentDeprovisioningRequiredError,
)
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
    def __init__(self):
        self.revoked = []

    async def revoke_standing_pkm_read(self, user_id: str, ledger: Any = None) -> None:
        self.revoked.append(user_id)


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


@pytest.mark.parametrize("row", [_byoc_row(), {"external_agent_id": "retained"}, None])
@pytest.mark.parametrize("failure", [PersonalAgentDeprovisioningRequiredError, RuntimeError])
async def test_shared_preflight_refusal_preserves_all_authority(monkeypatch, row, failure):
    registry, grant, backend = _Registry(row), _Grant(), _Spy()
    service = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)

    def refuse(self, uid):
        assert uid == "uid-1"
        raise failure("synthetic refusal")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(failure):
        await service.deprovision(user_id="uid-1")
    assert registry.deleted == []
    assert registry.tombstones == []
    assert backend.torn_down == []
    assert grant.revoked == []


async def test_empty_observation_does_not_delete_a_concurrent_provision(monkeypatch):
    registry, grant, backend = _Registry(None), _Grant(), _Spy()
    service = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)

    def observed_empty_then_provisioned(self, uid):
        registry.row = _byoc_row()

    monkeypatch.setattr(
        AccountService,
        "assert_personal_agent_external_resources_absent",
        observed_empty_then_provisioned,
    )
    result = await service.deprovision(user_id="uid-1")
    assert result["noOp"] is True
    assert registry.row == _byoc_row()
    assert registry.deleted == []
    assert registry.tombstones == []
    assert backend.torn_down == []
    assert grant.revoked == []
