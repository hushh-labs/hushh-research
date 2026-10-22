"""Synthetic VM installation over the current real Azure lifecycle schema."""

import hashlib
import json
from pathlib import Path

import pytest

from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation
from tests.test_azure_resource_teardown_postgres import cleanup_connection as cleanup_connection
from tests.test_azure_resource_teardown_postgres import cleanup_pg as cleanup_pg


@pytest.fixture
def vm_installation(cleanup_pg):
    pg, owner, _, _ = cleanup_pg
    row = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (owner,)
    )[0][0]
    group = f"/subscriptions/{row['user_cloud_subscription_id']}/resourceGroups/{row['user_cloud_resource_group']}"
    installation = AzureVmInstallation(
        version=1,
        resource_id=group + "/providers/Microsoft.Compute/virtualMachines/agent",
        vm_id="44444444-4444-4444-4444-444444444444",
        client_id="55555555-5555-5555-5555-555555555555",
        hushh_id=row["hushh_id"],
        image_digest="sha256:" + "a" * 64,
        generation="vm_" + "b" * 32,
    )
    metadata = {
        **row["backend_metadata"],
        "hostKind": "azure_vm",
        "url": "https://pod.example",
        "serviceUid": installation.generation,
        "image": "registry.azurecr.io/pod@" + installation.image_digest,
        "image_digest": installation.image_digest,
        "runtime_client_id": installation.client_id,
        "runtime_principal_id": "33333333-3333-3333-3333-333333333333",
        "vmConfigurationSha256": "c" * 64,
        "vmUpdateModuleSha256": hashlib.sha256(
            (
                Path(__file__).resolve().parents[2] / "browser_runtime/azure_host/update.py"
            ).read_bytes()
        ).hexdigest(),
        "vmHost": {
            "installation": installation.model_dump(),
            "identityResourceId": group
            + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/agent",
            "principalId": "33333333-3333-3333-3333-333333333333",
            "location": row["user_cloud_region"],
        },
    }
    pg.execute(
        "UPDATE personal_agent_registry SET external_agent_id=%s,user_cloud_authorized_at=now(),pod_key_id='synthetic-key',"
        "pod_signing_key_id='pods_ffffffffffffffffffffffffffffffff',pod_signing_pubkey='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',"
        "pod_pubkey='synthetic-public',backend_metadata=%s::jsonb WHERE user_id=%s",
        (installation.resource_id, json.dumps(metadata), owner),
    )
    path = (
        Path(__file__).resolve().parents[2]
        / "db/migrations/parked/967_azure_vm_power_admission.sql"
    )
    pg.apply_file(path)
    pg.apply_file(path)  # dev replay preserves the existing installation
    return pg, owner, installation


def idle_receipt(authority):
    return {
        "version": 1,
        "operationId": authority.operation_id,
        "incarnation": authority.target.installation.generation,
        "runtimeEpoch": "before-restart",
        "activeWork": 0,
        "committedState": "c" * 64,
        "issuedAt": "2026-10-20T12:00:00+00:00",
        "committedCursor": {"seq": 1, "sha": "d" * 64},
        "idleRecord": {"seq": 2, "sha": "e" * 64},
    }


def power_receipt(authority, state):
    return {
        "kind": "power",
        "resourceId": authority.target.installation.resource_id,
        "vmId": authority.target.installation.vm_id,
        "state": state,
    }
