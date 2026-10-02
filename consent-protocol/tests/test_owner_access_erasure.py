"""Owner-access erasure through the typed capability, end to end in the orchestrator.

An owner Azure agent lives where Hussh holds no delete authority. Erasure must reach
the backend through ``OwnerAccessErasableBackend`` (never a provider name in the
shared layer), let the pod crypto-erase before any access is touched, revoke Hussh's
own access last, retain the person's receipt on the row, and still leave the account
refused while the person's resources remain.
"""

from __future__ import annotations

import copy

import pytest

from hushh_mcp.services import account_service, pod_migration_transport
from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services.azure_setup_plan import (
    HUSSH_PRINCIPAL,
    Scopes,
    observer_role_id,
    removal_role_id,
    resource_group_name,
    resource_names,
    role_assignment_path,
)
from hushh_mcp.services.compute_backend import OwnerAccessErasableBackend, RestartableBackend
from hushh_mcp.services.personal_agent_owner_access_erasure import owner_access_backend
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.user_azure_backend import UserAzureBackend
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from tests.azure_arm_fake import FakeArm
from tests.test_user_azure_backend import _HUSHH_ID, _OLD, _SOURCE, _SUB, _TENANT, _Http, _spec

OWNER = "synthetic-owner"


def _group() -> str:
    """Keyed by APP_SIGNING_KEY, so computed at test time, never at import."""
    return resource_group_name(_HUSHH_ID)


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


@pytest.fixture
def arm(monkeypatch) -> FakeArm:
    fake = FakeArm()
    setup.run_agent_setup(
        access_token="person-token-for-tests", tenant_id=_TENANT, subscription_id=_SUB,  # noqa: S106
        location="eastus2", spec=_spec(), source_image=f"{_SOURCE}@{_OLD}",
        advance=lambda _s: None, arm=fake, hussh_principal_id="88888888-8888-8888-8888-888888888888",
        http=_Http(), sleep=lambda _s: None,
    )  # fmt: skip
    fake.calls.clear()
    # The real resolver builds the backend from the row; only its observer is faked.
    monkeypatch.setattr(UserAzureBackend, "_observer", lambda self: fake)
    return fake


class _Registry:
    """The registry surface erasure uses, holding one reserved owner row."""

    def __init__(self, snapshot: dict) -> None:
        self.reservation = {
            "version": 1,
            "ownerId": OWNER,
            "attemptId": "attempt-1",
            "hushhId": _HUSHH_ID,
            "phase": "reserved",
            "registrySnapshot": snapshot,
        }
        self.row = {**snapshot, "status": "suspended"}
        self.row["backend_metadata"] = {**snapshot["backend_metadata"], "erasure": self.reservation}
        self.retained: list[dict] = []
        self.receipt_storage_ready = True

    async def verify_erasure_owner_access_preflight(self, *, user_id, reservation) -> bool:
        erasure = self.row["backend_metadata"]["erasure"]
        return self.receipt_storage_ready and reservation == erasure == self.reservation

    async def reserve_erasure(self, *, user_id: str) -> dict:
        return copy.deepcopy(self.row["backend_metadata"]["erasure"])

    async def get(self, user_id: str) -> dict:
        return copy.deepcopy(self.row)

    async def retain_erasure_owner_access(self, *, user_id, reservation, receipt) -> bool:
        if reservation != self.reservation:
            return False
        self.retained.append(receipt)
        self.row["backend_metadata"]["erasure"] = {
            **self.reservation,
            "ownerAccessErasure": receipt,
        }
        return True


def _snapshot(arm: FakeArm) -> dict:
    backend = UserAzureBackend(
        tenant_id=_TENANT, subscription_id=_SUB, resource_group=_group(), location="eastus2",
        observer=lambda: arm,
    )  # fmt: skip
    handle = backend.verified_handle(_HUSHH_ID, backend.observe_sync())
    return {
        "user_id": OWNER,
        "hushh_id": _HUSHH_ID,
        "phone_e164_hash": "h",
        "pod_pubkey": "",
        "status": "provisioned",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "external_agent_id": handle.external_agent_id,
        "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": _group(),
        "user_cloud_region": "eastus2",
        "backend_metadata": dict(handle.backend_metadata or {}),
    }


@pytest.fixture
def remaining(monkeypatch):
    """The account guard keeps refusing: the person's resource group still exists."""
    checks: list[str] = []

    def refuse(self, user_id: str) -> None:
        checks.append(user_id)
        raise account_service.PersonalAgentDeprovisioningRequiredError("resources remain")

    monkeypatch.setattr(
        account_service.AccountService, "assert_personal_agent_external_resources_absent", refuse
    )
    return checks


def _pod(arm: FakeArm, calls: list, *, erased: bool = True):
    def crypto_erase_for_erasure(*, pod_url: str, payload: dict) -> dict:
        calls.append({"url": pod_url, "payload": payload, "writes_before": len(arm.writes())})
        counts = {"deleted": 6, "alreadyAbsent": 3, "records": 3}
        return {"status": "erased", "erased": erased, **payload, **counts}

    return crypto_erase_for_erasure


def _service(registry: _Registry) -> PersonalAgentProvisioningService:
    return PersonalAgentProvisioningService(registry=registry, grant=object())


async def test_erasure_reaches_the_backend_through_the_capability_and_retains_the_receipt(
    arm, remaining, monkeypatch
):
    snapshot, pod_calls = _snapshot(arm), []
    registry = _Registry(snapshot)
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    # The pod erased first, bound to the reserved attempt and the serving incarnation.
    assert len(pod_calls) == 1 and pod_calls[0]["writes_before"] == 0
    payload = pod_calls[0]["payload"]
    assert payload["attemptId"] == "attempt-1" and payload["service"] == "ca-hussh-one-pod"
    assert payload["serviceUid"] == snapshot["backend_metadata"]["serviceUid"]
    assert pod_calls[0]["url"] == snapshot["backend_metadata"]["url"]
    # Hussh revoked its own access last, and the person holds a receipt saying so.
    nonce = snapshot["backend_metadata"]["setupNonce"]
    inputs = UserAzureBackend(
        tenant_id=_TENANT, subscription_id=_SUB, resource_group=_group(), location="eastus2"
    ).plan_inputs(_HUSHH_ID, nonce)
    scopes = Scopes(inputs, resource_names(inputs))
    deletes = [path for method, path in arm.writes() if method == "DELETE"]
    assert deletes[-3:] == [
        role_assignment_path(scopes.app, observer_role_id(inputs), HUSSH_PRINCIPAL),
        role_assignment_path(scopes.environment, observer_role_id(inputs), HUSSH_PRINCIPAL),
        role_assignment_path(scopes.group, removal_role_id(inputs), HUSSH_PRINCIPAL),
    ]
    (receipt,) = registry.retained
    assert receipt["agentErased"]["erased"] is True and receipt["resourceGroup"] == _group()
    assert f"/subscriptions/{_SUB}/resourceGroups/{_group()}" in receipt["remainingResources"]
    assert receipt["keyVault"]["earliestPurgeIfDeletedToday"]
    assert receipt["nextStep"].startswith(f"Delete the resource group {_group()}")
    assert remaining == [OWNER, OWNER]  # still refused after the receipt: fail-closed


async def test_a_retry_never_asks_the_pod_again_and_stays_refused(arm, remaining, monkeypatch):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    writes = len(arm.writes())
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert len(pod_calls) == 1 and len(arm.writes()) == writes and len(registry.retained) == 1


async def test_without_receipt_storage_nothing_irreversible_starts(arm, remaining, monkeypatch):
    """The erase and Hussh's own revocation cannot be repeated; a lost receipt is final."""
    registry, pod_calls = _Registry(_snapshot(arm)), []
    registry.receipt_storage_ready = False
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert pod_calls == [] and arm.writes() == [] and registry.retained == []


async def test_an_unconfirmed_crypto_erase_revokes_and_retains_nothing(arm, remaining, monkeypatch):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    unconfirmed = _pod(arm, pod_calls, erased=False)
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", unconfirmed)
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert len(pod_calls) == 1 and arm.writes() == [] and registry.retained == []


async def test_a_replaced_agent_is_never_erased(arm, remaining, monkeypatch):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    # The reservation recorded an incarnation the subscription no longer serves.
    registry.reservation["registrySnapshot"]["backend_metadata"]["serviceUid"] = "stale"
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert pod_calls == [] and arm.writes() == [] and registry.retained == []


def test_only_a_backend_with_the_capability_takes_this_path(arm):
    service = _service(_Registry(_snapshot(arm)))
    resolved = owner_access_backend(service, _snapshot(arm))
    assert resolved is not None and isinstance(resolved[0], OwnerAccessErasableBackend)
    owner_gcp = {**_snapshot(arm), "deployment_target": "user_gcp", "user_cloud_project": "p-1"}
    assert owner_access_backend(service, owner_gcp) is None  # the existing chain runs
    assert owner_access_backend(service, {**owner_gcp, "user_cloud_project": None}) is None
    assert owner_access_backend(service, {**owner_gcp, "deployment_target": None}) is None
    gcp = UserGcpBackend(user_project="p-1")
    assert not isinstance(gcp, (OwnerAccessErasableBackend, RestartableBackend))
