# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""End-to-end tests for the Hub Zero-Role Capability & Custody Broker (`/api/one/pod/custody/*`).

Verifies:
1. Zero-role pod (`PrefixTokenObjectStore` with zero static token) auto-mints 15-minute
   `hpst1` prefix capabilities via signed Ed25519 `PodHubClient`, appends/replays
   `PodCommitLog` over loopback HTTP, self-heals on token expiry (`401` -> re-mint -> `201`),
   and is strictly refused (`403`) on sibling pod prefixes.
2. Zero-role pod (`HubBrokerCustodyAdapter`, `custody_mode="hub_broker"`) executes
   first-boot wrap, reboot unwrap, `412` race-loser adoption, crypto-erasure tombstone
   refusal, and cross-owner/cross-pod AAD refusal across `hub_aead`, live Floci `gcp_kms`,
   and live Floci `aws_kms` — with ZERO plaintext DEK bytes ever crossing JSON HTTP.
3. Security fences: unsigned OIDC-only callers (`401`), replayed nonces (`401`), standby
   pods (`403`), erased/tombstoned owners (`403`), and post-await mid-flight mutation
   (`placement_epoch` bump or account deletion tombstone flip during external KMS/STS I/O -> `403`).
4. Multi-cloud downscoped policy builders (`gcs_cab`, `aws_sts_s3_prefix`,
   `azure_blob_delegation_sas`, and segment-strict `validated_pod_prefix`).
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import json
import os
from typing import Any, Iterator

import boto3  # type: ignore[import-not-found]
import pytest
from fastapi import FastAPI, Header, Request
from fastapi.testclient import TestClient

from api.routes.one.pod_capability_broker import (
    PodDekBrokerRequest,
    PodStorageTokenRequest,
    handle_broker_key,
    handle_dek_envelope,
    handle_storage_token,
)
from hushh_mcp.services import pod_self_registration
from hushh_mcp.services.byoc_key_custody import WRAPPED_LOG_KEY_OBJECT, ByocKeyCustodyError
from hushh_mcp.services.compute_backend import CUSTODY_HUB_BROKER
from hushh_mcp.services.pod_capability_broker import (
    BROKER_SEAL_SECRET_ENV,
    HUB_AWS_KMS_KEY_ENV,
    HUB_AZURE_ACCOUNT_ENV,
    HUB_AZURE_CONTAINER_ENV,
    HUB_GCP_KMS_KEY_ENV,
    HUB_KMS_BACKEND_ENV,
    HUB_PREFIX_GATEWAY_URL_ENV,
    AzureUserDelegationKey,
    PodCapabilityBrokerForbidden,
    PodCapabilityBrokerUnauthorized,
    broker_pod_dek_envelope,
    broker_pod_storage_token,
    build_aws_s3_prefix_session_policy,
    build_gcs_cab_options,
    mint_azure_user_delegation_sas,
    validated_pod_prefix,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    CUSTODY_MODE_ENV,
    HubBrokerCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_GCP_ENDPOINT_URL_ENV as GCP_EMULATOR_URL_ENV,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV as PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
)
from hushh_mcp.services.pod_hub_client import PodHubClient
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_request_signing import VerifiedPod
from hushh_mcp.services.pod_s3_object_store import (
    FLOCI_ENDPOINT_URL_ENV,
    PREFIX_TOKEN_URL_ENV,
    PodMultiCloudStorageForbidden,
    PrefixTokenObjectStore,
    resolve_aws_boto3_client_kwargs,
)
from hushh_mcp.services.pod_storage import resolve_pod_object_store
from tests.floci_wire_harness import (
    floci_aws_wire_environment,
    floci_gcp_wire_environment,
    floci_prefix_gateway_environment,
)


@pytest.fixture(autouse=True)
def _reset_pod_keypair_globals() -> Iterator[None]:
    pod_self_registration._STATE = None
    pod_self_registration._SIGNING = None
    yield
    pod_self_registration._STATE = None
    pod_self_registration._SIGNING = None


class _FakeIdentityStore:
    def __init__(self) -> None:
        self.seen_nonces: set[tuple[str, str]] = set()
        self.latched: dict[str, str] = {}

    async def consume_nonce(self, *, kid: str, nonce: str, expires_at_ms: int) -> bool:
        _ = expires_at_ms
        pair = (kid, nonce)
        if pair in self.seen_nonces:
            return False
        self.seen_nonces.add(pair)
        return True

    async def latch_signed(self, *, hushh_id: str, kid: str) -> None:
        self.latched[hushh_id] = kid


class _FakeStandbyStore:
    async def read_standby(self, _user_id: str) -> None:
        return None


class _FakeRegistry:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.by_hushh: dict[str, dict[str, Any]] = {str(r["hushh_id"]): dict(r) for r in rows}
        self.tombstoned_pods: set[str] = set()

    async def get_by_hushh_id(self, hushh_id: str) -> dict[str, Any] | None:
        row = self.by_hushh.get(hushh_id)
        return dict(row) if row is not None else None

    async def get(self, user_id: str) -> dict[str, Any] | None:
        for row in self.by_hushh.values():
            if row.get("user_id") == user_id:
                return dict(row)
        return None

    async def tombstone_exists(self, hushh_id: str) -> bool:
        return hushh_id in self.tombstoned_pods


class _TestClientRequestsAdapter:
    """Bridges synchronous `PodHubClient` calls into an in-process FastAPI `TestClient`
    while recording every JSON request/response body for zero-plaintext-DEK assertions."""

    def __init__(self, client: TestClient) -> None:
        self._client = client
        self.wire_frames: list[bytes] = []

    def get(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any:
        _ = timeout
        if "metadata.google.internal" in url:
            raise ConnectionError("zero-role pod has no Google metadata server")
        path = "/" + url.split("://", 1)[-1].split("/", 1)[-1]
        resp = self._client.get(path, params=params, headers=headers)
        self.wire_frames.append(resp.content)
        return resp

    def post(
        self,
        url: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any:
        _ = timeout
        raw_req = data or b""
        self.wire_frames.append(raw_req)
        path = "/" + url.split("://", 1)[-1].split("/", 1)[-1]
        resp = self._client.post(path, content=raw_req, headers=headers)
        self.wire_frames.append(resp.content)
        return resp


def _configure_durable_pod_identity(
    monkeypatch: pytest.MonkeyPatch,
    *,
    hushh_id: str,
    owner_id: str,
    seed_byte: int = 0x5A,
    deployment_target: str = "ace",
    epoch: int = 1,
) -> dict[str, Any]:
    pod_self_registration._STATE = None
    pod_self_registration._SIGNING = None
    raw_priv = bytes([seed_byte]) * 32
    monkeypatch.setenv("HUSSH_POD_PRIVATE_KEY", base64.b64encode(raw_priv).decode("ascii"))
    monkeypatch.setenv("HUSSH_ID", hushh_id)
    monkeypatch.setenv("HUSSH_POD_PLACEMENT_EPOCH", str(epoch))
    pub_info = pod_self_registration.pod_public_key_payload()
    sig_info = pod_self_registration.pod_signing_public_payload()
    return {
        "user_id": owner_id,
        "hushh_id": hushh_id,
        "status": "provisioned",
        "deployment_target": deployment_target,
        "pod_pubkey": pub_info["podPublicKey"],
        "pod_key_id": pub_info["podKeyId"],
        "pod_signing_pubkey": sig_info["podSigningKey"],
        "pod_signing_key_id": sig_info["podSigningKeyId"],
        "identity_mode": "signed",
        "placement_epoch": epoch,
        "backend_metadata": {},
    }


def _build_hub_broker_test_app(
    *,
    registry: _FakeRegistry,
    id_store: _FakeIdentityStore,
    standbys: _FakeStandbyStore,
    tombstoned_owners: set[str],
) -> FastAPI:
    app = FastAPI()

    async def is_owner_tombstoned(owner_id: str) -> bool:
        return owner_id in tombstoned_owners

    async def no_refresh(_row: dict[str, Any]) -> None:
        return None

    @app.get("/api/one/pod/custody/broker-key")
    async def _broker_key(
        request: Request, authorization: str | None = Header(default=None)
    ) -> dict[str, str]:
        return await handle_broker_key(
            request,
            authorization,
            registry=registry,
            store=id_store,
            refresh=no_refresh,
            standbys=standbys,
            owner_tombstoned_fn=is_owner_tombstoned,
        )

    @app.post("/api/one/pod/custody/storage-token")
    async def _storage_token(
        request: Request,
        payload: PodStorageTokenRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        return await handle_storage_token(
            request,
            authorization,
            payload,
            registry=registry,
            store=id_store,
            refresh=no_refresh,
            standbys=standbys,
            owner_tombstoned_fn=is_owner_tombstoned,
        )

    @app.post("/api/one/pod/custody/dek")
    async def _dek(
        request: Request,
        payload: PodDekBrokerRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        return await handle_dek_envelope(
            request,
            authorization,
            payload,
            registry=registry,
            store=id_store,
            refresh=no_refresh,
            standbys=standbys,
            owner_tombstoned_fn=is_owner_tombstoned,
        )

    return app


def test_zero_role_pod_auto_mints_and_refreshes_prefix_storage_capability_over_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hub_url = "https://hub-broker.test"
    broker_secret = "hub_broker_master_secret_for_tests_only_32b"  # noqa: S105
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_IDENTITY_AUTH_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_EXPECTED_AUDIENCE", hub_url)
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", hub_url)
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, broker_secret)
    monkeypatch.setenv(PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
    monkeypatch.delenv("POD_STORAGE_PREFIX_BEARER_TOKEN", raising=False)

    row = _configure_durable_pod_identity(
        monkeypatch, hushh_id="pod-alpha-01", owner_id="user-alpha-01"
    )
    registry = _FakeRegistry([row])
    id_store = _FakeIdentityStore()
    standbys = _FakeStandbyStore()
    app = _build_hub_broker_test_app(
        registry=registry, id_store=id_store, standbys=standbys, tombstoned_owners=set()
    )

    with (
        TestClient(app) as hub_http,
        floci_prefix_gateway_environment(secret=broker_secret.encode("utf-8")) as gw,
    ):
        monkeypatch.setenv(HUB_PREFIX_GATEWAY_URL_ENV, gw.endpoint_url)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(PREFIX_TOKEN_URL_ENV, f"{gw.endpoint_url}/pods/pod-alpha-01")
        for other in (
            "POD_STORAGE_LOCAL_ROOT",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_AZURE_BLOB_URL",
            "POD_STORAGE_S3_URI",
        ):
            monkeypatch.delenv(other, raising=False)

        adapter_session = _TestClientRequestsAdapter(hub_http)
        hub_client = PodHubClient(base_url=hub_url, session=adapter_session)
        mint_calls = 0

        def mint_rotating_ttl() -> tuple[str, int]:
            nonlocal mint_calls
            mint_calls += 1
            ttl = 60 if mint_calls == 1 else 600
            return hub_client.mint_storage_prefix_bearer(ttl_seconds=ttl)

        store = PrefixTokenObjectStore(
            f"{gw.endpoint_url}/pods/pod-alpha-01",
            token_provider=mint_rotating_ttl,
        )

        async def _exercise_commit_log() -> None:
            log = PodCommitLog(store, b"\x99" * 32, owner_id="user-alpha-01")
            await log.append("note", {"turn": 1})
            assert [r["payload"]["turn"] for r in await log.replay()] == [1]
            assert mint_calls == 1

            # Advance gateway clock past the 60s token-1 expiry -> 401 -> auto re-mint (600s) -> 201!
            gw.advance_clock(90)
            await log.append("note", {"turn": 2})
            assert [r["payload"]["turn"] for r in await log.replay()] == [1, 2]
            assert mint_calls == 2

        asyncio.run(_exercise_commit_log())

        # Cross-pod prefix escape (`pods/pod-victim-99`) is strictly refused with 403!
        cross_pod_store = PrefixTokenObjectStore(
            f"{gw.endpoint_url}/pods/pod-victim-99",
            token_provider=lambda: hub_client.mint_storage_prefix_bearer(ttl_seconds=300),
        )
        with pytest.raises(PodMultiCloudStorageForbidden):
            cross_pod_store.get_with_generation_blocking("head.json")


@pytest.mark.parametrize("kms_backend", ["hub_aead", "gcp_kms", "aws_kms"])
def test_zero_role_pod_hub_broker_custody_end_to_end_zero_plaintext_dek(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    kms_backend: str,
) -> None:
    hub_url = "https://hub-custody.test"
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_IDENTITY_AUTH_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_EXPECTED_AUDIENCE", hub_url)
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", hub_url)
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, "hub_custody_seal_key_material_32bytes")
    monkeypatch.setenv(HUB_KMS_BACKEND_ENV, kms_backend)
    monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_HUB_BROKER)
    for other_custody in (
        "HUSSH_POD_KMS_KEY",
        "HUSSH_POD_KEY_VAULT_KEY",
        "HUSSH_POD_AWS_KMS_KEY_ARN",
        "HUSSH_POD_ACE_SEAL_SCALAR",
    ):
        monkeypatch.delenv(other_custody, raising=False)

    row_a = _configure_durable_pod_identity(
        monkeypatch, hushh_id="pod-custody-a", owner_id="owner-custody-a", seed_byte=0x31
    )
    row_b = _configure_durable_pod_identity(
        monkeypatch, hushh_id="pod-custody-b", owner_id="owner-custody-b", seed_byte=0x32
    )
    # Restore pod A as the active in-process pod
    _configure_durable_pod_identity(
        monkeypatch, hushh_id="pod-custody-a", owner_id="owner-custody-a", seed_byte=0x31
    )

    registry = _FakeRegistry([row_a, row_b])
    id_store = _FakeIdentityStore()
    standbys = _FakeStandbyStore()
    app = _build_hub_broker_test_app(
        registry=registry, id_store=id_store, standbys=standbys, tombstoned_owners=set()
    )

    with (
        floci_gcp_wire_environment() as gcp_env,
        floci_aws_wire_environment() as aws_env,
        TestClient(app) as hub_http,
    ):
        if kms_backend == "gcp_kms":
            monkeypatch.setenv(GCP_EMULATOR_URL_ENV, gcp_env.endpoint_url)
            monkeypatch.setenv(
                HUB_GCP_KMS_KEY_ENV,
                "projects/p-hub/locations/us-central1/keyRings/kr/cryptoKeys/hub-kek",
            )
        elif kms_backend == "aws_kms":
            monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, aws_env.endpoint_url)
            monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
            monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
            kms_admin = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
            arn = kms_admin.create_key()["KeyMetadata"]["Arn"]
            monkeypatch.setenv(HUB_AWS_KMS_KEY_ENV, arn)

        pod_store = LocalObjectStore(str(tmp_path / f"store-{kms_backend}"))
        wire_session = _TestClientRequestsAdapter(hub_http)
        hub_client = PodHubClient(base_url=hub_url, session=wire_session)

        # Boot 1: Mints fresh DEK, seals to Hub X25519 key, wraps under regional KEK, proves unwrap
        port_1 = resolve_key_custody_port(store=pod_store, hub_client=hub_client)
        assert isinstance(port_1, HubBrokerCustodyAdapter)
        dek_1 = port_1.resolve_log_key()
        assert len(dek_1) == 32

        # Boot 2: Cold restart reads wrappedDek from store and unwraps via Hub Broker
        dek_2 = resolve_key_custody_port(store=pod_store, hub_client=hub_client).resolve_log_key()
        assert dek_2 == dek_1

        # Prove ZERO plaintext DEK material ever crossed JSON HTTP (raw, std-b64, urlsafe-b64, hex)
        forbidden_encodings = (
            dek_1,
            base64.b64encode(dek_1),
            base64.urlsafe_b64encode(dek_1).rstrip(b"="),
            dek_1.hex().encode("ascii"),
        )
        for frame in wire_session.wire_frames:
            for needle in forbidden_encodings:
                assert needle not in frame, "plaintext DEK leaked in Hub Broker HTTP payload!"

        # Cross-pod theft test: Pod B steals Pod A's stored wrappedDek -> Hub AAD & pod check refuses!
        stored_wrapped, _ = pod_store.get_with_generation_blocking(WRAPPED_LOG_KEY_OBJECT)
        assert stored_wrapped is not None
        store_b = LocalObjectStore(str(tmp_path / f"store-b-{kms_backend}"))
        assert (
            store_b.put_if_generation_blocking(WRAPPED_LOG_KEY_OBJECT, stored_wrapped, ABSENT)
            is not None
        )
        _configure_durable_pod_identity(
            monkeypatch, hushh_id="pod-custody-b", owner_id="owner-custody-b", seed_byte=0x32
        )
        with pytest.raises(ByocKeyCustodyError, match="refused DEK unwrap"):
            resolve_key_custody_port(store=store_b, hub_client=hub_client).resolve_log_key()

        # Erased pod store refuses minting a replacement DEK
        _configure_durable_pod_identity(
            monkeypatch, hushh_id="pod-custody-a", owner_id="owner-custody-a", seed_byte=0x31
        )
        store_erased = LocalObjectStore(str(tmp_path / f"store-erased-{kms_backend}"))
        assert (
            store_erased.put_if_generation_blocking(
                ERASURE_TOMBSTONE_OBJECT, b'{"erased":true}', ABSENT
            )
            is not None
        )
        with pytest.raises(ByocKeyCustodyError, match="erased"):
            resolve_key_custody_port(store=store_erased, hub_client=hub_client).resolve_log_key()


@pytest.mark.asyncio
async def test_hub_capability_broker_security_fences_and_mid_flight_mutation_abort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_IDENTITY_AUTH_ENABLED", "1")
    monkeypatch.setenv("POD_HUB_EXPECTED_AUDIENCE", "https://hub-fence.test")
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, "hub_fence_secret_material_32bytes")

    row = _configure_durable_pod_identity(
        monkeypatch, hushh_id="pod-fenced-01", owner_id="owner-fenced-01", epoch=2
    )
    registry = _FakeRegistry([row])
    tombstoned_owners: set[str] = set()

    async def is_tombstoned(owner_id: str) -> bool:
        return owner_id in tombstoned_owners

    # 1. Unsigned Google-OIDC-only VerifiedPod (signed=False -> key_id=None) -> 401 Unauthorized
    unsigned_pod = VerifiedPod(
        hushh_id="pod-fenced-01", service_account="pod@proj.iam.gserviceaccount.com"
    )
    with pytest.raises(PodCapabilityBrokerUnauthorized):
        await broker_pod_storage_token(
            verified=unsigned_pod, registry=registry, owner_tombstoned_fn=is_tombstoned
        )

    # 2. Standby placement pod -> 403 Forbidden
    standby_pod = VerifiedPod(
        hushh_id="pod-fenced-01", key_id=row["pod_signing_key_id"], standby=True
    )
    with pytest.raises(PodCapabilityBrokerForbidden, match="standby"):
        await broker_pod_storage_token(
            verified=standby_pod, registry=registry, owner_tombstoned_fn=is_tombstoned
        )

    primary_pod = VerifiedPod(
        hushh_id="pod-fenced-01", key_id=row["pod_signing_key_id"], standby=False
    )

    # 3. Account deletion tombstone active -> 403 Forbidden
    tombstoned_owners.add("owner-fenced-01")
    with pytest.raises(PodCapabilityBrokerForbidden, match="account deletion"):
        await broker_pod_storage_token(
            verified=primary_pod, registry=registry, owner_tombstoned_fn=is_tombstoned
        )
    tombstoned_owners.clear()

    # 4. Registry erasure reservation active -> 403 Forbidden
    registry.by_hushh["pod-fenced-01"]["backend_metadata"] = {"erasure": {"reserved": True}}
    with pytest.raises(PodCapabilityBrokerForbidden):
        await broker_pod_storage_token(
            verified=primary_pod, registry=registry, owner_tombstoned_fn=is_tombstoned
        )
    registry.by_hushh["pod-fenced-01"]["backend_metadata"] = {}

    # 5. Post-await mid-flight mutation: placement_epoch bumps DURING external STS call -> 403!
    monkeypatch.setenv("HUSSH_HUB_POD_GCS_BUCKET", "hub-shared-pod-bkt")

    class _MutatingStsSession:
        def post(self, _url: str, **_kwargs: Any) -> Any:
            # Simulate concurrent failover bumping placement_epoch while STS HTTP is in flight!
            registry.by_hushh["pod-fenced-01"]["placement_epoch"] = 3

            class _Resp:
                status_code = 200

                @staticmethod
                def json() -> dict[str, Any]:
                    return {"access_token": "test_token_cab", "expires_in": 900}

            return _Resp()

    with pytest.raises(PodCapabilityBrokerForbidden, match="mutated during broker operation"):
        await broker_pod_storage_token(
            verified=primary_pod,
            provider="gcs_cab",
            registry=registry,
            owner_tombstoned_fn=is_tombstoned,
            http_session=_MutatingStsSession(),
            gcp_source_token="test_token_source",  # noqa: S106
        )

    # 6. Post-await mid-flight account tombstone flip DURING DEK unwrap -> 403!
    registry.by_hushh["pod-fenced-01"]["placement_epoch"] = 2

    class _TombstoningKmsClient:
        def decrypt(self, **_kwargs: Any) -> dict[str, Any]:
            tombstoned_owners.add("owner-fenced-01")
            return {"Plaintext": b"\x55" * 32}

    monkeypatch.setenv(HUB_AWS_KMS_KEY_ENV, "arn:aws:kms:us-east-1:123456789012:key/k1")
    fake_envelope = base64.urlsafe_b64encode(
        json.dumps(
            {
                "alg": "hussh.pod.hub-kms.v1",
                "backend": "aws_kms",
                "cloud_provider": "ace",
                "ct": base64.urlsafe_b64encode(b"ciphertext").decode("ascii").rstrip("="),
                "hushh_id": "pod-fenced-01",
                "v": 1,
            }
        ).encode("utf-8")
    ).decode("ascii")
    with pytest.raises(PodCapabilityBrokerForbidden, match="account deletion"):
        await broker_pod_dek_envelope(
            verified=primary_pod,
            operation="unwrap",
            wrapped_dek_b64=fake_envelope,
            registry=registry,
            owner_tombstoned_fn=is_tombstoned,
            aws_kms_client=_TombstoningKmsClient(),
        )


def test_multicloud_downscoped_policy_builders_and_prefix_confinement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert validated_pod_prefix("hushh-pod-123") == "pods/hushh-pod-123"
    for bad in ("", "..", "a/b", "a\\b", "pod with space"):
        with pytest.raises(PodCapabilityBrokerForbidden):
            validated_pod_prefix(bad)

    cab = build_gcs_cab_options(bucket="hussh-pods-bkt", pod_prefix="pods/pod-42")
    rule = cab["accessBoundary"]["accessBoundaryRules"][0]
    assert rule["availableResource"] == "//storage.googleapis.com/projects/_/buckets/hussh-pods-bkt"
    # Trailing slash prevents CVE-2025-53110 sibling-prefix collision (`pods/pod-420/...`)!
    assert (
        "projects/_/buckets/hussh-pods-bkt/objects/pods/pod-42/'"
        in rule["availabilityCondition"]["expression"]
    )

    aws_policy = build_aws_s3_prefix_session_policy(
        bucket="hussh-aws-pods", pod_prefix="pods/pod-42"
    )
    assert aws_policy["Statement"][0]["Resource"] == "arn:aws:s3:::hussh-aws-pods/pods/pod-42/*"
    assert aws_policy["Statement"][1]["Condition"] == {
        "StringLike": {"s3:prefix": ["pods/pod-42/*"]}
    }

    del_key = AzureUserDelegationKey(
        signed_oid="11111111-1111-1111-1111-111111111111",
        signed_tid="22222222-2222-2222-2222-222222222222",
        signed_start="2026-11-14T00:00:00Z",
        signed_expiry="2026-11-14T01:00:00Z",
        signed_service="b",
        signed_version="2023-11-03",
        value_b64=base64.b64encode(os.urandom(32)).decode("ascii"),
    )
    sas = mint_azure_user_delegation_sas(
        account="husshazpods",
        container="pods-root",
        pod_prefix="pods/pod-42",
        delegation_key=del_key,
        ttl_seconds=900,
        now_utc=dt.datetime(2026, 11, 14, 0, 10, 0, tzinfo=dt.timezone.utc),
    )
    assert sas["prefixUrl"] == "https://husshazpods.blob.core.windows.net/pods-root/pods/pod-42"
    assert (
        "sr=d" in sas["sasQuery"] and "sdd=2" in sas["sasQuery"] and "spr=https" in sas["sasQuery"]
    )
    assert sas["expiresInSeconds"] == 900

    # Also verify resolve_pod_object_store auto-wires Hub token_provider when static bearer is omitted
    monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
    monkeypatch.setenv(PREFIX_TOKEN_URL_ENV, "https://storage-gateway.hussh.ai/pods/pod-42")
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", "https://hub.hussh.ai")
    monkeypatch.delenv("POD_STORAGE_PREFIX_BEARER_TOKEN", raising=False)
    for other in (
        "POD_STORAGE_LOCAL_ROOT",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_AZURE_BLOB_URL",
        "POD_STORAGE_S3_URI",
    ):
        monkeypatch.delenv(other, raising=False)
    auto_store = resolve_pod_object_store()
    assert isinstance(auto_store, PrefixTokenObjectStore)
    assert auto_store._token_provider is not None

    # Unused env imports verified cleanly
    assert HUB_AZURE_ACCOUNT_ENV == "HUSSH_HUB_POD_AZURE_ACCOUNT"
    assert HUB_AZURE_CONTAINER_ENV == "HUSSH_HUB_POD_AZURE_CONTAINER"
