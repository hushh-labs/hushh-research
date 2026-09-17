"""Focused authority tests for durable personal-agent image upgrades."""

from __future__ import annotations

import copy
import hashlib
from types import SimpleNamespace

import pytest

from hushh_mcp.services.compute_backend import BackendHandle
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
    image_digest,
    upgrade_operation_is_recoverable,
    upgrade_release_id,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

OWNER = "owner-1"
HUSHH_ID = "ha1_owner"
SERVICE_UID = "service-uid-1"
SERVICE = "one-pod-owner"
OLD_DIGEST = "sha256:" + "a" * 64
NEW_DIGEST = "sha256:" + "b" * 64
OTHER_DIGEST = "sha256:" + "c" * 64
OLD_IMAGE = "gcr.io/hushh/pod@" + OLD_DIGEST
NEW_IMAGE = "gcr.io/hushh/pod@" + NEW_DIGEST
OTHER_IMAGE = "gcr.io/hushh/pod@" + OTHER_DIGEST


def _row(*, approval: dict | None = None, lease: str | None = None) -> dict:
    metadata = {
        "serviceUid": SERVICE_UID,
        "service": SERVICE,
        "source_image": OLD_IMAGE,
        "image": OLD_IMAGE,
        "image_digest": OLD_DIGEST,
    }
    if approval is not None:
        metadata["upgradeApproval"] = approval
    if lease is not None:
        metadata["upgradeLease"] = lease
    return {
        "user_id": OWNER,
        "hushh_id": HUSHH_ID,
        "phone_e164_hash": "phone-hash",
        "status": "provisioned",
        "backend": "fake",
        "backend_metadata": metadata,
        "billing_space_id": "space-1",
        "pod_pubkey": "public-key",
        "deployment_target": None,
    }


def _approval(row: dict, target: str = NEW_IMAGE, *, status: str = "approved") -> dict:
    return {
        "version": 1,
        "status": status,
        "releaseId": upgrade_release_id(row, target),
        "operationId": "op-original",
        "idempotencyKey": "idem-original",
        "ownerId": OWNER,
        "hushhId": HUSHH_ID,
        "podIncarnation": SERVICE_UID,
        "targetImage": target,
    }


def test_approval_matches_exact_version_digest_and_incarnation():
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    row = _row()
    approval = _approval(row)
    row["backend_metadata"]["upgradeApproval"] = approval

    assert upgrade_approval_matches(row, NEW_IMAGE)

    for key, value in (
        ("version", 2),
        ("targetImage", OTHER_IMAGE),
        ("podIncarnation", "replacement-service-uid"),
        ("operationId", ""),
        ("idempotencyKey", ""),
    ):
        changed = copy.deepcopy(row)
        changed["backend_metadata"]["upgradeApproval"][key] = value
        assert not upgrade_approval_matches(changed, NEW_IMAGE)

    mutable = copy.deepcopy(row)
    mutable["backend_metadata"]["upgradeApproval"]["targetImage"] = "gcr.io/hushh/pod:latest"
    assert not upgrade_approval_matches(mutable, NEW_IMAGE)

    blocked = copy.deepcopy(row)
    blocked["backend_metadata"]["upgradeApproval"]["status"] = "blocked"
    assert not upgrade_approval_matches(blocked, NEW_IMAGE)
    assert upgrade_approval_matches(blocked, NEW_IMAGE, allow_unresolved=True)


def test_unknown_incarnation_cannot_authorize_an_upgrade():
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_approval_matches

    row = _row()
    row["backend_metadata"].pop("serviceUid")
    row["external_agent_id"] = None
    row["backend_metadata"]["service"] = "unknown"
    approval = _approval(row)
    approval["podIncarnation"] = "unknown"
    row["backend_metadata"]["upgradeApproval"] = approval

    assert not upgrade_approval_matches(row, NEW_IMAGE)
    assert not upgrade_operation_is_recoverable(
        {**row, "backend_metadata": {**row["backend_metadata"], "upgradeLease": "lease"}}
    )


class _RecoveryRegistry:
    def __init__(self, row: dict):
        self.row = row
        self.writes: list[dict] = []

    async def get(self, user_id: str):
        assert user_id == OWNER
        return copy.deepcopy(self.row)

    async def record_image_upgrade(self, **fields):
        self.writes.append(fields)
        metadata = fields["backend_metadata"]
        if self.row["backend_metadata"].get("upgradeLease") != fields["expected_lease"]:
            return False
        self.row["backend_metadata"] = {
            **metadata,
            **({"upgradeLease": fields["expected_lease"]} if fields.get("retain_lease") else {}),
        }
        return True


class _ObservingBackend:
    backend_id = "fake"

    def __init__(self, handle: BackendHandle):
        self.handle = handle
        self.observed: list[dict] = []

    async def observe_upgrade(self, spec, receipt):
        self.observed.append({"spec": spec, "receipt": receipt})
        return self.handle


@pytest.mark.asyncio
async def test_blocked_operation_reconciles_even_when_a_newer_target_is_offered(monkeypatch):
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "1")
    monkeypatch.setattr(pas, "resolve_user_cloud", lambda *args, **kwargs: _no_cloud())

    lease = "persisted-lease"
    row = _row(approval=_approval(_row(), OLD_IMAGE, status="blocked"), lease=lease)
    # The operation's approval is for the old target; current hub configuration has
    # moved on. Reconciliation must use the receipt's binding, never the new offer.
    row["backend_metadata"]["upgradeAcknowledgement"] = {
        "version": 1,
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "serviceUid": SERVICE_UID,
        "service": SERVICE,
        "targetImage": OLD_IMAGE,
        "image": OLD_IMAGE,
        "operationId": row["backend_metadata"]["upgradeApproval"]["operationId"],
        "releaseId": row["backend_metadata"]["upgradeApproval"]["releaseId"],
        "podIncarnation": SERVICE_UID,
    }
    registry = _RecoveryRegistry(row)
    backend = _ObservingBackend(
        BackendHandle(
            external_agent_id=SERVICE,
            a2a_route="https://a2a.invalid/owner",
            status="live",
            backend="fake",
            backend_metadata={"image": OLD_IMAGE, "image_digest": OLD_DIGEST},
        )
    )
    service = PersonalAgentProvisioningService(registry=registry, backend=backend)

    result = await service.upgrade_pod(user_id=OWNER, current_image=NEW_IMAGE)

    assert result["reconciled"] is True
    assert result["upgraded"] is True
    assert backend.observed
    assert registry.row["backend_metadata"]["upgradeApproval"]["status"] == "succeeded"
    assert "upgradeLease" not in registry.row["backend_metadata"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["planned", "live"])
async def test_nonterminal_or_wrong_digest_provider_result_keeps_the_lease(monkeypatch, status):
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "1")
    monkeypatch.setattr(pas, "resolve_user_cloud", lambda *args, **kwargs: _no_cloud())
    row = _row(approval=_approval(_row()), lease=None)
    registry = _ExecutionRegistry(row)
    handle = BackendHandle(
        external_agent_id=SERVICE,
        a2a_route="https://a2a.invalid/owner",
        status=status,
        backend="fake",
        backend_metadata={"image": OTHER_IMAGE, "image_digest": OTHER_DIGEST},
    )
    backend = _ExecutingBackend(handle)
    service = PersonalAgentProvisioningService(registry=registry, backend=backend)

    with pytest.raises(RuntimeError, match="live terminal outcome|different image digest"):
        await service.upgrade_pod(user_id=OWNER, current_image=NEW_IMAGE)

    assert registry.row["backend_metadata"].get("upgradeLease")
    assert registry.final_writes == []


async def _no_cloud():
    return None


class _ExecutionRegistry(_RecoveryRegistry):
    def __init__(self, row):
        super().__init__(row)
        self.final_writes: list[dict] = []

    async def claim_image_upgrade(self, *, user_id, target_image, observed):
        assert user_id == OWNER and target_image == NEW_IMAGE
        lease = "new-lease"
        self.row["backend_metadata"]["upgradeLease"] = lease
        return lease

    async def record_image_upgrade(self, **fields):
        if not fields.get("retain_lease"):
            self.final_writes.append(fields)
        return await super().record_image_upgrade(**fields)


class _ExecutingBackend(_ObservingBackend):
    live = True

    async def upgrade(self, spec):
        return self.handle


class _RawDb:
    def __init__(self, response, row=None):
        self.response = response
        self.row = row
        self.calls: list[tuple[str, dict]] = []

    def execute_raw(self, sql, params):
        self.calls.append((sql, params))
        return self.response

    def table(self, _name):
        db = self

        class Query:
            def select(self, *_args, **_kwargs):
                return self

            def eq(self, *_args, **_kwargs):
                return self

            def limit(self, *_args, **_kwargs):
                return self

            def execute(self):
                return SimpleNamespace(data=[copy.deepcopy(db.row)] if db.row else [])

        return Query()


def _repo_approval(row: dict, **overrides) -> dict:
    approval = _approval(row)
    approval.update(overrides)
    return approval


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"version": 2}, "unsupported upgrade approval version"),
        ({"targetImage": "gcr.io/hushh/pod:latest"}, "immutable image digest"),
        ({"ownerId": "another-owner"}, "owner does not match"),
        ({"podIncarnation": "unknown"}, "verified pod incarnation"),
        ({"releaseId": "rel_not_bound_to_target"}, "not bound to its image"),
    ],
)
async def test_registry_rejects_unbound_approval_before_sql(overrides, message):
    row = _row()
    db = _RawDb(SimpleNamespace(data=[]))
    repo = PersonalAgentRegistryRepo(client=db)

    with pytest.raises(ValueError, match=message):
        await repo.record_upgrade_approval(user_id=OWNER, approval=_repo_approval(row, **overrides))

    assert db.calls == []


@pytest.mark.asyncio
async def test_registry_retry_returns_the_original_operation_and_keeps_uncertain_blocked_rows():
    row = _row()
    winner = _repo_approval(row, status="approved")
    db = _RawDb(SimpleNamespace(data=[]), row={"backend_metadata": {"upgradeApproval": winner}})
    repo = PersonalAgentRegistryRepo(client=db)

    retry = _repo_approval(row, operationId="op-new-client-instance")
    stored = await repo.record_upgrade_approval(user_id=OWNER, approval=retry)

    assert stored == winner
    sql, params = db.calls[0]
    assert "idempotencyKey" in sql
    assert "('succeeded', 'failed')" in sql
    assert "'blocked'" not in sql
    assert params["idempotency_key"] == winner["idempotencyKey"]
    assert params["target_image"] == winner["targetImage"]


def test_image_digest_rejects_unpinned_and_accepts_complete_oci_digest():
    assert image_digest(NEW_IMAGE) == NEW_DIGEST
    assert image_digest("gcr.io/hushh/pod:latest") is None
    assert image_digest("gcr.io/hushh/pod@sha256:abcd") is None
