# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Wave 4 multi-cloud substrate & browser runtime uniformity contract tests.

Verifies:
1. `provider_capability_registry` and `browser_runtime.qualification` agree across
   `gcp`, `ace`, `user_gcp`, `user_azure`, and `user_aws` without hardcoded branches.
2. Chromium site-isolation flags and Linux Landlock ABI worker confinement enforce
   uniform defense-in-depth on hypervisor container hosts (`azure_container_apps`,
   `aws_fargate`) while failing open only on `ENOSYS`/`EOPNOTSUPP` (e.g. gVisor).
3. `AwsKmsCustodyAdapter`, `S3ObjectStore`, and `PrefixTokenObjectStore` uphold
   create-only CAS (`ABSENT`), race-loser adoption, AAD/prefix isolation, and
   crypto-erase tombstones.
4. Platform identity, owner-cloud XOR, and `AzureBrowserDelivery` support `ace_envelope`
   custody cleanly alongside native KMS/Key Vault custody.
"""

from __future__ import annotations

import ctypes
import errno
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from browser_runtime.qualification import (
    default_chromium_sandbox_for_cloud,
    get_host_capability,
    validate_qualification,
)
from hushh_mcp.services.ace_backend import AceComputeBackend
from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError
from hushh_mcp.services.compute_backend import (
    BACKEND_ACE,
    BACKEND_USER_AWS,
    CUSTODY_ACE_ENVELOPE,
    CUSTODY_FLEET_HKDF,
    CUSTODY_OWNER_KMS,
    CUSTODY_OWNER_VAULT,
    ComputeBackend,
    PodSpec,
    effective_custody_mode,
    is_known_pod_target,
    is_owner_cloud_target,
    owner_cloud_coordinates_complete,
    resolve_compute_backend,
    resolve_compute_backend_for_spec,
)
from hushh_mcp.services.pod_browser.container_worker import (
    _SYS_LANDLOCK_ADD_RULE,
    _SYS_LANDLOCK_CREATE_RULESET,
    _SYS_LANDLOCK_RESTRICT_SELF,
    apply_landlock_worker_confinement,
)
from hushh_mcp.services.pod_browser.contracts import (
    _CLOUD_SHARED_CONTAINER_SANDBOX,
    BrowserReadiness,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.launch_protocol import LaunchRefused
from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    AWS_KMS_KEY_ENV,
    AwsKmsCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_owner_cloud import owner_cloud_provider
from hushh_mcp.services.pod_platform import pod_revision_name, pod_service_name, workload_platform
from hushh_mcp.services.pod_s3_object_store import (
    PodMultiCloudStorageForbidden,
    PrefixTokenObjectStore,
    S3ObjectStore,
)
from hushh_mcp.services.pod_workload_identity import (
    PodWorkloadIdentityUnavailable,
    google_metadata_access_endpoint,
)
from hushh_mcp.services.provider_capability_registry import (
    PROVIDER_CAPABILITY_REGISTRY,
    hosted_cloud_targets,
    owner_cloud_required_coordinates_map,
    owner_cloud_targets,
    verify_browser_contract_alignment,
)
from hushh_mcp.services.user_aws_backend import UserAwsBackend
from hushh_mcp.services.user_cloud_service import UserCloud


def test_provider_and_browser_capability_registries_stay_in_lockstep() -> None:
    assert set(PROVIDER_CAPABILITY_REGISTRY) == {
        "gcp",
        "ace",
        "user_gcp",
        "user_azure",
        "user_aws",
    }
    assert hosted_cloud_targets() == ("gcp", "ace")
    assert owner_cloud_targets() == ("user_gcp", "user_azure", "user_aws")
    assert verify_browser_contract_alignment(_CLOUD_SHARED_CONTAINER_SANDBOX)
    for cloud, expected in _CLOUD_SHARED_CONTAINER_SANDBOX.items():
        assert default_chromium_sandbox_for_cloud(cloud) is expected
    for spec in PROVIDER_CAPABILITY_REGISTRY.values():
        host_cap = spec.sandbox_capability
        assert host_cap.provider == spec.provider_family
        assert is_known_pod_target(spec.target_id)
        assert is_owner_cloud_target(spec.target_id) is (spec.tenancy == "owner_cloud")
    assert owner_cloud_required_coordinates_map()["user_aws"] == (
        "account_id",
        "region",
        "role_arn",
    )


def test_unprobed_hosts_remain_fail_closed_in_qualification_until_receipt_landed() -> None:
    for host in ("gcp_ace", "aws_fargate"):
        cap = get_host_capability(host)
        assert cap is not None and not cap.execution_qualified
        ready = BrowserReadiness(
            version=2,
            cloud=cap.provider,  # type: ignore[arg-type]
            component_digest="sha256:" + "a" * 64,
            boundary="shared_owner_container",
            chromium_sandbox=cap.chromium_internal_sandbox,
            browser_start_verified=True,
            runtime_uid_verified=True,
            lifecycle_verified=True,
            broker_bridge_verified=True,
            ephemeral_bridge_verified=True,
            model_transport_verified=True,
            model_name="gemini-3.7-flash",
            model_transport="google.adk.models.google_llm.Gemini",
        )
        ready.require_ready()
        statement = {
            "version": 2,
            "host_kind": host,
            "source_revision": "b" * 40,
            "image_tag": "synthetic-tag",
            "evidence_sha256": "c" * 64,
            "public_policy_sha256": "d" * 64,
            "readiness": ready.model_dump(),
        }
        with pytest.raises(ValueError, match="Browser execution or image is not qualified"):
            validate_qualification(
                statement,
                image_digest="sha256:" + "a" * 64,
                source_revision="b" * 40,
            )

    # Dedicated microVM isolated_browser host (`aws_firecracker`, analog to `azure_vm`)
    # also remains fail-closed until a reviewed live receipt lands.
    fc_cap = get_host_capability("aws_firecracker")
    assert fc_cap is not None and not fc_cap.v1_legacy_qualified and not fc_cap.execution_qualified
    fc_ready = BrowserReadiness(
        version=1,
        cloud="aws",
        component_digest="sha256:" + "a" * 64,
        boundary="isolated_browser",
        chromium_sandbox=True,
        isolated=True,
        direct_egress_denied=True,
        broker_bridge_verified=True,
        ephemeral_bridge_verified=True,
        private_access_denied=True,
        model_transport_verified=True,
        model_name="gemini-3.7-flash",
        model_transport="google.adk.models.google_llm.Gemini",
    )
    fc_ready.require_ready()
    with pytest.raises(ValueError, match="Browser execution or image is not qualified"):
        validate_qualification(
            {
                "version": 1,
                "host_kind": "aws_firecracker",
                "source_revision": "b" * 40,
                "image_tag": "synthetic-tag",
                "evidence_sha256": "c" * 64,
                "public_policy_sha256": "d" * 64,
                "readiness": fc_ready.model_dump(),
            },
            image_digest="sha256:" + "a" * 64,
            source_revision="b" * 40,
        )


@pytest.mark.asyncio
async def test_playwright_launches_uniform_site_isolation_flags_on_every_cloud(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sys

    for sandbox in (True, False):
        cdp = SimpleNamespace(
            send=AsyncMock(return_value={"frameTree": {"frame": {"id": "main"}}}),
            on=Mock(),
        )
        page = SimpleNamespace(set_default_timeout=Mock(), set_default_navigation_timeout=Mock())
        context = SimpleNamespace(
            new_page=AsyncMock(return_value=page),
            new_cdp_session=AsyncMock(return_value=cdp),
            route_web_socket=AsyncMock(),
            on=Mock(),
        )
        browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
        launch = AsyncMock(return_value=browser)
        playwright = SimpleNamespace(
            chromium=SimpleNamespace(launch=launch),
            stop=AsyncMock(),
        )
        monkeypatch.setitem(
            sys.modules,
            "playwright.async_api",
            SimpleNamespace(
                async_playwright=lambda pw=playwright: SimpleNamespace(
                    start=AsyncMock(return_value=pw)
                )
            ),
        )
        executor = PlaywrightExecutor(network=SimpleNamespace(), chromium_sandbox=sandbox)
        await executor.initialize()
        args = launch.call_args.kwargs["args"]
        for required_flag in (
            "--site-per-process",
            "--disable-extensions",
            "--disable-sync",
            "--no-first-run",
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        ):
            assert required_flag in args
        await executor.close()


def test_landlock_worker_confinement_enforces_abi3_excluding_app_and_handles_enosys(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    import hushh_mcp.services.pod_browser.container_worker as cw

    monkeypatch.setattr(cw.sys, "platform", "linux")
    monkeypatch.setattr(cw.platform, "machine", lambda: "x86_64")

    # 1. gVisor-style ENOSYS -> cleanly unsupported (never breaks Cloud Run).
    class EnosysLib:
        def syscall(self, nr: int, *_args: Any) -> int:
            assert nr == _SYS_LANDLOCK_CREATE_RULESET
            ctypes.set_errno(errno.ENOSYS)
            return -1

    assert apply_landlock_worker_confinement(str(tmp_path), native_lib=EnosysLib()) == "unsupported"

    # 2. Hyper-V / Firecracker Landlock ABI v3 -> enforces ruleset excluding /app and /opt/venv.
    opened_paths: list[str] = []
    closed_fds: list[int] = []
    syscalls: list[int] = []
    fd_counter = 100

    def fake_exists(path: str) -> bool:
        return True

    def fake_open(path: str, _flags: int) -> int:
        nonlocal fd_counter
        fd_counter += 1
        opened_paths.append(path)
        return fd_counter

    def fake_close(fd: int) -> None:
        closed_fds.append(fd)

    monkeypatch.setattr(cw.os.path, "exists", fake_exists)
    monkeypatch.setattr(cw.os, "open", fake_open)
    monkeypatch.setattr(cw.os, "close", fake_close)

    class Abi3Lib:
        def syscall(self, nr: int, arg1: Any, arg2: Any, arg3: Any = 0, *_rest: Any) -> int:
            syscalls.append(nr)
            if nr == _SYS_LANDLOCK_CREATE_RULESET:
                if getattr(arg3, "value", arg3) == 1:
                    return 3  # ABI v3
                return 77  # ruleset_fd
            if nr == _SYS_LANDLOCK_ADD_RULE:
                return 0
            if nr == _SYS_LANDLOCK_RESTRICT_SELF:
                return 0
            raise AssertionError(f"unexpected syscall {nr}")

    outcome = apply_landlock_worker_confinement(str(tmp_path), native_lib=Abi3Lib())
    assert outcome == "enforced:abi3"
    assert "/opt/browser" in opened_paths
    assert str(tmp_path) in opened_paths
    assert "/app" not in opened_paths
    assert "/opt/venv" not in opened_paths
    assert "/opt/hushh" not in opened_paths
    assert 77 in closed_fds
    assert _SYS_LANDLOCK_RESTRICT_SELF in syscalls

    # 3. Negative control: restrict_self failure on a Landlock-capable kernel fails closed.
    class RestrictFailLib(Abi3Lib):
        def syscall(self, nr: int, arg1: Any, arg2: Any, arg3: Any = 0, *_rest: Any) -> int:
            if nr == _SYS_LANDLOCK_RESTRICT_SELF:
                ctypes.set_errno(errno.EPERM)
                return -1
            return super().syscall(nr, arg1, arg2, arg3)

    with pytest.raises(LaunchRefused):
        apply_landlock_worker_confinement(str(tmp_path), native_lib=RestrictFailLib())


def test_user_aws_and_ace_compute_resolution_and_custody_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )
    ace = resolve_compute_backend("ace")
    assert isinstance(ace, AceComputeBackend)
    assert isinstance(ace, ComputeBackend)

    # Fleet-wide no-arg resolver continues to refuse user-owned AWS ("aws" / "user_aws").
    for unsupported in ("aws", "user_aws"):
        with pytest.raises(NotImplementedError):
            resolve_compute_backend(unsupported)

    # Incomplete user_aws coordinates fail closed on per-owner resolution and UserCloud gate.
    incomplete_spec = PodSpec(
        hushh_id="HA1AWS1",
        phone_e164_hash="h",
        pod_pubkey="pub",
        deployment_target=BACKEND_USER_AWS,
        user_cloud_account_id="123456789012",
        user_cloud_region="us-east-1",
    )
    with pytest.raises(ValueError, match="role_arn"):
        resolve_compute_backend_for_spec(incomplete_spec)

    cloud = UserCloud(
        deployment_target=BACKEND_USER_AWS,
        model_credential_mode=None,
        project=None,
        region="us-east-1",
        bootstrap_sa=None,
        authorized=True,
        account_id="123456789012",
        role_arn="arn:aws:iam::123456789012:role/hussh-pod",
    )
    assert cloud.is_user_owned
    assert not cloud.is_hosted
    assert cloud.is_ready_to_provision
    assert not cloud.blocks_provisioning
    assert owner_cloud_coordinates_complete(
        BACKEND_USER_AWS,
        {"account_id": "123456789012", "region": "us-east-1", "role_arn": cloud.role_arn},
    )

    complete_spec = PodSpec(
        hushh_id="HA1AWS1",
        phone_e164_hash="h",
        pod_pubkey="pub",
        deployment_target=BACKEND_USER_AWS,
        user_cloud_account_id="123456789012",
        user_cloud_region="us-east-1",
        user_cloud_role_arn="arn:aws:iam::123456789012:role/hussh-pod",
    )
    aws_backend = resolve_compute_backend_for_spec(complete_spec)
    assert isinstance(aws_backend, UserAwsBackend)
    assert effective_custody_mode(complete_spec) == CUSTODY_OWNER_KMS
    assert (
        effective_custody_mode(
            PodSpec(
                hushh_id="HA1ACE1",
                phone_e164_hash="h",
                pod_pubkey="pub",
                deployment_target=BACKEND_ACE,
            )
        )
        == CUSTODY_ACE_ENVELOPE
    )

    with pytest.raises(ValueError, match="fleet_hkdf"):
        PodSpec(
            hushh_id="HA1AWS1",
            phone_e164_hash="h",
            pod_pubkey="pub",
            deployment_target=BACKEND_USER_AWS,
            custody_mode=CUSTODY_FLEET_HKDF,
        )
    with pytest.raises(ValueError, match="owner_vault"):
        PodSpec(
            hushh_id="HA1AWS1",
            phone_e164_hash="h",
            pod_pubkey="pub",
            deployment_target=BACKEND_USER_AWS,
            custody_mode=CUSTODY_OWNER_VAULT,
        )


def test_aws_kms_custody_adapter_cas_aad_and_tombstone_protection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    store = LocalObjectStore(str(tmp_path))

    class FakeKmsClient:
        def encrypt(
            self, *, KeyId: str, Plaintext: bytes, EncryptionContext: dict[str, str]
        ) -> dict[str, bytes]:
            aad = f"{KeyId}|{EncryptionContext['hushh_id']}|{EncryptionContext['custody_mode']}".encode()
            return {"CiphertextBlob": aad + b"::" + Plaintext}

        def decrypt(
            self, *, CiphertextBlob: bytes, KeyId: str, EncryptionContext: dict[str, str]
        ) -> dict[str, bytes]:
            expected = f"{KeyId}|{EncryptionContext['hushh_id']}|{EncryptionContext['custody_mode']}".encode()
            prefix, sep, raw = CiphertextBlob.partition(b"::")
            if not sep or prefix != expected:
                raise RuntimeError("InvalidCiphertextException")
            return {"Plaintext": raw}

    arn = "arn:aws:kms:us-east-1:123456789012:key/11112222-3333-4444-5555-666677778888"
    monkeypatch.setenv(AWS_KMS_KEY_ENV, arn)
    monkeypatch.setenv("HUSSH_ID", "owner-aws-1")
    kms = FakeKmsClient()
    port = resolve_key_custody_port(store=store, kms_client=kms)
    assert isinstance(port, AwsKmsCustodyAdapter)

    dek_first = port.resolve_log_key()
    dek_second = port.resolve_log_key()
    assert len(dek_first) == 32
    assert dek_first == dek_second

    # Wrong owner AAD fails closed rather than minting a substitute DEK.
    wrong_owner = AwsKmsCustodyAdapter(
        kms_client=kms,
        store=store,
        key_arn=arn,
        hushh_id="different-owner",
    )
    with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
        wrong_owner.resolve_log_key()

    # Crypto-erase tombstone blocks minting a replacement key in a fresh prefix.
    erased_store = LocalObjectStore(str(tmp_path / "erased"))
    erased_store.put_if_generation_blocking(ERASURE_TOMBSTONE_OBJECT, b"{}", ABSENT)
    erased_adapter = AwsKmsCustodyAdapter(
        kms_client=kms,
        store=erased_store,
        key_arn=arn,
        hushh_id="owner-aws-1",
    )
    with pytest.raises(ByocKeyCustodyError, match="erased"):
        erased_adapter.resolve_log_key()


@pytest.mark.asyncio
async def test_s3_and_prefix_token_object_stores_preserve_commit_log_cas() -> None:
    # 1. In-memory conditional S3 fake exercising IfNoneMatch="*" and IfMatch=<ETag>.
    class FakeS3Error(Exception):
        def __init__(self, code: str, status: int) -> None:
            super().__init__(code)
            self.response = {
                "Error": {"Code": code},
                "ResponseMetadata": {"HTTPStatusCode": status},
            }

    class FakeS3Client:
        def __init__(self) -> None:
            self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
            self.denied = False
            self.seq = 0

        def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
            if self.denied:
                raise FakeS3Error("AccessDenied", 403)
            item = self.objects.get((Bucket, Key))
            if item is None:
                raise FakeS3Error("NoSuchKey", 404)
            data, etag = item
            return {"Body": SimpleNamespace(read=lambda: data), "ETag": etag}

        def put_object(self, **kwargs: Any) -> dict[str, Any]:
            if self.denied:
                raise FakeS3Error("AccessDenied", 403)
            key = (kwargs["Bucket"], kwargs["Key"])
            current = self.objects.get(key)
            if kwargs.get("IfNoneMatch") == "*" and current is not None:
                raise FakeS3Error("PreconditionFailed", 412)
            if "IfMatch" in kwargs:
                if current is None or current[1] != kwargs["IfMatch"]:
                    raise FakeS3Error("PreconditionFailed", 412)
            self.seq += 1
            etag = f'"etag-{self.seq}"'
            self.objects[key] = (bytes(kwargs["Body"]), etag)
            return {"ETag": etag}

        def delete_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
            if self.denied:
                raise FakeS3Error("AccessDenied", 403)
            self.objects.pop((Bucket, Key), None)
            return {}

    fake_s3 = FakeS3Client()
    s3_store = S3ObjectStore("s3://hussh-one-aws-bucket/pod", s3_client=fake_s3)
    log = PodCommitLog(s3_store, b"K" * 32, owner_id="owner-aws")
    await log.append("note", {"step": 1})
    await log.append("note", {"step": 2})
    records = await log.replay()
    assert [r["payload"]["step"] for r in records] == [1, 2]
    assert s3_store.put_if_generation_blocking("head.json", b"stale", ABSENT) is None

    # 403 AccessDenied must raise PodMultiCloudStorageForbidden, NEVER masquerade as absence.
    fake_s3.denied = True
    with pytest.raises(PodMultiCloudStorageForbidden):
        s3_store.get_with_generation_blocking("head.json")

    # 2. PrefixTokenObjectStore for zero-SA ACE cells.
    class FakeHttpSession:
        def __init__(self) -> None:
            self.objects: dict[str, tuple[bytes, str]] = {}
            self.seq = 0

        def _resp(
            self, status: int, content: bytes = b"", headers: dict[str, str] | None = None
        ) -> Any:
            return SimpleNamespace(
                status_code=status,
                content=content,
                headers=headers or {},
                close=lambda: None,
            )

        def get(self, url: str, *, headers: dict[str, str], **_kw: Any) -> Any:
            if headers.get("Authorization") != "Bearer cell-token-1":
                return self._resp(403)
            item = self.objects.get(url)
            if item is None:
                return self._resp(404)
            return self._resp(200, item[0], {"ETag": item[1]})

        def put(self, url: str, *, headers: dict[str, str], data: bytes, **_kw: Any) -> Any:
            if headers.get("Authorization") != "Bearer cell-token-1":
                return self._resp(403)
            current = self.objects.get(url)
            if headers.get("If-None-Match") == "*" and current is not None:
                return self._resp(412)
            if "If-Match" in headers and (current is None or current[1] != headers["If-Match"]):
                return self._resp(412)
            self.seq += 1
            etag = f'"ace-etag-{self.seq}"'
            self.objects[url] = (bytes(data), etag)
            return self._resp(201, b"", {"ETag": etag})

        def delete(self, url: str, *, headers: dict[str, str], **_kw: Any) -> Any:
            if headers.get("Authorization") != "Bearer cell-token-1":
                return self._resp(403)
            if url not in self.objects:
                return self._resp(404)
            self.objects.pop(url)
            return self._resp(204)

    synthetic_auth_value = "cell-token-1"  # noqa: S105 - synthetic test fixture
    ace_store = PrefixTokenObjectStore(
        "https://storage-cell.internal.hushh.ai/v1/cells/dev/pods/HA1ACE1",
        bearer_token=synthetic_auth_value,
        session=FakeHttpSession(),
    )
    ace_log = PodCommitLog(ace_store, b"M" * 32, owner_id="owner-ace")
    await ace_log.append("memory", {"fact": "zero-iam-sa"})
    replayed = await ace_log.replay()
    assert len(replayed) == 1 and replayed[0]["payload"]["fact"] == "zero-iam-sa"


def test_platform_detection_metadata_isolation_and_azure_ace_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import x25519

    from hushh_mcp.services.pod_browser.azure_delivery import browser_queue_url
    from hushh_mcp.services.pod_custody_port import ACE_SEAL_SCALAR_ENV, _b64url_encode

    # AWS platform refuses GCE metadata token access and exposes ECS task coordinates.
    for key in ("K_SERVICE", "K_REVISION", "CONTAINER_APP_NAME", "ACE_SANDBOX_ID"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ECS_CONTAINER_METADATA_URI_V4", "http://169.254.170.2/v4/task")
    monkeypatch.setenv("HUSSH_AWS_SERVICE_NAME", "hussh-one-aws")
    monkeypatch.setenv("HUSSH_AWS_TASK_REVISION", "rev-7")
    assert workload_platform() == "aws"
    assert (pod_service_name(), pod_revision_name()) == ("hussh-one-aws", "rev-7")
    with pytest.raises(PodWorkloadIdentityUnavailable):
        google_metadata_access_endpoint()

    # Owner-cloud XOR recognizes AWS KMS key ARN and refuses contradictory pairs.
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.setenv("HUSSH_POD_AWS_KMS_KEY_ARN", "arn:aws:kms:us-east-1:123456789012:key/k1")
    assert owner_cloud_provider() == "user_aws"
    monkeypatch.setenv("HUSSH_POD_KEY_VAULT_KEY", "https://kv.vault.azure.net/keys/k/1")
    assert owner_cloud_provider() is None

    # Azure browser delivery works with cloud-agnostic ACE custody when Key Vault env is absent.
    monkeypatch.delenv("ECS_CONTAINER_METADATA_URI_V4", raising=False)
    monkeypatch.delenv("HUSSH_POD_AWS_KMS_KEY_ARN", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.setenv("CONTAINER_APP_NAME", "pod-az")
    monkeypatch.setenv("CONTAINER_APP_REVISION", "pod-az--001")
    monkeypatch.setenv("POD_BROWSER_DELIVERY_MODE", "owner_files_queue_v1")
    monkeypatch.setenv("POD_FILES_ENABLED", "true")
    monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", "https://acct123.blob.core.windows.net/pod")
    monkeypatch.setenv(
        "POD_FILES_AZURE_QUEUE_URL",
        "https://acct123.queue.core.windows.net/files-organization",
    )
    with pytest.raises(BrowserRefused):
        browser_queue_url()

    scalar = x25519.X25519PrivateKey.generate().private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    monkeypatch.setenv(ACE_SEAL_SCALAR_ENV, _b64url_encode(scalar))
    assert browser_queue_url() == "https://acct123.queue.core.windows.net/files-organization"
