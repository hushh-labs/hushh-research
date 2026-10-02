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
from hushh_mcp.services.azure_arm_client import ArmError
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
    """The registry surface erasure uses, holding one reserved owner row.

    Mirrors migration 949: the checkpoint is retained once, before the receipt, and
    the receipt only on a reservation that already carries the checkpoint.
    """

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
        self.checkpoints: list[dict] = []
        self.receipt_storage_ready = True
        self.checkpoint_refusals = 0

    @property
    def erasure(self) -> dict:
        return self.row["backend_metadata"]["erasure"]

    async def verify_erasure_owner_access_preflight(self, *, user_id, reservation) -> bool:
        return (
            self.receipt_storage_ready
            and reservation == self.erasure == self.reservation
            and not {"agentCryptoErase", "ownerAccessErasure"} & set(self.erasure)
        )

    async def reserve_erasure(self, *, user_id: str) -> dict:
        return copy.deepcopy(self.erasure)

    async def get(self, user_id: str) -> dict:
        return copy.deepcopy(self.row)

    async def retain_erasure_owner_access_checkpoint(self, *, user_id, reservation, checkpoint):
        if self.checkpoint_refusals:
            self.checkpoint_refusals -= 1
            return False
        if "agentCryptoErase" in self.erasure:
            return self.erasure["agentCryptoErase"] == checkpoint
        if reservation != self.erasure:
            return False
        self.checkpoints.append(copy.deepcopy(checkpoint))
        self.row["backend_metadata"]["erasure"] = {**self.erasure, "agentCryptoErase": checkpoint}
        return True

    async def retain_erasure_owner_access(self, *, user_id, reservation, receipt) -> bool:
        checkpoint = self.erasure.get("agentCryptoErase")
        if reservation != self.erasure or checkpoint is None:
            return False
        if receipt["agentErased"] != checkpoint["agentErased"]:
            return False
        self.retained.append(receipt)
        self.row["backend_metadata"]["erasure"] = {**self.erasure, "ownerAccessErasure": receipt}
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
    (checkpoint,) = registry.checkpoints
    assert checkpoint == {"agentErased": receipt["agentErased"], "resume": {"setupNonce": nonce}}
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
    assert registry.checkpoints == []


async def test_a_replaced_agent_is_never_erased(arm, remaining, monkeypatch):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    # The reservation recorded an incarnation the subscription no longer serves.
    registry.reservation["registrySnapshot"]["backend_metadata"]["serviceUid"] = "stale"
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert pod_calls == [] and arm.writes() == [] and registry.retained == []


# -- a revocation cut short resumes from the checkpoint, never from the pod -------------


def _hussh_grants(snapshot: dict) -> list[str]:
    inputs = UserAzureBackend(
        tenant_id=_TENANT, subscription_id=_SUB, resource_group=_group(), location="eastus2"
    ).plan_inputs(_HUSHH_ID, snapshot["backend_metadata"]["setupNonce"])
    scopes = Scopes(inputs, resource_names(inputs))
    return [
        role_assignment_path(scopes.app, observer_role_id(inputs), HUSSH_PRINCIPAL),
        role_assignment_path(scopes.environment, observer_role_id(inputs), HUSSH_PRINCIPAL),
        role_assignment_path(scopes.group, removal_role_id(inputs), HUSSH_PRINCIPAL),
    ]


def _pod_losing_storage(arm: FakeArm, calls: list):
    """The pod confirms once; after its container grant goes it can never answer again."""
    answer = _pod(arm, calls)

    def crypto_erase_for_erasure(*, pod_url: str, payload: dict) -> dict:
        if any("/containers/" in path for method, path in arm.writes() if method == "DELETE"):
            calls.append({"refused": True})
            raise pod_migration_transport.PodMigrationTransportError("POD_REFUSED_409", "refused")
        return answer(pod_url=pod_url, payload=payload)

    return crypto_erase_for_erasure


_ARM_500 = ArmError("server", status=500, code="InternalServerError", message="", op="erasure")


@pytest.mark.parametrize(
    "fails_on",
    [
        "/registries/",  # an agent grant, after its storage grant went
        "/managedEnvironments/",  # a Hussh observer grant, after the agent read went
    ],
)
async def test_a_transient_arm_error_mid_revocation_resumes_without_the_pod(
    arm, remaining, monkeypatch, fails_on
):
    snapshot, pod_calls = _snapshot(arm), []
    registry = _Registry(snapshot)
    monkeypatch.setattr(
        pod_migration_transport, "crypto_erase_for_erasure", _pod_losing_storage(arm, pod_calls)
    )
    arm.fail("DELETE", fails_on, _ARM_500)
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert registry.retained == [] and len(registry.checkpoints) == 1
    if fails_on == "/managedEnvironments/":
        # Hussh's agent observer grant is already gone: the agent cannot be read now.
        arm.forbidden.add(UserAzureBackend(
            tenant_id=_TENANT, subscription_id=_SUB, resource_group=_group(), location="eastus2"
        ).app_id)  # fmt: skip
    before = len(arm.calls)
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    retry = arm.calls[before:]
    assert [call for call in pod_calls if call.get("refused")] == [] and len(pod_calls) == 1
    assert [method for method, _path, _body in retry if method != "DELETE"] == []  # no reads
    deletes = [path for method, path, _body in retry if method == "DELETE"]
    assert deletes[-3:] == _hussh_grants(snapshot)  # Hussh's own access, last
    (receipt,) = registry.retained
    assert receipt["agentErased"] == registry.checkpoints[0]["agentErased"]
    assert len(receipt["agentAccessRevoked"]) == 5
    assert receipt["husshAccessRevoked"] == _hussh_grants(snapshot)
    assert remaining == [OWNER, OWNER, OWNER]  # still refused: the resource group remains


async def test_no_revocation_starts_until_the_pods_confirmation_is_retained(
    arm, remaining, monkeypatch
):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    registry.checkpoint_refusals = 1  # the database refuses the checkpoint once
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert len(pod_calls) == 1 and arm.writes() == [] and registry.checkpoints == []
    # The pod still holds its access, so asking again is safe: it finishes from its
    # tombstone, and only then does revocation start.
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert len(pod_calls) == 2 and len(registry.checkpoints) == 1 and len(registry.retained) == 1
    assert pod_calls[1]["writes_before"] == 0


async def test_a_checkpoint_that_names_another_agent_revokes_nothing(arm, remaining, monkeypatch):
    registry, pod_calls = _Registry(_snapshot(arm)), []
    monkeypatch.setattr(pod_migration_transport, "crypto_erase_for_erasure", _pod(arm, pod_calls))
    arm.fail("DELETE", "/registries/", _ARM_500)
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    checkpoint = registry.erasure["agentCryptoErase"]
    checkpoint["agentErased"]["serviceUid"] = "another-incarnation"
    writes = len(arm.writes())
    with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
        await _service(registry).deprovision(user_id=OWNER)
    assert len(arm.writes()) == writes and registry.retained == [] and len(pod_calls) == 1


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
