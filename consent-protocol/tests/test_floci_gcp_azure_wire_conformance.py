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
