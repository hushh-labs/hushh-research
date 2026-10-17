"""An owner Azure cloud reaches provisioning through the provider-neutral shared layer.

Readiness is "every declared coordinate present and authorized", decided beside the
target ids in compute_backend, so user_cloud_service and the orchestrator never spell
a provider. The PodSpec projection carries the Azure coordinates to every builder."""

from __future__ import annotations

from dataclasses import fields

import pytest

from hushh_mcp.services.compute_backend import NullBackend, PodSpec
from hushh_mcp.services.user_cloud_service import (
    UserCloud,
    spec_coordinates,
    spec_coordinates_from_row,
    user_cloud_from_row,
)

_ROW = {
    "deployment_target": "user_azure",
    "model_credential_mode": "user_azure_mi",
    "user_cloud_region": "eastus2",
    "user_cloud_tenant_id": "11111111-1111-1111-1111-111111111111",
    "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
    "user_cloud_resource_group": "rg-hussh-one-0123456789abcdef0123",
    "user_cloud_authorized_at": "2026-10-02T00:00:00Z",
}


def test_a_complete_authorized_azure_cloud_is_ready_and_does_not_block():
    cloud = user_cloud_from_row(_ROW)
    assert cloud is not None and cloud.is_user_owned
    assert cloud.is_ready_to_provision and not cloud.blocks_provisioning
    assert (cloud.tenant_id, cloud.subscription_id, cloud.resource_group) == (
        _ROW["user_cloud_tenant_id"],
        _ROW["user_cloud_subscription_id"],
        _ROW["user_cloud_resource_group"],
    )


@pytest.mark.parametrize(
    "column",
    [
        "user_cloud_tenant_id",
        "user_cloud_subscription_id",
        "user_cloud_resource_group",
        "user_cloud_region",
        "user_cloud_authorized_at",
    ],
)
def test_any_missing_coordinate_or_proof_blocks_provisioning(column):
    cloud = user_cloud_from_row({**_ROW, column: None})
    assert cloud is not None and cloud.blocks_provisioning


def test_a_gcp_project_does_not_make_an_azure_cloud_ready():
    cloud = user_cloud_from_row(
        {**_ROW, "user_cloud_resource_group": None, "user_cloud_project": "p"}
    )
    assert cloud is not None and cloud.blocks_provisioning


def test_gcp_readiness_is_unchanged():
    gcp = UserCloud(
        deployment_target="user_gcp", model_credential_mode="user_adc", project="p",
        region=None, bootstrap_sa="b", authorized=True,
    )  # fmt: skip
    assert gcp.is_ready_to_provision
    assert UserCloud("user_gcp", None, None, None, None, True).blocks_provisioning


def test_the_projection_names_only_real_podspec_fields():
    podspec_fields = {f.name for f in fields(PodSpec)}
    cloud = user_cloud_from_row(_ROW)
    assert set(spec_coordinates(cloud)) <= podspec_fields
    assert spec_coordinates(None) == dict.fromkeys(spec_coordinates(cloud))
    assert spec_coordinates_from_row(_ROW) == spec_coordinates(cloud)
    assert spec_coordinates_from_row({"user_cloud_project": ""})["user_cloud_project"] is None


def test_the_orchestrator_resolves_the_owner_azure_backend_from_the_projection():
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

    service = PersonalAgentProvisioningService(registry=object(), backend=NullBackend())
    spec = PodSpec(
        hushh_id="ha1_x",
        phone_e164_hash="h",
        pod_pubkey="",
        deployment_target="user_azure",
        **spec_coordinates(user_cloud_from_row(_ROW)),
    )
    assert isinstance(service._backend_for(spec), UserAzureBackend)
