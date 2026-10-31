"""Owner isolation and lost-write recovery for explicit Azure model maintenance."""

from __future__ import annotations

import copy
import hashlib

import pytest

from hushh_mcp.services.azure_model_enablement import (
    AzureModelEnablementPlan,
    initial_record,
    plan_from_observation,
    verified_completion,
)
from hushh_mcp.services.azure_model_maintenance import ModelRepairUnconfirmed, enable_owner_model
from hushh_mcp.services.azure_setup_plan import ModelChoice
from tests.test_user_azure_backend import (  # noqa: F401 -- canonical ARM/setup fixtures
    _HUSHH_ID,
    _SUB,
    _TENANT,
    _backend,
    _hub_caller,
)
from tests.test_user_azure_backend import arm as azure_arm  # noqa: F401 -- fixture registration


class _Registry:
    def __init__(self, row):
        self.row = copy.deepcopy(row)

    async def get(self, owner):
        return copy.deepcopy(self.row) if self.row["user_id"] == owner else None

    async def claim_image_upgrade(self, *, user_id, observed, model_enablement_plan, **_):
        if self.row != observed or self.row["backend_metadata"].get("upgradeLease"):
            return None
        self.row["backend_metadata"]["upgradeLease"] = "synthetic-model-lease|single-attempt"
        self.row["backend_metadata"]["modelEnablement"] = initial_record(
            AzureModelEnablementPlan.model_validate(model_enablement_plan),
            self.row["backend_metadata"]["upgradeLease"],
        )
        return self.row["backend_metadata"]["upgradeLease"]

    async def record_image_upgrade(
        self,
        *,
        user_id,
        expected_lease,
        observed,
        backend_metadata,
        require_unchanged_metadata,
        retain_lease=False,
        model_credential_mode=None,
        **_,
    ):
        assert require_unchanged_metadata is True
        if (
            self.row != observed
            or self.row["backend_metadata"].get("upgradeLease") != expected_lease
        ):
            return False
        if model_credential_mode:
            assert verified_completion(observed, backend_metadata, expected_lease)
            self.row["model_credential_mode"] = model_credential_mode
        self.row["backend_metadata"] = copy.deepcopy(backend_metadata)
        if not retain_lease:
            self.row["backend_metadata"].pop("upgradeLease", None)
        return True


class _Handoff:
    refused = False
    model_ready = True
    endpoint = ""
    accessible = True
    calls = []

    def __init__(self, **_):
        pass

    def prepare_and_wait(self, *, operation_id, incarnation):
        self.calls.append(operation_id)
        if self.refused:
            raise ModelRepairUnconfirmed("Synthetic busy pod")
        return {
            "operationId": operation_id,
            "incarnation": incarnation,
            "activeWork": 0,
            "runtimeEpoch": "synthetic-epoch",
            "committedState": "b" * 64,
        }

    def verify_model(self, *, deployment, expected_revision):
        return {
            "provider": "azure_openai",
            "model": deployment,
            "endpoint": self.endpoint,
            "revision": expected_revision,
            "reachable": self.model_ready,
        }

    def verify_maintenance_access(self, **_):
        if not self.accessible:
            raise ModelRepairUnconfirmed("Synthetic machine-OIDC refusal")


@pytest.fixture
def repair(azure_arm):  # noqa: F811 -- canonical fixture
    arm = azure_arm  # noqa: F811 -- canonical fixture
    backend = _backend(arm)
    app = arm.resources[backend.app_id]
    metadata = backend.verified_handle(_HUSHH_ID, backend.observe_sync()).backend_metadata
    app["properties"]["template"]["containers"][0]["env"] = [
        entry
        for entry in app["properties"]["template"]["containers"][0]["env"]
        if not entry["name"].startswith("AZURE_OPENAI_")
    ]
    row = {
        "user_id": "synthetic-model-owner",
        "hushh_id": _HUSHH_ID,
        "status": "provisioned",
        "deployment_target": "user_azure",
        "model_credential_mode": "byok_per_turn",
        "external_agent_id": backend.app_id,
        "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": backend._group,
        "user_cloud_region": "eastus2",
        "user_cloud_authorized_at": "2026-10-15",
        "backend_metadata": metadata,
    }
    row["backend_metadata"]["upgradeAcknowledgement"] = {"attemptId": "prior-image-attempt"}
    plan = plan_from_observation(row, app, ModelChoice(name="gpt-5-mini", version="2025-08-07"))
    account = arm.resources[plan.scopes.openai]
    account["properties"]["endpoint"] = plan.environment["AZURE_OPENAI_ENDPOINT"]
    account["properties"]["provisioningState"] = "Succeeded"
    account["location"] = plan.region
    arm.resources.pop(plan.scopes.deployment, None)
    arm.resources.pop(plan.role[0], None)
    original_put = arm.put

    def put(path, **kwargs):
        resource = original_put(path, **kwargs)
        if path == plan.scopes.deployment:
            arm.resources[path]["properties"]["provisioningState"] = "Succeeded"
        return resource

    arm.put = put
    arm.calls.clear()
    _Handoff.refused, _Handoff.calls = False, []
    _Handoff.model_ready = True
    _Handoff.accessible = True
    _Handoff.endpoint = plan.environment["AZURE_OPENAI_ENDPOINT"].split("/")[2]
    return arm, _Registry(row), plan


@pytest.mark.parametrize("lost", ["model", "role", "replacement"])
async def test_lost_write_is_observed_without_repeating_and_mode_publishes_last(repair, lost):
    arm, registry, plan = repair
    path = {"model": plan.scopes.deployment, "role": plan.role[0], "replacement": plan.service_id}[
        lost
    ]
    original_put = arm.put
    failed = False

    def put(target, **kwargs):
        nonlocal failed
        result = original_put(target, **kwargs)
        if target == path and not failed:
            failed = True
            raise ModelRepairUnconfirmed("Synthetic lost response after successful provider write")
        return result

    arm.put = put
    with pytest.raises(ModelRepairUnconfirmed):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert registry.row["model_credential_mode"] == "byok_per_turn"
    assert registry.row["backend_metadata"]["upgradeLease"]
    result = await enable_owner_model(
        registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff
    )
    assert result["status"] == "verified"
    assert [entry for entry in arm.writes() if entry == ("PUT", path)] == [("PUT", path)]
    assert registry.row["model_credential_mode"] == "user_azure_mi"
    assert "upgradeLease" not in registry.row["backend_metadata"]
    assert registry.row["backend_metadata"]["upgradeAcknowledgement"] == {
        "attemptId": "prior-image-attempt"
    }
    record = registry.row["backend_metadata"]["modelEnablement"]
    assert (
        record["attemptId"] == hashlib.sha256(b"synthetic-model-lease|single-attempt").hexdigest()
    )
    writes = copy.deepcopy(arm.writes())
    assert (
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
        == result
    )
    assert arm.writes() == writes


@pytest.mark.parametrize(
    "changed", ["owner", "subscription", "incarnation", "identity", "template"]
)
async def test_stale_owner_or_configuration_never_mutates_provider(repair, changed):
    arm, registry, plan = repair
    if changed == "owner":
        registry.row["user_id"] = "other-owner"
    elif changed == "subscription":
        registry.row["user_cloud_subscription_id"] = "99999999-9999-9999-9999-999999999999"
    else:
        app = arm.resources[plan.service_id]
        if changed == "incarnation":
            app["tags"]["hussh-incarnation"] = "other-incarnation"
        elif changed == "identity":
            next(iter(app["identity"]["userAssignedIdentities"].values()))["principalId"] = (
                "other-principal"
            )
        else:
            app["properties"]["template"]["containers"][0]["resources"]["cpu"] = 2
    with pytest.raises((ValueError, ModelRepairUnconfirmed)):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert arm.writes() == []


async def test_refused_drain_preserves_existing_configuration_and_mode(repair):
    arm, registry, plan = repair
    _Handoff.refused = True
    before = copy.deepcopy(arm.resources[plan.service_id])
    with pytest.raises(ModelRepairUnconfirmed):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert arm.resources[plan.service_id] == before
    assert registry.row["model_credential_mode"] == "byok_per_turn"
    assert registry.row["backend_metadata"]["upgradeLease"]


async def test_lost_initial_claim_keeps_the_plan_and_resumes_without_a_second_claim(repair):
    arm, registry, plan = repair
    claim = registry.claim_image_upgrade

    async def lost_claim(**kwargs):
        await claim(**kwargs)
        raise ModelRepairUnconfirmed("Synthetic lost atomic-claim response")

    registry.claim_image_upgrade = lost_claim
    with pytest.raises(ModelRepairUnconfirmed):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert arm.writes() == []
    assert registry.row["backend_metadata"]["modelEnablement"]["planDigest"] == plan.plan_digest
    assert (
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    )["status"] == "verified"


async def test_failed_runtime_proof_keeps_mode_and_lease_until_actual_inference_succeeds(repair):
    arm, registry, plan = repair
    _Handoff.model_ready = False
    with pytest.raises(ModelRepairUnconfirmed):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert registry.row["model_credential_mode"] == "byok_per_turn"
    assert registry.row["backend_metadata"]["upgradeLease"]
    writes = copy.deepcopy(arm.writes())
    _Handoff.model_ready = True
    assert (
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    )["status"] == "verified"
    assert arm.writes() == writes


async def test_missing_machine_access_refuses_before_any_cloud_write_or_reservation(repair):
    arm, registry, plan = repair
    _Handoff.accessible = False
    with pytest.raises(ModelRepairUnconfirmed):
        await enable_owner_model(registry=registry, arm=arm, plan=plan, handoff_factory=_Handoff)
    assert arm.writes() == []
    assert "upgradeLease" not in registry.row["backend_metadata"]
