# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Real `boto3` HTTP/SigV4 wire conformance for S3 CAS + AWS KMS custody via Floci.

Exercises unmocked `S3ObjectStore`, `PodCommitLog`, and `AwsKmsCustodyAdapter` clients
over real loopback TCP sockets (`floci` native binary when installed, or the built-in
AWS S3 XML + KMS `AWSJson1_1` wire reference server), plus fail-closed refusal of
emulator endpoints in UAT/production and non-loopback HTTP.
"""

from __future__ import annotations

import boto3  # type: ignore[import-not-found]
import pytest

from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError
from hushh_mcp.services.pod_commit_log import PodCommitLog
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    AWS_KMS_KEY_ENV,
    CUSTODY_MODE_ENV,
    CUSTODY_OWNER_KMS,
    AwsKmsCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_s3_object_store import (
    FLOCI_ENDPOINT_URL_ENV,
    S3_URI_ENV,
    PodMultiCloudStorageError,
    PodMultiCloudStorageForbidden,
    S3ObjectStore,
    resolve_aws_boto3_client_kwargs,
)
from hushh_mcp.services.pod_storage import resolve_pod_object_store
from hushh_mcp.services.provider_capability_registry import PROVIDER_CAPABILITY_REGISTRY
from tests.floci_wire_harness import floci_aws_wire_environment


@pytest.mark.asyncio
async def test_floci_wire_s3_object_store_and_commit_log_cas_over_real_boto3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-pod-bkt/pods/owner-alpha")
        for other_env in (
            "POD_STORAGE_LOCAL_ROOT",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_AZURE_BLOB_URL",
            "POD_STORAGE_PREFIX_TOKEN_URL",
        ):
            monkeypatch.delenv(other_env, raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        bootstrap_s3 = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        bootstrap_s3.create_bucket(Bucket="hushh-floci-pod-bkt")

        # Unmocked S3ObjectStore resolved strictly from env -> real boto3 HTTP socket!
        store = resolve_pod_object_store()
        assert isinstance(store, S3ObjectStore)

        payload_0, ver_0 = await store.get_with_generation("state/marker.bin")
        assert payload_0 is None and ver_0 is ABSENT

        ver_1 = await store.put_if_generation("state/marker.bin", b"epoch-1", ABSENT)
        assert ver_1 is not None
        # Stale ABSENT loses conditional If-None-Match: * over the HTTP wire (412 -> None).
        assert await store.put_if_generation("state/marker.bin", b"epoch-race", ABSENT) is None

        ver_2 = await store.put_if_generation("state/marker.bin", b"epoch-2", ver_1)
        assert ver_2 is not None and ver_2 != ver_1
        # Stale ETag loses conditional If-Match over the HTTP wire (412 -> None).
        assert await store.put_if_generation("state/marker.bin", b"epoch-stale", ver_1) is None

        read_back, read_ver = await store.get_with_generation("state/marker.bin")
        assert read_back == b"epoch-2" and read_ver == ver_2

        # Full PodCommitLog pointer advance over real boto3 HTTP S3 CAS.
        log = PodCommitLog(store, b"\x42" * 32, owner_id="owner-alpha")
        await log.append("note", {"rev": 1})
        await log.append("note", {"rev": 2})
        replayed = await log.replay()
        assert [r["payload"]["rev"] for r in replayed] == [1, 2]

        # Bucket IAM revocation surfaces as PodMultiCloudStorageForbidden (never absence).
        if env.mode == "loopback_wire_reference":
            env.set_bucket_forbidden("hushh-floci-pod-bkt", forbidden=True)
            with pytest.raises(PodMultiCloudStorageForbidden):
                await store.get_with_generation("state/marker.bin")


def test_floci_wire_aws_kms_custody_aad_binding_and_tombstone_over_real_boto3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-kms-bkt/pods/owner-kms")
        for other_env in (
            "POD_STORAGE_LOCAL_ROOT",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_AZURE_BLOB_URL",
            "POD_STORAGE_PREFIX_TOKEN_URL",
            "HUSSH_POD_KMS_KEY",
            "HUSSH_POD_KEY_VAULT_KEY",
            "HUSSH_POD_ACE_SEAL_SCALAR",
        ):
            monkeypatch.delenv(other_env, raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        s3_admin = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        kms_admin = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
        s3_admin.create_bucket(Bucket="hushh-floci-kms-bkt")
        key_arn = kms_admin.create_key()["KeyMetadata"]["Arn"]

        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_KMS)
        monkeypatch.setenv(AWS_KMS_KEY_ENV, key_arn)
        monkeypatch.setenv("HUSSH_ID", "owner-sovereign-001")

        # Boot 1: unmocked AwsKmsCustodyAdapter + unmocked S3ObjectStore mints & wraps DEK.
        port_boot_1 = resolve_key_custody_port()
        assert isinstance(port_boot_1, AwsKmsCustodyAdapter)
        dek_1 = port_boot_1.resolve_log_key()
        assert len(dek_1) == 32

        # Boot 2: cold restart unwraps exact same DEK over real KMS Decrypt wire call.
        dek_2 = resolve_key_custody_port().resolve_log_key()
        assert dek_2 == dek_1

        # Wrong owner HUSSH_ID changes EncryptionContext AAD -> KMS Decrypt fails closed!
        monkeypatch.setenv("HUSSH_ID", "attacker-impersonator-999")
        with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
            resolve_key_custody_port().resolve_log_key()

        # Disabled/revoked KMS key refuses unwrap on existing pod state.
        monkeypatch.setenv("HUSSH_ID", "owner-sovereign-001")
        if env.mode == "loopback_wire_reference":
            env.set_kms_key_disabled(key_arn, disabled=True)
            with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
                resolve_key_custody_port().resolve_log_key()
            env.set_kms_key_disabled(key_arn, disabled=False)

        # Crypto-erasure tombstone refuses minting a fresh DEK in a tombstoned prefix.
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-kms-bkt/pods/owner-erased")
        erased_store = resolve_pod_object_store()
        assert (
            erased_store.put_if_generation_blocking(
                ERASURE_TOMBSTONE_OBJECT, b'{"erased":true}', ABSENT
            )
            is not None
        )
        with pytest.raises(ByocKeyCustodyError):
            resolve_key_custody_port().resolve_log_key()

        # Emulator wire pass NEVER promotes live hypervisor/IAM qualification or DB admission.
        aws_spec = PROVIDER_CAPABILITY_REGISTRY["user_aws"]
        assert aws_spec.sandbox_capability.execution_qualified is False
        assert aws_spec.registry_sql_admitted is False


@pytest.mark.parametrize("deploy_env", ["production", "prod", "uat"])
def test_emulator_endpoint_overrides_fail_closed_in_uat_and_production(
    monkeypatch: pytest.MonkeyPatch, deploy_env: str
) -> None:
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://127.0.0.1:4566")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", deploy_env)

    store = S3ObjectStore("s3://hushh-prod-guard-bkt/pods/u1")
    with pytest.raises(PodMultiCloudStorageError, match="refused in UAT and production"):
        store.get_with_generation_blocking("head.json")

    adapter = AwsKmsCustodyAdapter(
        store=S3ObjectStore("s3://hushh-prod-guard-bkt/pods/u1", s3_client=object()),
        key_arn="arn:aws:kms:us-east-1:123456789012:key/abc",
        hushh_id="owner-1",
    )
    with pytest.raises(ByocKeyCustodyError, match="refused in UAT and production"):
        adapter.resolve_log_key()


def test_non_loopback_http_emulator_endpoint_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://10.0.0.42:4566")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")

    store = S3ObjectStore("s3://hushh-lan-guard-bkt/pods/u1")
    with pytest.raises(PodMultiCloudStorageError, match="loopback"):
        store.get_with_generation_blocking("head.json")
