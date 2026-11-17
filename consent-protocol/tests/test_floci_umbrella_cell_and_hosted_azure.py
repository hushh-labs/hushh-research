# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Tier-1.5 Floci wire & end-to-end tests for Hosted Azure Umbrella Cells."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from hushh_mcp.services import pod_workload_identity
from hushh_mcp.services.byoc_key_custody import KEY_VAULT_KEY_ENV, ByocKeyCustodyError
from hushh_mcp.services.compute_backend import BACKEND_AZURE, PodSpec
from hushh_mcp.services.compute_backend_resolution import resolve_owner_backend
from hushh_mcp.services.hosted_azure_backend import HostedAzureBackend
from hushh_mcp.services.hosted_azure_migration_provisioner import (
    execute_owner_migration_to_hosted_azure,
    get_owner_hosted_azure_migration_status,
)
from hushh_mcp.services.hosted_azure_placement import (
    has_hosted_azure_evidence,
    retained_hosted_azure_placement,
)
from hushh_mcp.services.hosted_gcp_placement import HostedPlacement
from hushh_mcp.services.hosted_writer_handoff_reconciler import (
    reconcile_interrupted_hosted_writer_handoff,
)
from hushh_mcp.services.personal_agent_direct_admission import _binding_matches_locked_owner
from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore
from hushh_mcp.services.pod_binding_contract import (
    make_pod_binding,
    wire_deployment_target_for_row,
    wire_hosting_mode_for_row,
)
from hushh_mcp.services.pod_commit_log import PodCommitLog
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG
from hushh_mcp.services.pod_custody_port import (
    CUSTODY_MODE_ENV,
    CUSTODY_OWNER_VAULT,
    AzureKeyVaultCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_AZ_ENDPOINT_URL_ENV as AZURE_EMULATOR_URL_ENV,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_storage import resolve_pod_object_store
from hushh_mcp.services.pod_umbrella_cell_pool import (
    CellCapacityExceededError,
    NoWarmSkeletonAvailableError,
    PodSkeletonPoolService,
    UmbrellaCellRegistry,
)
from tests.floci_wire_harness import floci_azure_wire_environment

_DEV39_DIGEST = "sha256:9f771f108e06ad3fe51a433b6cd3753a0b4f8d5b24a00c82c511a421d01a9b64"


@pytest.fixture(autouse=True)
def _reset_umbrella_pool_process_claims() -> Iterator[None]:
    PodSkeletonPoolService.reset_process_claims()
    yield
    PodSkeletonPoolService.reset_process_claims()


def _clear_storage_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "POD_STORAGE_BACKEND",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_AZURE_BLOB_URL",
        CUSTODY_MODE_ENV,
        KEY_VAULT_KEY_ENV,
        AZURE_EMULATOR_URL_ENV,
        "IDENTITY_ENDPOINT",
        "IDENTITY_HEADER",
        "AZURE_CLIENT_ID",
    ):
        monkeypatch.delenv(key, raising=False)


def _cell_config_with_n_slots(count: int, *, soft: int, hard: int, min_warm: int) -> dict[str, Any]:
    slots = []
    for idx in range(1, count + 1):
        slot_id = f"slot{idx:02d}"
        app_name = f"ca-pod-{slot_id}"
        slots.append(
            {
                "slotId": slot_id,
                "appName": app_name,
                "appId": (
                    "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/"
                    "resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/"
                    f"Microsoft.App/containerApps/{app_name}"
                ),
                "fqdn": f"{app_name}.blackdesert-test.eastus2.azurecontainerapps.io",
                "identityId": (
                    "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/"
                    "resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/"
                    f"Microsoft.ManagedIdentity/userAssignedIdentities/mi-pod-{slot_id}"
                ),
                "identityClientId": f"00000000-0000-4000-8000-{idx:012x}",
                "identityPrincipalId": f"11111111-1111-4000-8000-{idx:012x}",
                "blobUrl": f"https://sthusshcelldeveus201.blob.core.windows.net/pods/{slot_id}",
                "keyVaultKey": f"https://kv-h1-celldeveus201.vault.azure.net/keys/kek-{slot_id}",
                "signingSecretUrl": (
                    f"https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-seed-{slot_id}"
                ),
            }
        )
    return {
        "environment": "dev",
        "cells": [
            {
                "cellId": "cell-az-eastus2-dev-01",
                "provider": "azure",
                "organization": "HushOne Inc.",
                "tenantId": "e1e09f9b-313b-4c57-a925-f2a573a919e9",
                "subscriptionId": "3f5a1e87-97d6-4f05-b4ce-0e2cc675e118",
                "resourceGroup": "rg-hussh-cell-dev-eastus2-01",
                "location": "eastus2",
                "environmentName": "cae-hussh-cell-dev-eus2-01",
                "environmentId": (
                    "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/"
                    "resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/"
                    "Microsoft.App/managedEnvironments/cae-hussh-cell-dev-eus2-01"
                ),
                "registryServer": "crhusshcelldeveus201.azurecr.io",
                "storageAccount": "sthusshcelldeveus201",
                "keyVaultName": "kv-h1-celldeveus201",
                "openaiEndpoint": "https://oai-hussh-cell-dev-eus2-01.openai.azure.com/",
                "openaiDeployment": "one-chat",
                "controllerClientId": "815df3ec-c8c4-4df3-a01a-f611dd6eb3c4",
                "imageDigest": _DEV39_DIGEST,
                "softWatermark": soft,
                "hardWatermark": hard,
                "minWarmSkeletons": min_warm,
                "slots": slots,
            }
        ],
    }


@pytest.mark.asyncio
async def test_floci_hosted_azure_per_slot_blob_and_kv_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_env(monkeypatch)
    pod_workload_identity.forget_workload_token("https://storage.azure.com")
    pod_workload_identity.forget_workload_token("https://vault.azure.net")

    with floci_azure_wire_environment() as env:
        slot1_blob = f"{env.endpoint_url}/sthusshcelldeveus201/pods/slot01"
        slot2_blob = f"{env.endpoint_url}/sthusshcelldeveus201/pods/slot02"
        slot1_kv = f"{env.endpoint_url}/keys/kek-slot01/{'1' * 32}"
        slot2_kv = f"{env.endpoint_url}/keys/kek-slot02/{'2' * 32}"

        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(AZURE_EMULATOR_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("IDENTITY_ENDPOINT", env.identity_endpoint)
        monkeypatch.setenv("IDENTITY_HEADER", env.identity_header)
        monkeypatch.setenv("AZURE_CLIENT_ID", env.client_id)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_VAULT)

        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", slot1_blob)
        monkeypatch.setenv(KEY_VAULT_KEY_ENV, slot1_kv)
        store_1 = resolve_pod_object_store()
        assert isinstance(store_1, AzureBlobObjectStore)
        port_1 = resolve_key_custody_port()
        assert isinstance(port_1, AzureKeyVaultCustodyAdapter)
        dek_1 = port_1.resolve_log_key()
        log_1 = PodCommitLog(store_1, dek_1, owner_id="slot01-owner")
        await log_1.append("note", {"slot": "slot01", "secret": "DevClosure-Az-Slot1"})

        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", slot2_blob)
        monkeypatch.setenv(KEY_VAULT_KEY_ENV, slot2_kv)
        store_2 = resolve_pod_object_store()
        assert isinstance(store_2, AzureBlobObjectStore)
        port_2 = resolve_key_custody_port()
        assert isinstance(port_2, AzureKeyVaultCustodyAdapter)
        dek_2 = port_2.resolve_log_key()
        assert dek_2 != dek_1
        log_2 = PodCommitLog(store_2, dek_2, owner_id="slot02-owner")
        await log_2.append("note", {"slot": "slot02", "secret": "Slot2-Only"})

        replayed_1 = await log_1.replay()
        replayed_2 = await log_2.replay()
        assert [r["payload"]["secret"] for r in replayed_1] == ["DevClosure-Az-Slot1"]
        assert [r["payload"]["secret"] for r in replayed_2] == ["Slot2-Only"]

        assert await store_1.put_if_generation("state/fence.bin", b"s1", ABSENT) is not None
        assert await store_2.put_if_generation("state/fence.bin", b"s2", ABSENT) is not None
        raw1, _ = await store_1.get_with_generation("state/fence.bin")
        raw2, _ = await store_2.get_with_generation("state/fence.bin")
        assert raw1 == b"s1" and raw2 == b"s2"

        if env.mode == "loopback_azure_wire_reference":
            monkeypatch.setenv(KEY_VAULT_KEY_ENV, slot1_kv)
            monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", slot2_blob)
            with pytest.raises(ByocKeyCustodyError):
                resolve_key_custody_port().resolve_log_key()


@pytest.mark.asyncio
async def test_umbrella_cell_8way_concurrent_skeleton_claim_watermarks_and_runtime_invariants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    registry = UmbrellaCellRegistry(_cell_config_with_n_slots(8, soft=6, hard=8, min_warm=2))
    replenish_calls: list[str] = []

    class _FakeArm:
        def put(
            self, app_id: str, *, api_version: str, body: dict[str, Any], op: str
        ) -> dict[str, Any]:
            assert api_version and op == "hosted_azure_bind_slot"
            env_map = {
                e["name"]: e.get("value")
                for e in body["properties"]["template"]["containers"][0]["env"]
            }
            assert env_map["AZURE_OPENAI_VOICE_ENABLED"] == "false"
            assert env_map["CHROMIUM_SANDBOX"] == "false"
            assert env_map["HUSHH_DEPLOY_ENV"] == "dev"
            slot_name = app_id.rsplit("/", 1)[-1]
            return {
                "properties": {
                    "latestReadyRevisionName": f"{slot_name}--0000001",
                    "configuration": {
                        "ingress": {"fqdn": f"{slot_name}.example.azurecontainerapps.io"}
                    },
                    "template": body["properties"]["template"],
                }
            }

    async def _fake_key_fetcher(
        row: dict[str, Any], *, require_identity: bool = True
    ) -> dict[str, str]:
        assert require_identity is True
        url = row["backend_metadata"]["url"]
        return {
            "podPublicKey": f"x25519-{url}",
            "podKeyId": f"kid-{url[-6:]}",
            "podKeyWrappingAlg": WRAPPING_ALG,
            "podSigningKey": f"ed25519-{url}",
            "podSigningKeyId": f"skid-{url[-6:]}",
        }

    ticks = [0.0]

    def _clock() -> float:
        ticks[0] += 0.015
        return ticks[0]

    pool = PodSkeletonPoolService(
        registry=registry,
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot, arm_client=_FakeArm(), live=True
        ),  # type: ignore[arg-type]
        key_fetcher=_fake_key_fetcher,
        clock=_clock,
        replenish_callback=replenish_calls.append,
    )

    specs = [
        PodSpec(
            hushh_id=f"ha1_owner_{idx}",
            phone_e164_hash=f"ph_{idx}",
            pod_pubkey="",
            region="eastus2",
            deployment_target=BACKEND_AZURE,
        )
        for idx in range(8)
    ]
    results = await asyncio.gather(
        *[
            pool.claim_warm_skeleton_for_owner(spec=specs[idx], owner_id=f"u_{idx}")
            for idx in range(8)
        ]
    )

    claimed_slots = [r.slot.slot_id for r in results]
    assert len(set(claimed_slots)) == 8
    assert all(r.relay_ready is True for r in results)
    assert any(r.replenishment_recommended for r in results)
    assert "cell-az-eastus2-dev-01" in replenish_calls

    status = pool.snapshot_status()
    cell_rep = status["cells"][0]
    assert cell_rep["activeSlots"] == 8
    assert cell_rep["warmStandbySlots"] == 0
    assert cell_rep["needsCellExpansion"] is True
    assert cell_rep["admitsNewOwners"] is False

    with pytest.raises(CellCapacityExceededError):
        await pool.claim_warm_skeleton_for_owner(
            spec=PodSpec(
                hushh_id="ha1_owner_9",
                phone_e164_hash="ph_9",
                pod_pubkey="",
                region="eastus2",
                deployment_target=BACKEND_AZURE,
            ),
            owner_id="u_9",
        )

    no_warm_reg = UmbrellaCellRegistry(_cell_config_with_n_slots(8, soft=8, hard=10, min_warm=1))
    PodSkeletonPoolService.reset_process_claims()
    smaller = PodSkeletonPoolService(registry=no_warm_reg)
    with pytest.raises(NoWarmSkeletonAvailableError):
        await smaller.claim_warm_skeleton_for_owner(
            spec=specs[0],
            owner_id="u_overflow",
            occupied_app_ids={s.app_id for s in no_warm_reg.azure_cell().slots},
        )

    assert isinstance(resolve_owner_backend(specs[0]), HostedAzureBackend)


class _InMemoryRegistryRepo:
    def __init__(self, row: dict[str, Any]) -> None:
        self.row = dict(row)
        self.migrations_begun = 0
        self.migrations_ended = 0

    async def get(self, user_id: str) -> dict[str, Any] | None:
        return dict(self.row) if user_id == self.row["user_id"] else None

    async def begin_migration(self, user_id: str) -> bool:
        assert user_id == self.row["user_id"]
        if self.row["status"] != "provisioned":
            return False
        self.row["status"] = "migrating"
        self.migrations_begun += 1
        return True

    async def end_migration(self, user_id: str, *, status: str = "provisioned") -> bool:
        assert user_id == self.row["user_id"]
        self.row["status"] = status
        self.migrations_ended += 1
        return True

    async def switch_over_hosted_azure(
        self,
        *,
        user_id: str,
        hushh_id: str,
        claimed: Any,
        service_uid: str,
    ) -> dict[str, Any]:
        from hushh_mcp.services.hosted_azure_migration_provisioner import (
            build_hosted_azure_switch_metadata,
        )

        assert user_id == self.row["user_id"]
        assert hushh_id == self.row["hushh_id"]
        new_meta = build_hosted_azure_switch_metadata(
            previous_row=self.row,
            claimed=claimed,
            service_uid=service_uid,
        )
        self.row.update(
            {
                "deployment_target": BACKEND_AZURE,
                "backend": BACKEND_AZURE,
                "external_agent_id": claimed.slot.app_id,
                "a2a_route": new_meta["url"],
                "status": "provisioned",
                "placement_epoch": int(self.row.get("placement_epoch") or 0) + 1,
                "identity_mode": "signed",
                "pod_pubkey": claimed.published_keys["podPublicKey"],
                "pod_key_id": claimed.published_keys["podKeyId"],
                "pod_signing_pubkey": claimed.published_keys["podSigningKey"],
                "pod_signing_key_id": claimed.published_keys["podSigningKeyId"],
                "user_cloud_project": None,
                "user_cloud_region": None,
                "user_cloud_tenant_id": None,
                "user_cloud_subscription_id": None,
                "user_cloud_resource_group": None,
                "backend_metadata": new_meta,
            }
        )
        return dict(self.row)


class _InMemoryMigrationJobRepo:
    def __init__(self) -> None:
        self.job: dict[str, Any] | None = None

    async def start(self, **kwargs: Any) -> None:
        self.job = {"status": "running", "stage": "starting", **kwargs}

    async def advance(self, *, user_id: str, job_id: str, stage: str, **_kwargs: Any) -> None:
        assert self.job and self.job["user_id"] == user_id and self.job["job_id"] == job_id
        self.job["stage"] = stage

    async def record_source_receipt(
        self, *, user_id: str, job_id: str, head_sha: str, record_count: int
    ) -> None:
        assert self.job and self.job["user_id"] == user_id and self.job["job_id"] == job_id
        self.job["source_head_sha"] = head_sha
        self.job["source_record_count"] = record_count

    async def record_target_receipt(
        self, *, user_id: str, job_id: str, head_sha: str, record_count: int
    ) -> None:
        assert self.job and self.job["user_id"] == user_id and self.job["job_id"] == job_id
        self.job["target_head_sha"] = head_sha
        self.job["target_record_count"] = record_count

    async def finish(
        self,
        *,
        user_id: str,
        job_id: str,
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
        **_kwargs: Any,
    ) -> None:
        assert self.job and self.job["user_id"] == user_id and self.job["job_id"] == job_id
        self.job["status"] = status
        self.job["error_code"] = error_code
        self.job["error_message"] = error_message

    async def get(self, user_id: str) -> dict[str, Any] | None:
        return dict(self.job) if self.job and self.job["user_id"] == user_id else None


@pytest.mark.asyncio
async def test_e2e_owner_byoc_azure_migration_to_hushone_inc_hosted_slot_zero_loss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    source_row = {
        "user_id": "uid-account-2",
        "hushh_id": "ha1_7o6wt3s4example",
        "phone_e164_hash": "ph-acc-2",
        "deployment_target": "user_azure",
        "backend": "user_azure",
        "external_agent_id": (
            "/subscriptions/sub-personal/resourceGroups/rg-hussh-one/"
            "providers/Microsoft.App/containerApps/ca-hussh-one-pod"
        ),
        "a2a_route": "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io",
        "status": "provisioned",
        "placement_epoch": 2,
        "model_credential_mode": "byok_per_turn",
        "pod_pubkey": "old-pubkey",
        "user_cloud_project": None,
        "user_cloud_tenant_id": "personal-tenant",
        "user_cloud_subscription_id": "sub-personal",
        "user_cloud_resource_group": "rg-hussh-one",
        "backend_metadata": {
            "url": "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io",
            "service": "ca-hussh-one-pod",
            "revision": "ca-hussh-one-pod--rev1",
            "serviceUid": "rev1-incarnation",
            "ingress": "direct",
            "endpointVersion": 3,
            "bindings": {"dev-1": {"version": 2}},
            "userAzureAdmission": {"subscriptionId": "sub-personal"},
        },
    }
    registry = _InMemoryRegistryRepo(source_row)
    jobs = _InMemoryMigrationJobRepo()
    handoff_calls: list[str] = []

    class _FakeHandoff:
        def _request(self, method: str, path: str) -> dict[str, Any]:
            handoff_calls.append(f"{method} {path}")
            return {"state": "accepting", "incarnation": "rev1-incarnation"}

        def prepare_and_wait(
            self, *, operation_id: str, incarnation: str, timeout_seconds: float
        ) -> dict[str, Any]:
            assert timeout_seconds > 0
            return {
                "operationId": operation_id,
                "incarnation": incarnation,
                "activeWork": 0,
                "committedState": "sha256:" + ("a" * 64),
                "runtimeEpoch": "ep-src-1",
            }

        def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
            handoff_calls.append(f"release:{operation_id}:{incarnation}")
            return {"state": "accepting", "incarnation": incarnation, "operationId": None}

    class _FakeArm:
        def put(
            self, app_id: str, *, api_version: str, body: dict[str, Any], op: str
        ) -> dict[str, Any]:
            assert app_id and api_version and op == "hosted_azure_bind_slot"
            return {
                "properties": {
                    "latestReadyRevisionName": "ca-pod-slot01--0000001",
                    "configuration": {
                        "ingress": {
                            "fqdn": "ca-pod-slot01.blackdesert.eastus2.azurecontainerapps.io"
                        }
                    },
                    "template": body["properties"]["template"],
                }
            }

    async def _fake_keys(_row: dict[str, Any], *, require_identity: bool = True) -> dict[str, str]:
        assert require_identity is True
        return {
            "podPublicKey": "new-slot01-x25519",
            "podKeyId": "kid-slot01",
            "podKeyWrappingAlg": WRAPPING_ALG,
            "podSigningKey": "new-slot01-ed25519",
            "podSigningKeyId": "skid-slot01",
        }

    pool = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(_cell_config_with_n_slots(2, soft=40, hard=50, min_warm=1)),
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot, arm_client=_FakeArm(), live=True
        ),  # type: ignore[arg-type]
        key_fetcher=_fake_keys,
    )

    sealed_ciphertext = {
        "schemaVersion": 1,
        "alg": WRAPPING_ALG,
        "sealedBlobB64": "ciphertext-only-never-decrypted-by-hub",
    }

    class _FakeTransport:
        @staticmethod
        def export_from(
            *,
            pod_url: str,
            hushh_id: str,
            recipient_public_key: str,
            recipient_key_id: str,
            token_minter: Any = None,
        ) -> dict[str, Any]:
            assert (
                pod_url and hushh_id and recipient_public_key and recipient_key_id and token_minter
            )
            return {
                "headSha": "deadbeef" * 8,
                "recordCount": 7,
                "bundle": dict(sealed_ciphertext),
            }

        @staticmethod
        def import_into(
            *,
            pod_url: str,
            hushh_id: str,
            bundle: dict[str, Any],
            token_minter: Any = None,
        ) -> dict[str, Any]:
            assert pod_url and hushh_id and token_minter
            assert bundle["sealedBlobB64"] == "ciphertext-only-never-decrypted-by-hub"
            return {"headSha": "deadbeef" * 8, "recordCount": 7}

    async def _admit_direct(row: dict[str, Any], *, db: Any = None) -> bool:
        del db
        registry.row["backend_metadata"]["ingress"] = "direct"
        registry.row["backend_metadata"]["directReadiness"] = {
            "verified": True,
            "url": row["a2a_route"],
        }
        return True

    outcome = await execute_owner_migration_to_hosted_azure(
        "uid-account-2",
        db=object(),
        registry_repo=registry,
        job_repo=jobs,  # type: ignore[arg-type]
        pool=pool,
        handoff_factory=lambda _url, _hid: _FakeHandoff(),
        transport=_FakeTransport(),
        token_minter=lambda **_kwargs: "hub-pod-token",
        admit_direct_fn=_admit_direct,
    )

    assert outcome["status"] == "succeeded"
    assert outcome["slotId"] == "slot01"
    assert outcome["directPromoted"] is True
    assert outcome["cutover"]["relayReady"] is True
    assert outcome["cutover"]["directReady"] is True
    assert outcome["cutover"]["ingress"] == "direct"

    assert registry.row["deployment_target"] == "azure"
    assert registry.row["user_cloud_resource_group"] is None
    assert has_hosted_azure_evidence(registry.row) is True
    placement = retained_hosted_azure_placement(registry.row)
    assert placement is not None and placement.slot_id == "slot01"

    meta = registry.row["backend_metadata"]
    assert meta["endpointVersion"] == 4
    assert meta["bindings"]["dev-1"]["version"] == 2
    assert meta["detachedPlacements"][0]["deploymentTarget"] == "user_azure"
    assert meta["detachedPlacements"][0]["graceDays"] == 14
    assert any(call.startswith("release:") for call in handoff_calls)

    status_view = await get_owner_hosted_azure_migration_status(
        "uid-account-2",
        db=object(),
        registry_repo=registry,
        job_repo=jobs,  # type: ignore[arg-type]
        pool=pool,
    )
    assert status_view["deploymentTarget"] == "azure"
    assert status_view["directReadiness"]["verified"] is True


def test_dev39_wire_compatibility_and_writer_handoff_reconciler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    owner_id = "u-az"
    owner_hash = "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
    pod_url = "https://ca-pod-slot01.blackdesert.eastus2.azurecontainerapps.io"

    dev39_row = {
        "user_id": owner_id,
        "hushh_id": "ha1_az",
        "deployment_target": "azure",
        "backend": "azure",
        "status": "provisioned",
        "pod_key_id": "kid-az",
        "pod_pubkey": "pub-az",
        "backend_metadata": {
            "tenancy": "hussh-hosted",
            "service": "ca-pod-slot01",
            "serviceUid": "uid-az-1",
            "url": pod_url,
            "image_digest": _DEV39_DIGEST,
            "hostedAzureAdmission": {
                "version": 1,
                "environment": "dev",
                "ownerId": owner_id,
                "ownerHash": owner_hash,
                "hushhId": "ha1_az",
                "tenantId": "e1e09f9b-313b-4c57-a925-f2a573a919e9",
                "subscriptionId": "3f5a1e87-97d6-4f05-b4ce-0e2cc675e118",
                "resourceGroup": "rg-hussh-cell-dev-eastus2-01",
                "location": "eastus2",
                "cellId": "cell-az-eastus2-dev-01",
                "slotId": "slot01",
                "appName": "ca-pod-slot01",
                "serviceUid": "uid-az-1",
                "url": pod_url,
                "identityId": "/subscriptions/3f5a1e87/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi",
                "identityClientId": "00000000-0000-4000-8000-000000000001",
                "registryServer": "crhusshcelldeveus201.azurecr.io",
                "imageDigest": _DEV39_DIGEST,
            },
        },
    }
    assert wire_deployment_target_for_row(dev39_row) == "ace"
    assert wire_hosting_mode_for_row(dev39_row) is None

    device = {"device_public_key": "pub-1", "platform": "web", "status": "active"}
    binding_dev39 = make_pod_binding(
        row=dev39_row,
        user_id=owner_id,
        device_id="dev-1",
        device=device,
        role="app",
        scopes=("pod.turn",),
        version=1,
        environment="dev",
        now_ms=1000,
        ttl_ms=60_000,
    )
    assert binding_dev39.deployment_target == "ace"
    assert binding_dev39.hosting_mode is None
    assert (
        _binding_matches_locked_owner(
            dev39_row,
            device,
            binding_dev39.to_dict(),
            {"serviceUid": "uid-az-1"},
            user_id=owner_id,
            device_id="dev-1",
        )
        is True
    )

    upgraded_digest = "sha256:" + ("f" * 64)
    upgraded_row = {
        **dev39_row,
        "backend_metadata": {
            **dev39_row["backend_metadata"],
            "image_digest": upgraded_digest,
            "hostedAzureAdmission": {
                **dev39_row["backend_metadata"]["hostedAzureAdmission"],
                "imageDigest": upgraded_digest,
            },
        },
    }
    assert wire_deployment_target_for_row(upgraded_row) == "azure"
    assert wire_hosting_mode_for_row(upgraded_row) == "hussh_hosted"

    gcp_hosted_row = {
        "user_id": "u-gcp",
        "hushh_id": "ha1_gcp_1",
        "deployment_target": "gcp",
        "backend": "gcp",
        "status": "provisioned",
        "backend_metadata": {
            "tenancy": "hussh-hosted",
            "url": "https://slot3.run.app",
            "service": "hushh-pod-slot3",
            "serviceUid": "uid-slot3",
        },
    }
    fake_placement = HostedPlacement(
        owner_id="u-gcp",
        hushh_id="ha1_gcp_1",
        project="hussh-dev-cell-01",
        project_number="123456789",
        region="us-central1",
        service="hushh-pod-slot3",
        service_uid="uid-slot3",
        runtime_principal="pod-slot3@hussh-dev-cell-01.iam.gserviceaccount.com",
        bootstrap_sa="one-bootstrap@hussh-dev-cell-01.iam.gserviceaccount.com",
    )

    class _FakeHandoffClient:
        def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
            assert operation_id == "op-idle-1" and incarnation == "inc-1"
            return {"state": "accepting"}

    class _FakeGcpClient:
        def __init__(self) -> None:
            self.replaced_env: list[dict[str, str]] = []

        def get_service(self, service: str) -> dict[str, Any]:
            return {
                "metadata": {"name": service, "uid": "uid-slot3"},
                "spec": {"template": {"spec": {"containers": [{"env": []}]}}},
            }

        def replace_service(
            self, service: str, updated: dict[str, Any], *, revision_nonce: str, expected_uid: str
        ) -> dict[str, Any]:
            assert expected_uid == "uid-slot3" and revision_nonce.startswith("reconcile-")
            self.replaced_env = updated["spec"]["template"]["spec"]["containers"][0]["env"]
            return {"status": {"latestCreatedRevisionName": f"{service}-00099"}}

    with patch(
        "hushh_mcp.services.hosted_writer_handoff_reconciler.retained_hosted_placement",
        return_value=fake_placement,
    ):
        same_epoch = reconcile_interrupted_hosted_writer_handoff(
            gcp_hosted_row,
            upgrade_status={
                "state": "idle",
                "operationId": "op-idle-1",
                "incarnation": "inc-1",
                "runtimeEpoch": "ep-1",
                "idleReceipt": {"operationId": "op-idle-1", "runtimeEpoch": "ep-1"},
            },
            handoff_client=_FakeHandoffClient(),  # type: ignore[arg-type]
            execute=True,
        )
        assert same_epoch.action == "released_same_epoch"

        gcp_client = _FakeGcpClient()
        cross_epoch = reconcile_interrupted_hosted_writer_handoff(
            gcp_hosted_row,
            upgrade_status={
                "state": "idle",
                "operationId": "op-idle-2",
                "incarnation": "inc-2",
                "runtimeEpoch": "ep-2",
                "idleReceipt": {"operationId": "op-idle-2", "runtimeEpoch": "ep-1"},
            },
            gcp_client=gcp_client,  # type: ignore[arg-type]
            handoff_client=_FakeHandoffClient(),  # type: ignore[arg-type]
            execute=True,
        )
        assert cross_epoch.action == "stamped_writer_operation"
        assert {
            "name": "HUSSH_POD_WRITER_OPERATION",
            "value": "op-idle-2",
        } in gcp_client.replaced_env

        monkeypatch.setenv("HUSHH_DEPLOY_ENV", "prod")
        with pytest.raises(PermissionError):
            reconcile_interrupted_hosted_writer_handoff(gcp_hosted_row, upgrade_status={})


@pytest.fixture
def _authed_client() -> Iterator[TestClient]:
    from server import app

    app.dependency_overrides[require_firebase_auth] = lambda: "uid-account-2"
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_hosted_azure_migration_and_cell_status_routes_dev_fenced(
    _authed_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "prod")
    assert _authed_client.post("/api/one/runtime/byoc/hosted/azure/migrate").status_code == 404
    assert (
        _authed_client.get("/api/one/runtime/byoc/hosted/azure/migrate/status").status_code == 404
    )
    assert _authed_client.get("/api/one/runtime/byoc/hosted/cells/status").status_code == 404

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    cells_resp = _authed_client.get("/api/one/runtime/byoc/hosted/cells/status")
    assert cells_resp.status_code == 200
    assert {"gcp", "azure"} <= {c["provider"] for c in cells_resp.json()["cells"]}

    with (
        patch(
            "hushh_mcp.services.hosted_azure_migration_provisioner.execute_owner_migration_to_hosted_azure",
            new=AsyncMock(
                return_value={
                    "status": "succeeded",
                    "slotId": "slot01",
                    "migrationMode": "fresh_pod_log_with_source_grace",
                }
            ),
        ) as mig_mock,
        patch(
            "hushh_mcp.services.hosted_azure_migration_provisioner.get_owner_hosted_azure_migration_status",
            new=AsyncMock(
                return_value={"deploymentTarget": "azure", "directReadiness": {"verified": True}}
            ),
        ),
    ):
        mig = _authed_client.post(
            "/api/one/runtime/byoc/hosted/azure/migrate", json={"allowFreshPodLog": True}
        )
        assert mig.status_code == 200 and mig.json()["slotId"] == "slot01"
        assert mig_mock.call_args.kwargs["allow_fresh_pod_log"] is True
        st = _authed_client.get("/api/one/runtime/byoc/hosted/azure/migrate/status")
        assert st.status_code == 200 and st.json()["directReadiness"]["verified"] is True


@pytest.mark.asyncio
async def test_umbrella_pool_arm_tag_owner_isolation_and_same_owner_reuse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    PodSkeletonPoolService.reset_process_claims()
    cell_cfg = _cell_config_with_n_slots(2, soft=40, hard=50, min_warm=1)
    owner_a_hash = f"sha256:{hashlib.sha256(b'ha1_owner_a').hexdigest()}"

    class _TaggedArm:
        def __init__(self) -> None:
            self.bound_apps: list[str] = []

        def get(self, app_id: str, *, api_version: str, op: str = "") -> dict[str, Any]:
            assert api_version and op == "hosted_azure_observe"
            if app_id.endswith("ca-pod-slot01"):
                return {
                    "tags": {
                        "hussh-pool-state": "bound_active",
                        "hussh-owner-hash": owner_a_hash,
                    }
                }
            return {"tags": {"hussh-pool-state": "warm_standby"}}

        def put(
            self, app_id: str, *, api_version: str, body: dict[str, Any], op: str
        ) -> dict[str, Any]:
            assert api_version and op == "hosted_azure_bind_slot"
            self.bound_apps.append(app_id)
            slot_name = app_id.rsplit("/", 1)[-1]
            return {
                "properties": {
                    "latestReadyRevisionName": f"{slot_name}--0000001",
                    "configuration": {
                        "ingress": {
                            "fqdn": f"{slot_name}.blackdesert.eastus2.azurecontainerapps.io"
                        }
                    },
                    "template": body["properties"]["template"],
                }
            }

    async def _keys(row: dict[str, Any], *, require_identity: bool = True) -> dict[str, str]:
        assert require_identity is True and row
        return {
            "podPublicKey": "pub",
            "podKeyId": "kid",
            "podKeyWrappingAlg": WRAPPING_ALG,
            "podSigningKey": "sig",
            "podSigningKeyId": "skid",
        }

    # Even with an empty SQL occupied set, live ARM tags must keep Owner A's slot isolated
    # from Owner B while letting Owner A resume idempotently onto slot01.
    arm_b = _TaggedArm()
    pool_b = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(cell_cfg),
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=arm_b, live=True),  # type: ignore[arg-type]
        key_fetcher=_keys,
    )
    res_b = await pool_b.claim_warm_skeleton_for_owner(
        spec=PodSpec(
            hushh_id="ha1_owner_b",
            phone_e164_hash="ph_b",
            pod_pubkey="",
            region="eastus2",
            deployment_target=BACKEND_AZURE,
        ),
        owner_id="uid-owner-b",
        occupied_app_ids=set(),
    )
    assert res_b.slot.slot_id == "slot02"

    PodSkeletonPoolService.reset_process_claims()
    arm_a = _TaggedArm()
    pool_a = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(cell_cfg),
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=arm_a, live=True),  # type: ignore[arg-type]
        key_fetcher=_keys,
    )
    res_a = await pool_a.claim_warm_skeleton_for_owner(
        spec=PodSpec(
            hushh_id="ha1_owner_a",
            phone_e164_hash="ph_a",
            pod_pubkey="",
            region="eastus2",
            deployment_target=BACKEND_AZURE,
        ),
        owner_id="uid-owner-a",
        occupied_app_ids=set(),
    )
    assert res_a.slot.slot_id == "slot01"


@pytest.mark.asyncio
async def test_hosted_azure_migration_fresh_pod_log_opt_in_and_fail_closed_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    def _source_row() -> dict[str, Any]:
        return {
            "user_id": "uid-acc-2",
            "hushh_id": "ha1_7o6wt3s4example",
            "phone_e164_hash": "ph-acc-2",
            "deployment_target": "user_azure",
            "backend": "user_azure",
            "external_agent_id": (
                "/subscriptions/sub-personal/resourceGroups/rg-hussh-one/"
                "providers/Microsoft.App/containerApps/ca-hussh-one-pod"
            ),
            "a2a_route": "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io",
            "status": "provisioned",
            "placement_epoch": 2,
            "model_credential_mode": "byok_per_turn",
            "pod_pubkey": "old-pubkey",
            "user_cloud_project": None,
            "user_cloud_tenant_id": "personal-tenant",
            "user_cloud_subscription_id": "sub-personal",
            "user_cloud_resource_group": "rg-hussh-one",
            "backend_metadata": {
                "url": "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io",
                "service": "ca-hussh-one-pod",
                "revision": "ca-hussh-one-pod--rev1",
                "serviceUid": "rev1-incarnation",
                "ingress": "direct",
                "endpointVersion": 3,
                "userAzureAdmission": {"subscriptionId": "sub-personal"},
            },
        }

    class _FakeHandoff:
        def _request(self, method: str, path: str) -> dict[str, Any]:
            assert method and path
            return {"state": "accepting", "incarnation": "rev1-incarnation"}

        def prepare_and_wait(
            self, *, operation_id: str, incarnation: str, timeout_seconds: float
        ) -> dict[str, Any]:
            assert timeout_seconds > 0
            return {
                "operationId": operation_id,
                "incarnation": incarnation,
                "activeWork": 0,
                "committedState": "sha256:" + ("b" * 64),
                "runtimeEpoch": "ep-src-1",
            }

        def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
            return {"state": "accepting", "incarnation": incarnation, "operationId": None}

    class _FakeArm:
        def put(
            self, app_id: str, *, api_version: str, body: dict[str, Any], op: str
        ) -> dict[str, Any]:
            assert app_id and api_version and op == "hosted_azure_bind_slot"
            return {
                "properties": {
                    "latestReadyRevisionName": "ca-pod-slot01--0000001",
                    "configuration": {
                        "ingress": {
                            "fqdn": "ca-pod-slot01.blackdesert.eastus2.azurecontainerapps.io"
                        }
                    },
                    "template": body["properties"]["template"],
                }
            }

    async def _fake_keys(_row: dict[str, Any], *, require_identity: bool = True) -> dict[str, str]:
        assert require_identity is True
        return {
            "podPublicKey": "new-slot01-x25519",
            "podKeyId": "kid-slot01",
            "podKeyWrappingAlg": WRAPPING_ALG,
            "podSigningKey": "new-slot01-ed25519",
            "podSigningKeyId": "skid-slot01",
        }

    def _refusing_transport(code: str, msg: str) -> Any:
        class _Transport:
            @staticmethod
            def export_from(**_kwargs: Any) -> dict[str, Any]:
                raise PodMigrationTransportError(code, msg)

            @staticmethod
            def import_into(**_kwargs: Any) -> dict[str, Any]:
                raise AssertionError("import_into must not run when fallback/failure triggers")

        return _Transport

    async def _admit_direct(row: dict[str, Any], *, db: Any = None) -> bool:
        del db
        row["backend_metadata"]["ingress"] = "direct"
        row["backend_metadata"]["directReadiness"] = {"verified": True}
        return True

    # Default allow_fresh_pod_log=False refuses POD_REFUSED_400 before switch-over.
    PodSkeletonPoolService.reset_process_claims()
    reg_strict = _InMemoryRegistryRepo(_source_row())
    jobs_strict = _InMemoryMigrationJobRepo()
    pool_strict = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(_cell_config_with_n_slots(2, soft=40, hard=50, min_warm=1)),
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot, arm_client=_FakeArm(), live=True
        ),  # type: ignore[arg-type]
        key_fetcher=_fake_keys,
    )
    res_strict = await execute_owner_migration_to_hosted_azure(
        "uid-acc-2",
        db=object(),
        registry_repo=reg_strict,
        job_repo=jobs_strict,  # type: ignore[arg-type]
        pool=pool_strict,
        handoff_factory=lambda _u, _h: _FakeHandoff(),
        transport=_refusing_transport(
            "POD_REFUSED_400", "memory custody transfer is not qualified"
        ),
        token_minter=lambda aud: f"tok:{aud}",
        admit_direct_fn=_admit_direct,
    )
    assert res_strict["status"] == "failed"
    assert reg_strict.row["deployment_target"] == "user_azure"

    # Explicit allow_fresh_pod_log=True succeeds ONLY on POD_REFUSED_400 with 14-day grace.
    PodSkeletonPoolService.reset_process_claims()
    reg_opt = _InMemoryRegistryRepo(_source_row())
    jobs_opt = _InMemoryMigrationJobRepo()
    pool_opt = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(_cell_config_with_n_slots(2, soft=40, hard=50, min_warm=1)),
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot, arm_client=_FakeArm(), live=True
        ),  # type: ignore[arg-type]
        key_fetcher=_fake_keys,
    )
    res_opt = await execute_owner_migration_to_hosted_azure(
        "uid-acc-2",
        db=object(),
        registry_repo=reg_opt,
        job_repo=jobs_opt,  # type: ignore[arg-type]
        pool=pool_opt,
        allow_fresh_pod_log=True,
        handoff_factory=lambda _u, _h: _FakeHandoff(),
        transport=_refusing_transport(
            "POD_REFUSED_400", "memory custody transfer is not qualified"
        ),
        token_minter=lambda aud: f"tok:{aud}",
        admit_direct_fn=_admit_direct,
    )
    assert res_opt["status"] == "succeeded"
    assert res_opt["migrationMode"] == "fresh_pod_log_with_source_grace"
    assert res_opt["directPromoted"] is True
    assert reg_opt.row["deployment_target"] == "azure"
    assert reg_opt.row["backend_metadata"]["migrationMode"] == "fresh_pod_log_with_source_grace"
    assert reg_opt.row["backend_metadata"]["detachedPlacements"][0]["graceDays"] == 14

    # Non-400 transport failures MUST still fail closed even when allow_fresh_pod_log=True.
    PodSkeletonPoolService.reset_process_claims()
    reg_err = _InMemoryRegistryRepo(_source_row())
    jobs_err = _InMemoryMigrationJobRepo()
    pool_err = PodSkeletonPoolService(
        registry=UmbrellaCellRegistry(_cell_config_with_n_slots(2, soft=40, hard=50, min_warm=1)),
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot, arm_client=_FakeArm(), live=True
        ),  # type: ignore[arg-type]
        key_fetcher=_fake_keys,
    )
    res_err = await execute_owner_migration_to_hosted_azure(
        "uid-acc-2",
        db=object(),
        registry_repo=reg_err,
        job_repo=jobs_err,  # type: ignore[arg-type]
        pool=pool_err,
        allow_fresh_pod_log=True,
        handoff_factory=lambda _u, _h: _FakeHandoff(),
        transport=_refusing_transport("POD_UNREACHABLE", "timed out"),
        token_minter=lambda aud: f"tok:{aud}",
        admit_direct_fn=_admit_direct,
    )
    assert res_err["status"] == "failed"
    assert reg_err.row["deployment_target"] == "user_azure"
