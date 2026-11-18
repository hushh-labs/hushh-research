# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Real HTTP TCP wire conformance for GCP (GCS + Cloud KMS) and Azure (Blob + Key Vault + MSI).

Exercises unmocked `GcsObjectStore`, `GcpKmsCustodyAdapter`, `AzureBlobObjectStore`,
`pod_workload_identity.get_workload_token`, `AzureKeyVaultCustodyAdapter`, and
`PodCommitLog` over real loopback TCP sockets (`floci-gcp` / `floci-az` when installed,
or the deterministic HTTP/1.1 wire reference servers in `tests.floci_wire_harness`),
plus fail-closed UAT/production and non-loopback HTTP refusal.
"""

from __future__ import annotations

import pytest
import requests  # type: ignore[import-untyped]

from hushh_mcp.services import pod_workload_identity
from hushh_mcp.services.byoc_key_custody import (
    KEY_VAULT_KEY_ENV,
    KMS_KEY_ENV,
    ByocKeyCustodyError,
    unwrap_dek,
    wrap_dek,
)
from hushh_mcp.services.pod_azure_blob_store import (
    AzureBlobObjectStore,
    PodBlobStorageError,
    PodBlobStorageForbidden,
)
from hushh_mcp.services.pod_commit_log import GcsObjectStore, PodCommitLog
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    CUSTODY_MODE_ENV,
    CUSTODY_OWNER_KMS,
    CUSTODY_OWNER_VAULT,
    AzureKeyVaultCustodyAdapter,
    GcpKmsCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_AZ_ENDPOINT_URL_ENV as AZURE_EMULATOR_URL_ENV,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_GCP_ENDPOINT_URL_ENV as GCP_EMULATOR_URL_ENV,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV as PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    STORAGE_EMULATOR_HOST_ENV as GCP_STORAGE_EMULATOR_ENV,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    PodEmulatorEndpointError,
    resolve_gcp_storage_origin,
)
from hushh_mcp.services.pod_key_vault_custody import PodKeyVaultCustodyError
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_s3_object_store import (
    PodMultiCloudStorageError,
    PrefixTokenObjectStore,
)
from hushh_mcp.services.pod_storage import resolve_pod_object_store
from tests.floci_wire_harness import (
    floci_azure_wire_environment,
    floci_gcp_wire_environment,
)


def _clear_storage_and_custody_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "POD_STORAGE_LOCAL_ROOT",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_AZURE_BLOB_URL",
        "POD_STORAGE_S3_URI",
        "POD_STORAGE_PREFIX_TOKEN_URL",
        "POD_STORAGE_PREFIX_BEARER_TOKEN",
        "GCE_METADATA_HOST",
        "IDENTITY_ENDPOINT",
        "IDENTITY_HEADER",
        "AZURE_CLIENT_ID",
        KMS_KEY_ENV,
        KEY_VAULT_KEY_ENV,
        "HUSSH_POD_AWS_KMS_KEY_ARN",
        "HUSSH_POD_ACE_SEAL_SCALAR",
        CUSTODY_MODE_ENV,
    ):
        monkeypatch.delenv(var, raising=False)


@pytest.mark.asyncio
async def test_floci_wire_gcs_object_store_and_commit_log_cas_over_real_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    with floci_gcp_wire_environment() as env:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(GCP_EMULATOR_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-floci-gcs-bkt")
        monkeypatch.setenv("POD_STORAGE_GCS_PREFIX", "pods/owner-gcp-01")

        store = resolve_pod_object_store()
        assert isinstance(store, GcsObjectStore)

        # 1. Absent read + conditional create (ifGenerationMatch=0) + 412 race conflict
        raw_0, ver_0 = await store.get_with_generation("state/marker.bin")
        assert raw_0 is None and ver_0 is ABSENT

        ver_1 = await store.put_if_generation("state/marker.bin", b"gcp-v1", ABSENT)
        assert ver_1 is not None
        assert await store.put_if_generation("state/marker.bin", b"gcp-race", ABSENT) is None

        # 2. Generation swap + stale generation 412 conflict
        ver_2 = await store.put_if_generation("state/marker.bin", b"gcp-v2", ver_1)
        assert ver_2 is not None and ver_2 != ver_1
        assert await store.put_if_generation("state/marker.bin", b"gcp-stale", ver_1) is None

        read_back, read_ver = await store.get_with_generation("state/marker.bin")
        assert read_back == b"gcp-v2" and read_ver == ver_2

        # 3. Pinned metadata+media fallback when proxy strips x-goog-generation
        if env.mode == "loopback_gcp_wire_reference":
            env.set_strip_media_generation(True)
            pinned_store = GcsObjectStore("hushh-floci-gcs-bkt", "pods/owner-gcp-01")
            pinned_bytes, pinned_ver = await pinned_store.get_with_generation("state/marker.bin")
            assert pinned_bytes == b"gcp-v2" and pinned_ver == ver_2
            env.set_strip_media_generation(False)

        # 4. Token 401 refusal triggers 1x automatic token refresh over real HTTP
        if env.mode == "loopback_gcp_wire_reference":
            calls = 0

            def rotating_provider() -> tuple[str, int]:
                nonlocal calls
                calls += 1
                return f"gcp-dyn-tok-{calls}", 900

            dyn_store = GcsObjectStore(
                "hushh-floci-gcs-bkt",
                "pods/owner-gcp-01",
                token_provider=rotating_provider,
            )
            assert (await dyn_store.get("state/marker.bin")) == b"gcp-v2"
            assert calls == 1
            env.set_token_refused("gcp-dyn-tok-1", refused=True)
            assert (await dyn_store.get("state/marker.bin")) == b"gcp-v2"
            assert calls == 2

        # 5. Full PodCommitLog sealed append + replay over real HTTP GCS CAS
        log = PodCommitLog(store, b"\x21" * 32, owner_id="owner-gcp-01")
        await log.append("note", {"seq_note": "alpha"})
        await log.append("note", {"seq_note": "beta"})
        replayed = await log.replay()
        assert [r["payload"]["seq_note"] for r in replayed] == ["alpha", "beta"]

        # 6. Bucket 403 permission denial surfaces as RuntimeError (never silent None)
        if env.mode == "loopback_gcp_wire_reference":
            env.set_bucket_forbidden("hushh-floci-gcs-bkt", forbidden=True)
            with pytest.raises(RuntimeError):
                await store.get_with_generation("state/marker.bin")


def test_floci_wire_gcp_kms_custody_aad_and_tombstone_over_real_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    with floci_gcp_wire_environment() as env:
        kms_key = "projects/p-floci/locations/us-central1/keyRings/kr/cryptoKeys/pod-kek"
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(GCP_EMULATOR_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-floci-gcp-kms-bkt")
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_KMS)
        monkeypatch.setenv(KMS_KEY_ENV, kms_key)

        # Boot 1: unmocked GcpKmsCustodyAdapter mints, wraps via Cloud KMS HTTP, stores in GCS
        port_1 = resolve_key_custody_port()
        assert isinstance(port_1, GcpKmsCustodyAdapter)
        dek_1 = port_1.resolve_log_key()
        assert len(dek_1) == 32

        # Boot 2: cold reboot reads wrapped DEK from GCS and unwraps via Cloud KMS HTTP
        dek_2 = resolve_key_custody_port().resolve_log_key()
        assert dek_2 == dek_1

        # Explicit additionalAuthenticatedData (AAD) round-trip + tamper refusal over HTTP
        aad_ok = b'{"owner":"u1","pod":"h1"}'
        emu_tok = "floci-gcp-emulator-token"  # noqa: S105
        ct_aad = wrap_dek(
            dek_1,
            kms_key=kms_key,
            session=requests,
            token=emu_tok,
            aad=aad_ok,
        )
        assert (
            unwrap_dek(
                ct_aad,
                kms_key=kms_key,
                session=requests,
                token=emu_tok,
                aad=aad_ok,
            )
            == dek_1
        )
        with pytest.raises(ByocKeyCustodyError, match="KMS unwrap failed"):
            unwrap_dek(
                ct_aad,
                kms_key=kms_key,
                session=requests,
                token=emu_tok,
                aad=b'{"owner":"attacker","pod":"h2"}',
            )

        # Disabled KMS key refuses unwrap
        if env.mode == "loopback_gcp_wire_reference":
            env.set_kms_key_disabled(kms_key, disabled=True)
            with pytest.raises(ByocKeyCustodyError, match="KMS unwrap failed"):
                resolve_key_custody_port().resolve_log_key()
            env.set_kms_key_disabled(kms_key, disabled=False)

        # Erased bucket tombstone blocks minting a replacement DEK over real HTTP
        monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-floci-gcp-erased-bkt")
        erased_store = GcsObjectStore("hushh-floci-gcp-erased-bkt")
        assert (
            erased_store.put_if_generation_blocking(
                ERASURE_TOMBSTONE_OBJECT, b'{"erased":true}', ABSENT
            )
            is not None
        )
        with pytest.raises(ByocKeyCustodyError, match="erased"):
            resolve_key_custody_port().resolve_log_key()


@pytest.mark.asyncio
async def test_floci_wire_azure_blob_store_msi_refresh_and_commit_log_cas_over_real_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    pod_workload_identity.forget_workload_token("https://storage.azure.com")
    pod_workload_identity.forget_workload_token("https://vault.azure.net")

    with floci_azure_wire_environment() as env:
        blob_url = f"{env.endpoint_url}/husshflocistacct/pod-container/pods/owner-az-01"
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(AZURE_EMULATOR_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("IDENTITY_ENDPOINT", env.identity_endpoint)
        monkeypatch.setenv("IDENTITY_HEADER", env.identity_header)
        monkeypatch.setenv("AZURE_CLIENT_ID", env.client_id)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", blob_url)

        store = resolve_pod_object_store()
        assert isinstance(store, AzureBlobObjectStore)

        # 1. Absent (404 BlobNotFound) + If-None-Match: * create + 409 BlobAlreadyExists conflict
        raw_0, ver_0 = await store.get_with_generation("state/az.bin")
        assert raw_0 is None and ver_0 is ABSENT
        if env.mode == "loopback_azure_wire_reference":
            assert env.msi_mint_count == 1

        ver_1 = await store.put_if_generation("state/az.bin", b"az-epoch-1", ABSENT)
        assert ver_1 is not None
        assert await store.put_if_generation("state/az.bin", b"az-race", ABSENT) is None

        # 2. If-Match swap + 412 ConditionNotMet stale conflict
        ver_2 = await store.put_if_generation("state/az.bin", b"az-epoch-2", ver_1)
        assert ver_2 is not None and ver_2 != ver_1
        assert await store.put_if_generation("state/az.bin", b"az-stale", ver_1) is None

        # 3. Mid-flight MSI token revocation triggers 403 -> forget_workload_token -> /msi/token retry
        if env.mode == "loopback_azure_wire_reference":
            env.revoke_issued_tokens()
            data_after_refresh, ver_after_refresh = await store.get_with_generation("state/az.bin")
            assert data_after_refresh == b"az-epoch-2" and ver_after_refresh == ver_2
            assert env.msi_mint_count == 2

        # 4. Full PodCommitLog sealed append + replay over real HTTP Azure Blob CAS
        log = PodCommitLog(store, b"\x37" * 32, owner_id="owner-az-01")
        await log.append("note", {"az_rev": 10})
        await log.append("note", {"az_rev": 20})
        replayed = await log.replay()
        assert [r["payload"]["az_rev"] for r in replayed] == [10, 20]

        # 5. Container 403 AuthorizationPermissionMismatch surfaces as PodBlobStorageForbidden
        if env.mode == "loopback_azure_wire_reference":
            env.set_container_forbidden("pod-container", forbidden=True)
            with pytest.raises(PodBlobStorageForbidden):
                await store.get_with_generation("state/az.bin")


def test_floci_wire_azure_key_vault_rsa_oaep_custody_and_tombstone_over_real_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    pod_workload_identity.forget_workload_token("https://storage.azure.com")
    pod_workload_identity.forget_workload_token("https://vault.azure.net")

    with floci_azure_wire_environment() as env:
        version_hex = "a" * 32
        kv_key_id = f"{env.endpoint_url}/keys/pod-log-kek/{version_hex}"
        blob_url = f"{env.endpoint_url}/husshflocikvacct/kv-container/pods/owner-az-kv"

        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(AZURE_EMULATOR_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("IDENTITY_ENDPOINT", env.identity_endpoint)
        monkeypatch.setenv("IDENTITY_HEADER", env.identity_header)
        monkeypatch.setenv("AZURE_CLIENT_ID", env.client_id)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", blob_url)
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_VAULT)
        monkeypatch.setenv(KEY_VAULT_KEY_ENV, kv_key_id)

        # Boot 1: GET /keys/... RSA-2048 JWK -> local OAEP-256 wrap -> POST /unwrapkey proof -> Blob CAS
        port_1 = resolve_key_custody_port()
        assert isinstance(port_1, AzureKeyVaultCustodyAdapter)
        dek_1 = port_1.resolve_log_key()
        assert len(dek_1) == 32

        # Boot 2: Cold reboot reads wrapped envelope from Blob and unwraps via Key Vault /unwrapkey
        dek_2 = resolve_key_custody_port().resolve_log_key()
        assert dek_2 == dek_1

        # Disabled Key Vault key refuses unwrap
        if env.mode == "loopback_azure_wire_reference":
            env.set_vault_key_disabled(kv_key_id, disabled=True)
            with pytest.raises(PodKeyVaultCustodyError, match="Key Vault refused"):
                resolve_key_custody_port().resolve_log_key()
            env.set_vault_key_disabled(kv_key_id, disabled=False)

        # Erased blob prefix tombstone blocks minting a replacement DEK
        erased_blob_url = f"{env.endpoint_url}/husshflocikvacct/kv-container/pods/owner-az-erased"
        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", erased_blob_url)
        erased_store = AzureBlobObjectStore(erased_blob_url)
        assert (
            erased_store.put_if_generation_blocking(
                ERASURE_TOMBSTONE_OBJECT, b'{"erased":true}', ABSENT
            )
            is not None
        )
        with pytest.raises(PodKeyVaultCustodyError, match="erased"):
            resolve_key_custody_port().resolve_log_key()


@pytest.mark.parametrize("deploy_env", ["production", "prod", "uat"])
def test_gcp_azure_and_prefix_emulator_overrides_fail_closed_in_uat_and_production(
    monkeypatch: pytest.MonkeyPatch, deploy_env: str
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", deploy_env)

    monkeypatch.setenv(GCP_EMULATOR_URL_ENV, "http://127.0.0.1:4443")
    with pytest.raises(PodEmulatorEndpointError, match="refused in UAT and production"):
        GcsObjectStore("prod-bkt")

    monkeypatch.delenv(GCP_EMULATOR_URL_ENV, raising=False)
    monkeypatch.setenv(GCP_STORAGE_EMULATOR_ENV, "127.0.0.1:4443")
    with pytest.raises(PodEmulatorEndpointError, match="refused in UAT and production"):
        resolve_gcp_storage_origin()
    monkeypatch.delenv(GCP_STORAGE_EMULATOR_ENV, raising=False)

    monkeypatch.setenv(AZURE_EMULATOR_URL_ENV, "http://127.0.0.1:10000")
    with pytest.raises(PodBlobStorageError, match="refused in UAT and production"):
        AzureBlobObjectStore("http://127.0.0.1:10000/acct123/cont-1/pods/u1")

    monkeypatch.setenv(KEY_VAULT_KEY_ENV, f"http://127.0.0.1:10000/keys/k1/{'b' * 32}")
    with pytest.raises(PodKeyVaultCustodyError, match="refused in UAT and production"):
        AzureKeyVaultCustodyAdapter().resolve_log_key()
    monkeypatch.delenv(AZURE_EMULATOR_URL_ENV, raising=False)

    monkeypatch.setenv(PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
    with pytest.raises(PodMultiCloudStorageError, match="refused in UAT and production"):
        PrefixTokenObjectStore("http://127.0.0.1:9000/pods/u1", bearer_token="tok")  # noqa: S106


def test_gcp_and_azure_non_loopback_http_emulator_endpoints_are_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_storage_and_custody_env(monkeypatch)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")

    monkeypatch.setenv(GCP_EMULATOR_URL_ENV, "http://10.0.0.42:4443")
    with pytest.raises(PodEmulatorEndpointError, match="loopback"):
        GcsObjectStore("lan-bkt")
    monkeypatch.delenv(GCP_EMULATOR_URL_ENV, raising=False)

    monkeypatch.setenv(AZURE_EMULATOR_URL_ENV, "http://10.0.0.42:10000")
    with pytest.raises(PodBlobStorageError, match="loopback"):
        AzureBlobObjectStore("http://10.0.0.42:10000/acct123/cont-1/pods/u1")


def _cell_cfg_json(
    *,
    cell_id: str = "cell-az-eastus2-dev-01",
    slots_count: int = 2,
    soft: int = 40,
    hard: int = 50,
    min_warm: int = 2,
    max_warm: int = 3,
    batch: int = 1,
) -> dict[str, object]:
    slots = [
        {
            "slotId": f"slot{i:02d}",
            "appName": f"ca-pod-slot{i:02d}",
            "appId": (
                "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/"
                "resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/"
                f"Microsoft.App/containerApps/ca-pod-slot{i:02d}"
            ),
            "fqdn": f"ca-pod-slot{i:02d}.icystone.eastus2.azurecontainerapps.io",
            "identityId": (
                "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/"
                "resourcegroups/rg-hussh-cell-dev-eastus2-01/providers/"
                f"Microsoft.ManagedIdentity/userAssignedIdentities/id-pod-slot{i:02d}"
            ),
            "identityClientId": f"00000000-0000-4000-8000-{i:012x}",
            "identityPrincipalId": f"11111111-1111-4000-8000-{i:012x}",
            "blobUrl": f"https://sthusshcelldeveus201.blob.core.windows.net/pod-slot{i:02d}",
            "keyVaultKey": f"https://kv-h1-celldeveus201.vault.azure.net/keys/pod-log-key-slot{i:02d}/ver{i:02d}",
            "signingSecretUrl": f"https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-key-slot{i:02d}",
        }
        for i in range(1, slots_count + 1)
    ]
    return {
        "cellId": cell_id,
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
        "imageDigest": "sha256:" + ("9" * 64),
        "softWatermark": soft,
        "hardWatermark": hard,
        "minWarmSkeletons": min_warm,
        "maxWarmSkeletons": max_warm,
        "replenishBatchSize": batch,
        "sharedCellFixedMonthlyUsd": 5.0,
        "perWarmSlotStandingMonthlyUsd": 0.0,
        "slots": slots,
    }


@pytest.mark.asyncio
async def test_umbrella_cell_replenisher_mints_slot_with_zero_idle_cost_and_o1_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio as _asyncio

    from hushh_mcp.services.azure_arm_client import ArmError
    from hushh_mcp.services.compute_backend import BACKEND_AZURE, PodSpec
    from hushh_mcp.services.hosted_azure_backend import HostedAzureBackend
    from hushh_mcp.services.pod_umbrella_cell_pool import (
        PodSkeletonPoolService,
        UmbrellaCellRegistry,
    )
    from hushh_mcp.services.umbrella_cell_replenisher import (
        UmbrellaCellReplenisher,
        provision_azure_warm_skeleton_sync,
    )

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv("HUSSH_UMBRELLA_REPLENISHER_ENABLED", "true")
    monkeypatch.setenv("DEPLOYMENT_MODE", "hub")
    PodSkeletonPoolService.reset_process_claims()

    registry = UmbrellaCellRegistry(
        {"environment": "dev", "cells": [_cell_cfg_json(slots_count=2, min_warm=2, max_warm=3)]}
    )

    class _ReplenishingFakeArm:
        def __init__(self) -> None:
            self.apps: dict[str, dict[str, object]] = {
                "ca-pod-slot01": {
                    "name": "ca-pod-slot01",
                    "id": "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.App/containerapps/ca-pod-slot01",
                    "tags": {
                        "hussh-cell-id": "cell-az-eastus2-dev-01",
                        "hussh-slot-id": "slot01",
                        "hussh-pool-state": "bound_active",
                        "hussh-owner-hash": "sha256:" + ("a" * 64),
                    },
                    "properties": {
                        "provisioningState": "Succeeded",
                        "latestReadyRevisionName": "ca-pod-slot01--001",
                        "workloadProfileName": "Consumption",
                        "configuration": {
                            "ingress": {
                                "fqdn": "ca-pod-slot01.icystone.eastus2.azurecontainerapps.io"
                            },
                            "secrets": [
                                {
                                    "name": "app-signing-key",
                                    "keyVaultUrl": "https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-key-slot01",
                                }
                            ],
                        },
                        "template": {"scale": {"minReplicas": 0, "maxReplicas": 1}},
                    },
                },
                "ca-pod-slot02": {
                    "name": "ca-pod-slot02",
                    "id": "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.App/containerapps/ca-pod-slot02",
                    "tags": {
                        "hussh-cell-id": "cell-az-eastus2-dev-01",
                        "hussh-slot-id": "slot02",
                        "hussh-pool-state": "warm_standby",
                    },
                    "properties": {
                        "provisioningState": "Succeeded",
                        "latestReadyRevisionName": "ca-pod-slot02--001",
                        "workloadProfileName": "Consumption",
                        "configuration": {
                            "ingress": {
                                "fqdn": "ca-pod-slot02.icystone.eastus2.azurecontainerapps.io"
                            },
                            "secrets": [
                                {
                                    "name": "app-signing-key",
                                    "keyVaultUrl": "https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-key-slot02",
                                }
                            ],
                        },
                        "template": {"scale": {"minReplicas": 0, "maxReplicas": 1}},
                    },
                },
            }
            self.keys: dict[str, dict[str, object]] = {}
            self.secrets: dict[str, dict[str, object]] = {}
            self.role_attempts = 0
            self.role_scopes: list[str] = []
            self.list_calls = 0

        def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, object]:
            assert api_version
            if op == "hosted_azure_list_cell" or path.endswith(
                "/providers/Microsoft.App/containerApps"
            ):
                self.list_calls += 1
                return {"value": list(self.apps.values())}
            if path in self.keys:
                return self.keys[path]
            raise ArmError("not_found", status=404, code="NotFound", message="missing", op=op)

        def get_or_none(
            self, path: str, *, api_version: str, op: str = ""
        ) -> dict[str, object] | None:
            assert api_version
            if "/keys/" in path:
                return self.keys.get(path)
            if "/secrets/" in path:
                return self.secrets.get(path)
            return None

        def put(
            self, path: str, *, api_version: str, body: dict[str, object], op: str = ""
        ) -> dict[str, object]:
            assert api_version
            if "/providers/Microsoft.Authorization/roleAssignments/" in path:
                self.role_attempts += 1
                scope = path.split("/providers/Microsoft.Authorization/roleAssignments/", 1)[0]
                if self.role_attempts == 1:
                    raise ArmError(
                        "bad_request",
                        status=400,
                        code="PrincipalNotFound",
                        message="propagating",
                        op=op,
                    )
                self.role_scopes.append(scope)
                if self.role_attempts == 2:
                    raise ArmError(
                        "conflict", status=409, code="RoleAssignmentExists", message="exists", op=op
                    )
                return {"id": path}
            if "/userAssignedIdentities/" in path:
                return {
                    "id": path,
                    "properties": {
                        "clientId": "00000000-0000-4000-8000-000000000003",
                        "principalId": "11111111-1111-4000-8000-000000000003",
                    },
                }
            if "/keys/" in path:
                self.keys[path] = {
                    "properties": {
                        "keyUriWithVersion": "https://kv-h1-celldeveus201.vault.azure.net/keys/pod-log-key-slot03/ver03"
                    }
                }
                return self.keys[path]
            if "/secrets/" in path:
                self.secrets[path] = {
                    "properties": {
                        "secretUri": "https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-key-slot03"
                    }
                }
                return self.secrets[path]
            if "/providers/Microsoft.App/containerApps/" in path:
                app_name = path.rsplit("/", 1)[-1]
                tpl = body["properties"]["template"]  # type: ignore[index]
                scale = tpl["scale"]  # type: ignore[index]
                if op == "replenish_warm_container_app":
                    env_map = {e["name"]: e.get("value") for e in tpl["containers"][0]["env"]}
                    assert env_map["POD_STORAGE_BACKEND"] == "null"
                    assert "HUSHH_ID" not in env_map
                    assert "POD_STORAGE_AZURE_BLOB_URL" not in env_map
                    assert scale["minReplicas"] == 0 and scale["cooldownPeriod"] == 60
                    assert body["tags"]["hussh-pool-state"] == "warm_standby"  # type: ignore[index]
                    assert "hussh-owner-hash" not in body["tags"]  # type: ignore[operator]
                record = {
                    "name": app_name,
                    "id": path.replace("/containerApps/", "/containerapps/"),
                    "tags": body["tags"],
                    "identity": {
                        "userAssignedIdentities": {
                            "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourcegroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-pod-slot03": {
                                "clientId": "00000000-0000-4000-8000-000000000003",
                                "principalId": "11111111-1111-4000-8000-000000000003",
                            }
                        }
                    },
                    "properties": {
                        "provisioningState": "Succeeded",
                        "latestReadyRevisionName": f"{app_name}--rev01",
                        "workloadProfileName": body["properties"]["workloadProfileName"],  # type: ignore[index]
                        "configuration": {
                            "ingress": {
                                "fqdn": f"{app_name}.icystone.eastus2.azurecontainerapps.io"
                            },
                            "secrets": body["properties"]["configuration"]["secrets"],  # type: ignore[index]
                        },
                        "template": tpl,
                    },
                }
                self.apps[app_name] = record
                return record
            return {"properties": {"provisioningState": "Succeeded"}}

    arm = _ReplenishingFakeArm()
    pool = PodSkeletonPoolService(
        registry=registry,
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=arm, live=True),  # type: ignore[arg-type]
    )
    replenisher = UmbrellaCellReplenisher(
        registry=registry,
        pool=pool,
        occupied_loader=lambda: {registry.azure_cell().slots[0].app_id},
        provisioner=lambda cell, sid: provision_azure_warm_skeleton_sync(
            cell,
            sid,
            arm_client=arm,
            sleep=lambda _s: None,  # type: ignore[arg-type]
        ),
    )

    rep1 = await replenisher.replenish_once()
    assert rep1.skipped is False
    assert rep1.created_slots == ("cell-az-eastus2-dev-01:slot03",)
    assert any("/pod-slot03" in s for s in arm.role_scopes)
    assert any("/keys/pod-log-key-slot03" in s for s in arm.role_scopes)
    assert any("/secrets/pod-signing-key-slot03" in s for s in arm.role_scopes)

    # Idempotent steady pass must create 0 duplicate slots and execute in O(1) ARM GETs.
    before_calls = arm.list_calls
    rep2 = await replenisher.replenish_once()
    assert rep2.reason == "steady" and rep2.created_slots == ()
    assert arm.list_calls == before_calls + 1

    # Snapshot dynamically discovers slot03 even though static config only lists slot01 & slot02.
    snap = await pool.async_snapshot_status()
    cell_rep = snap["cells"][0]
    assert cell_rep["activeSlots"] == 1
    assert cell_rep["warmStandbySlots"] == 2
    assert cell_rep["slotIdsWarm"] == ["slot02", "slot03"]
    assert cell_rep["needsReplenishment"] is False
    assert cell_rep["costEconomics"]["costGuardHealthy"] is True
    assert cell_rep["costEconomics"]["idleComputeHourlyUsdPerWarmSlot"] == 0.0
    assert cell_rep["costEconomics"]["controlPlaneInspectionOnly"] is True
    assert cell_rep["costEconomics"]["zeroScaleVerifiedSlots"] == ["slot02", "slot03"]

    # New owner can claim dynamically minted slot03 cleanly when slot02 is also occupied.
    async def _keys(row: dict[str, object], *, require_identity: bool = True) -> dict[str, str]:
        assert require_identity is True and row
        return {
            "podPublicKey": "x25519-s3",
            "podKeyId": "kid-s3",
            "podKeyWrappingAlg": "X25519-HKDF-SHA256-AES256GCM",
            "podSigningKey": "ed25519-s3",
            "podSigningKeyId": "skid-s3",
        }

    claimer = PodSkeletonPoolService(
        registry=registry,
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=arm, live=True),  # type: ignore[arg-type]
        key_fetcher=_keys,
    )
    claimed = await claimer.claim_warm_skeleton_for_owner(
        spec=PodSpec(
            hushh_id="ha1_owner_slot03",
            phone_e164_hash="ph3",
            pod_pubkey="",
            region="eastus2",
            deployment_target=BACKEND_AZURE,
        ),
        owner_id="uid-owner-slot03",
        occupied_app_ids={s.app_id for s in registry.azure_cell().slots},
    )
    assert claimed.slot.slot_id == "slot03"
    await _asyncio.sleep(0)


@pytest.mark.asyncio
async def test_umbrella_cell_replenisher_cost_guard_circuit_breaker_and_no_warm_fqdn_probes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.hosted_azure_backend import HostedAzureBackend
    from hushh_mcp.services.pod_umbrella_cell_pool import (
        PodSkeletonPoolService,
        UmbrellaCellRegistry,
    )
    from hushh_mcp.services.umbrella_cell_replenisher import UmbrellaCellReplenisher

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv("HUSSH_UMBRELLA_REPLENISHER_ENABLED", "true")
    monkeypatch.setenv("DEPLOYMENT_MODE", "hub")

    registry = UmbrellaCellRegistry(
        {"environment": "dev", "cells": [_cell_cfg_json(slots_count=1, min_warm=2)]}
    )

    class _MinReplicaViolationArm:
        def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, object]:
            assert path.endswith("/containerApps") and api_version and op
            return {
                "value": [
                    {
                        "name": "ca-pod-slot01",
                        "tags": {
                            "hussh-cell-id": "cell-az-eastus2-dev-01",
                            "hussh-slot-id": "slot01",
                            "hussh-pool-state": "warm_standby",
                        },
                        "properties": {
                            "provisioningState": "Succeeded",
                            "latestReadyRevisionName": "ca-pod-slot01--001",
                            "workloadProfileName": "Consumption",
                            "configuration": {
                                "ingress": {
                                    "fqdn": "ca-pod-slot01.icystone.eastus2.azurecontainerapps.io"
                                },
                            },
                            "template": {"scale": {"minReplicas": 1, "maxReplicas": 1}},
                        },
                    }
                ]
            }

    mint_called = False

    def _forbid_mint(_cell: object, _sid: str) -> object:
        nonlocal mint_called
        mint_called = True
        raise AssertionError("Cost guard circuit breaker must block minting")

    # Ensure observation never opens a data-plane HTTP connection to warm slot FQDNs.
    def _no_http_wake(*_a: object, **_kw: object) -> object:
        raise AssertionError("Control-plane observation must never probe warm slot HTTP endpoints")

    monkeypatch.setattr(requests, "get", _no_http_wake)
    monkeypatch.setattr(requests, "post", _no_http_wake)

    pool = PodSkeletonPoolService(
        registry=registry,
        backend_factory=lambda slot: HostedAzureBackend(
            slot=slot,
            arm_client=_MinReplicaViolationArm(),
            live=True,  # type: ignore[arg-type]
        ),
    )
    replenisher = UmbrellaCellReplenisher(
        registry=registry,
        pool=pool,
        occupied_loader=lambda: set(),
        provisioner=_forbid_mint,  # type: ignore[arg-type]
    )
    rep = await replenisher.replenish_once()
    assert rep.created_slots == () and mint_called is False
    snap = await pool.async_snapshot_status()
    assert snap["cells"][0]["costEconomics"]["costGuardHealthy"] is False
    assert snap["cells"][0]["costEconomics"]["idleComputeHourlyUsdPerWarmSlot"] > 0


def test_umbrella_cell_multi_cell_bin_packing_spillover_and_uat_prod_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.hosted_azure_backend import HostedAzureBackend
    from hushh_mcp.services.pod_umbrella_cell_pool import (
        PodSkeletonPoolService,
        UmbrellaCellRegistry,
        project_fleet_scale_economics,
    )
    from hushh_mcp.services.umbrella_cell_replenisher import (
        UmbrellaCellReplenisher,
        provision_azure_warm_skeleton_sync,
    )

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    PodSkeletonPoolService.reset_process_claims()

    cell1 = _cell_cfg_json(
        cell_id="cell-az-eastus2-dev-01", slots_count=2, soft=1, hard=3, min_warm=1
    )
    cell2 = _cell_cfg_json(
        cell_id="cell-az-eastus2-dev-02", slots_count=2, soft=40, hard=50, min_warm=1
    )
    registry = UmbrellaCellRegistry({"environment": "dev", "cells": [cell1, cell2]})

    # Cell 1 has 1 active (at softWatermark=1) and 1 warm; Cell 2 has 0 active and 2 warm -> spill to cell-02.
    pool = PodSkeletonPoolService(
        registry=registry,
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=object(), live=False),  # type: ignore[arg-type]
    )
    chosen = pool.select_admitting_azure_cell_sync(
        occupied_app_ids={registry.list_cells()[0].slots[0].app_id}
    )
    assert chosen.cell_id == "cell-az-eastus2-dev-02"

    # When both cells are below softWatermark (raise cell1 soft=5), prefer cell1 (bin-packing active cells).
    cell1_pack = _cell_cfg_json(
        cell_id="cell-az-eastus2-dev-01", slots_count=2, soft=5, hard=8, min_warm=1
    )
    reg_pack = UmbrellaCellRegistry({"environment": "dev", "cells": [cell1_pack, cell2]})
    pool_pack = PodSkeletonPoolService(
        registry=reg_pack,
        backend_factory=lambda slot: HostedAzureBackend(slot=slot, arm_client=object(), live=False),  # type: ignore[arg-type]
    )
    packed = pool_pack.select_admitting_azure_cell_sync(
        occupied_app_ids={reg_pack.list_cells()[0].slots[0].app_id}
    )
    assert packed.cell_id == "cell-az-eastus2-dev-01"

    # Validate scale economics across the full 40/50 Azure cell template (0.125 USD/owner/mo).
    proj = project_fleet_scale_economics([registry.list_cells()[1]])
    tier_10k = next(r for r in proj["providers"]["azure"] if r["targetActiveOwners"] == 10000)
    assert tier_10k["warmBufferIdleComputeMonthlyUsd"] == 0.0
    assert tier_10k["effectiveFixedMonthlyUsdPerOwner"] < 0.25

    for forbidden in ("uat", "production"):
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", forbidden)
        with pytest.raises(PermissionError):
            provision_azure_warm_skeleton_sync(registry.azure_cell(), "slot03")

    import asyncio as _asyncio

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    rep = _asyncio.run(UmbrellaCellReplenisher(registry=registry).replenish_once())
    assert rep.skipped is True and rep.reason == "non_dev_lane"
