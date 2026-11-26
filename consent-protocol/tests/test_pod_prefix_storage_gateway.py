# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract tests for the zero-role Hub Prefix Storage Gateway (#9744)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one.pod_prefix_storage_gateway import (
    router as gateway_router,
)
from api.routes.one.pod_prefix_storage_gateway import (
    set_storage_gateway_overrides_for_tests,
)
from hushh_mcp.services.pod_capability_broker import (
    BROKER_SEAL_SECRET_ENV,
    mint_prefix_gateway_token,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV as PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_s3_object_store import (
    PodMultiCloudStorageError,
    PodMultiCloudStorageForbidden,
    PrefixTokenObjectStore,
)


class _FakeRegistry:
    def __init__(self, row: dict[str, Any], *, tombstoned: set[str] | None = None) -> None:
        self.row = dict(row)
        self.tombstoned = set(tombstoned or set())

    async def get_by_hushh_id(self, hushh_id: str) -> dict[str, Any] | None:
        if self.row.get("hushh_id") == hushh_id:
            return dict(self.row)
        return None

    async def tombstone_exists(self, owner_id: str) -> bool:
        return owner_id in self.tombstoned


class _TestClientRequestsAdapter:
    """Map requests.Session calls from PrefixTokenObjectStore onto FastAPI TestClient."""

    def __init__(self, client: TestClient) -> None:
        self._client = client

    def _call(self, method: str, url: str, **kwargs: Any) -> Any:
        from urllib.parse import urlsplit

        parsed = urlsplit(url)
        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        kwargs.pop("allow_redirects", None)
        kwargs.pop("timeout", None)
        resp = self._client.request(method, target, **kwargs)

        class _Wrapped:
            def __init__(self, r: Any) -> None:
                self._r = r
                self.status_code = r.status_code
                self.headers = dict(r.headers)
                self.content = r.content

            def json(self) -> Any:
                return self._r.json()

            def close(self) -> None:
                return None

        return _Wrapped(resp)

    def get(self, url: str, **kwargs: Any) -> Any:
        return self._call("GET", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> Any:
        return self._call("PUT", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> Any:
        return self._call("DELETE", url, **kwargs)


async def test_prefix_storage_gateway_roundtrip_commit_log_and_fences(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    secret = "prefix_gateway_test_secret_material_32b"  # noqa: S105
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, secret)
    monkeypatch.setenv(PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")

    reg = _FakeRegistry(
        {
            "user_id": "owner-gw-01",
            "hushh_id": "ha1_gw_01",
            "placement_epoch": 1,
            "status": "provisioned",
            "backend_metadata": {},
        }
    )
    local_store = LocalObjectStore(tmp_path / "gw_store")
    set_storage_gateway_overrides_for_tests(
        store_factory=lambda: local_store,
        registry_factory=lambda: reg,
    )

    try:
        app = FastAPI()
        app.include_router(gateway_router)
        with TestClient(app) as http:
            adapter = _TestClientRequestsAdapter(http)
            base_url = "http://127.0.0.1:8080/api/one/pod/storage-gateway/pods/ha1_gw_01"

            def token_provider() -> tuple[str, int]:
                token, _claims = mint_prefix_gateway_token(
                    hushh_id="ha1_gw_01",
                    owner_id="owner-gw-01",
                    placement_epoch=1,
                    ttl_seconds=600,
                )
                return token, 600

            store = PrefixTokenObjectStore(base_url, token_provider=token_provider, session=adapter)
            log = PodCommitLog(store, b"\x42" * 32, owner_id="owner-gw-01")
            await log.append("chat_turn", {"seq": 1, "text": "hello gateway"})
            await log.append("chat_turn", {"seq": 2, "text": "persist me"})

            replayed = await log.replay()
            assert [item["payload"]["text"] for item in replayed] == ["hello gateway", "persist me"]

            # CAS conflict semantics match ObjectStore contract.
            ver1 = await store.put_if_generation("workspace/notes.txt", b"v1", ABSENT)
            assert ver1 is not None and ver1 != ABSENT
            assert await store.put_if_generation("workspace/notes.txt", b"v1b", ABSENT) is None
            assert await store.put_if_generation("workspace/notes.txt", b"stale", '"999"') is None
            ver2 = await store.put_if_generation("workspace/notes.txt", b"v2", ver1)
            assert ver2 is not None and ver2 != ver1

            listed, cursor = await store.list_page("workspace", limit=10)
            assert listed == ["workspace/notes.txt"]
            assert cursor == ""

            # Cross-pod escape is refused with 403.
            victim_store = PrefixTokenObjectStore(
                "http://127.0.0.1:8080/api/one/pod/storage-gateway/pods/ha1_victim",
                token_provider=token_provider,
                session=adapter,
            )
            with pytest.raises(PodMultiCloudStorageForbidden):
                await victim_store.get("head.json")

            assert await store.delete("workspace/notes.txt") is True
            assert await store.delete("workspace/notes.txt") is False

            # Bumping placement_epoch immediately fences the existing token with 403.
            reg.row["placement_epoch"] = 2
            with pytest.raises(PodMultiCloudStorageForbidden):
                await store.get("head.json")

            # Erasure tombstone also fences immediately even for the new epoch.
            reg.tombstoned.add("owner-gw-01")
            fresh_epoch_store = PrefixTokenObjectStore(
                base_url,
                token_provider=lambda: (
                    mint_prefix_gateway_token(
                        hushh_id="ha1_gw_01",
                        owner_id="owner-gw-01",
                        placement_epoch=2,
                        ttl_seconds=600,
                    )[0],
                    600,
                ),
                session=adapter,
            )
            with pytest.raises(PodMultiCloudStorageForbidden):
                await fresh_epoch_store.get("head.json")
    finally:
        set_storage_gateway_overrides_for_tests()


async def test_files_prefix_store_supports_subprefix_workspace_and_hub_broker_custody(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from hushh_mcp.services.pod_files import runtime as files_runtime
    from hushh_mcp.services.pod_files.library import FilesRefused
    from hushh_mcp.services.pod_files.storage import FilesPrefixStore

    secret = "prefix_gateway_test_secret_material_32b"  # noqa: S105
    base_url = "http://127.0.0.1:8080/api/one/pod/storage-gateway/pods/ha1_ws_01"
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-32-chars-minimum-01")
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, secret)
    monkeypatch.setenv(PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
    monkeypatch.setenv("POD_STORAGE_PREFIX_TOKEN_URL", base_url)
    monkeypatch.setenv("HUSSH_POD_CUSTODY_MODE", "hub_broker")

    backing = LocalObjectStore(tmp_path / "gw")
    reg = _FakeRegistry(
        {
            "user_id": "owner-ws-01",
            "hushh_id": "ha1_ws_01",
            "placement_epoch": 1,
            "status": "provisioned",
            "backend_metadata": {},
        }
    )
    set_storage_gateway_overrides_for_tests(
        store_factory=lambda: backing, registry_factory=lambda: reg
    )

    try:
        app = FastAPI()
        app.include_router(gateway_router)
        with TestClient(app) as http:
            adapter = _TestClientRequestsAdapter(http)

            def token_provider() -> tuple[str, int]:
                token, _claims = mint_prefix_gateway_token(
                    hushh_id="ha1_ws_01",
                    owner_id="owner-ws-01",
                    placement_epoch=1,
                    ttl_seconds=600,
                )
                return token, 600

            files_store = FilesPrefixStore(
                base_url, subprefix="files/v1", token_provider=token_provider, session=adapter
            )
            assert files_runtime.custody_key_reference() == "hub_broker"
            retention = await files_store.verify_bucket("hub_broker")
            assert retention["custodyMode"] == "hub_broker"
            with pytest.raises(FilesRefused):
                await files_store.verify_bucket("wrong-kms")

            ver = await files_store.put_if_generation("entries/item1.bin", b"cipher-file", ABSENT)
            assert ver is not None
            raw = await backing.get("pods/ha1_ws_01/files/v1/entries/item1.bin")
            assert raw == b"cipher-file"
            listed, next_cur = await files_store.list_page("entries", limit=10)
            assert listed == ["entries/item1.bin"]
            assert next_cur == ""

            ws_store = files_runtime._resolve_pod_root_workspace_store(files_store)
            assert isinstance(ws_store, FilesPrefixStore)
            assert ws_store._subprefix == ""
            ws_ver = await ws_store.put_if_generation(
                "workspaces/v1/ws_default/heads/current", b"cipher-ws", ABSENT
            )
            assert ws_ver is not None
            assert (
                await backing.get("pods/ha1_ws_01/workspaces/v1/ws_default/heads/current")
                == b"cipher-ws"
            )
    finally:
        set_storage_gateway_overrides_for_tests()


def test_prefix_store_bounded_timeouts_single_get_retry_and_no_put_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import requests

    from hushh_mcp.services.pod_storage_transport import PodStorageTransport

    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv(PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
    monkeypatch.setattr("hushh_mcp.services.pod_s3_object_store.time.sleep", lambda _s: None)

    base_url = "http://127.0.0.1:8080/api/one/pod/storage-gateway/pods/ha1_retry_01"
    token_fn = lambda: ("synthetic_gateway_token", 600)  # noqa: E731

    class _Resp:
        def __init__(
            self, status_code: int, content: bytes = b"", headers: dict[str, str] | None = None
        ):
            self.status_code = status_code
            self.content = content
            self.headers = headers or {}
            self.closed = False

        def close(self) -> None:
            self.closed = True

    # 1) GET recovers on attempt 2 after ReadTimeout and uses bounded (3.0, 4.0) tuple timeout.
    calls: list[tuple[str, Any]] = []

    class _ReadTimeoutThenOkSession:
        def get(self, url: str, **kwargs: Any) -> Any:
            calls.append(("get", kwargs.get("timeout")))
            if len(calls) == 1:
                raise requests.exceptions.ReadTimeout("simulated read timeout")
            return _Resp(200, b"ok-bytes", {"ETag": '"v1"'})

    store = PrefixTokenObjectStore(
        base_url, token_provider=token_fn, session=_ReadTimeoutThenOkSession()
    )
    data, ver = store.get_with_generation_blocking("wiki/overview.json")
    assert data == b"ok-bytes"
    assert ver == '"v1"'
    assert calls == [("get", (3.0, 4.0)), ("get", (3.0, 4.0))]

    # 2) GET recovers on attempt 2 after transient 503 and closes the 503 response.
    transient_503 = _Resp(503)
    calls_503: list[str] = []

    class _503ThenOkSession:
        def get(self, url: str, **kwargs: Any) -> Any:
            calls_503.append(url)
            if len(calls_503) == 1:
                return transient_503
            return _Resp(200, b"recovered", {"ETag": '"v2"'})

    store_503 = PrefixTokenObjectStore(
        base_url, token_provider=token_fn, session=_503ThenOkSession()
    )
    data_503, ver_503 = store_503.get_with_generation_blocking("wiki/overview.json")
    assert data_503 == b"recovered"
    assert ver_503 == '"v2"'
    assert transient_503.closed is True
    assert len(calls_503) == 2

    # 3) Two consecutive GET failures raise PodMultiCloudStorageError after exactly 2 attempts.
    always_503_calls = 0

    class _Always503Session:
        def get(self, url: str, **kwargs: Any) -> Any:
            nonlocal always_503_calls
            always_503_calls += 1
            return _Resp(503)

    store_fail = PrefixTokenObjectStore(
        base_url, token_provider=token_fn, session=_Always503Session()
    )
    with pytest.raises(PodMultiCloudStorageError):
        store_fail.get_with_generation_blocking("wiki/overview.json")
    assert always_503_calls == 2

    # 4) PUT uses (3.0, 10.0) timeout and NEVER retries ReadTimeout (preserves CAS safety).
    put_calls: list[Any] = []

    class _PutTimeoutSession:
        def put(self, url: str, **kwargs: Any) -> Any:
            put_calls.append(kwargs.get("timeout"))
            raise requests.exceptions.ReadTimeout("simulated put timeout")

    store_put = PrefixTokenObjectStore(
        base_url, token_provider=token_fn, session=_PutTimeoutSession()
    )
    with pytest.raises(PodMultiCloudStorageError):
        store_put.put_if_generation_blocking("wiki/overview.json", b"payload", ABSENT)
    assert put_calls == [(3.0, 10.0)]

    # 5) PodStorageTransport excludes ConnectTimeout so ConnectTimeout attempts == 2 (not 2x2=4).
    transport = PodStorageTransport(shared_pool=False)
    connect_attempts = 0

    class _ConnectTimeoutRawSession:
        def request(self, method: str, url: str, **kwargs: Any) -> Any:
            nonlocal connect_attempts
            connect_attempts += 1
            raise requests.exceptions.ConnectTimeout("simulated connect timeout")

    monkeypatch.setattr(transport, "_session_for_worker", lambda: _ConnectTimeoutRawSession())
    store_transport = PrefixTokenObjectStore(base_url, token_provider=token_fn, session=transport)
    with pytest.raises(PodMultiCloudStorageError):
        store_transport.get_with_generation_blocking("wiki/overview.json")
    assert connect_attempts == 2


def test_storage_gateway_reuses_gcs_store_and_maps_backing_errors_to_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import api.routes.one.pod_prefix_storage_gateway as gw

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv(BROKER_SEAL_SECRET_ENV, "33" * 32)
    monkeypatch.setenv("HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET", "hussh-hosted-pods-uat")
    monkeypatch.setenv("HUSSH_POD_STORAGE_GATEWAY_GCS_PREFIX", "hub")

    set_storage_gateway_overrides_for_tests()
    try:
        first = gw._resolve_store()
        second = gw._resolve_store()
        assert first is not None and first is second

        monkeypatch.setenv("HUSSH_POD_STORAGE_GATEWAY_GCS_PREFIX", "hub-v2")
        third = gw._resolve_store()
        assert third is not None and third is not first
    finally:
        set_storage_gateway_overrides_for_tests()

    class _FailingStore:
        async def get_with_generation(self, _key: str):
            raise RuntimeError("pod storage metadata unavailable")

        async def put_if_generation(self, _key: str, _data: bytes, _expected: str):
            raise RuntimeError("pod storage write unconfirmed")

    registry = _FakeRegistry(
        {"hushh_id": "ha1_err_01", "user_id": "owner-err-01", "placement_epoch": 1}
    )
    set_storage_gateway_overrides_for_tests(
        store_factory=_FailingStore,
        registry_factory=lambda: registry,
    )
    try:
        app = FastAPI()
        app.include_router(gateway_router)
        client = TestClient(app)
        token, _ = mint_prefix_gateway_token(
            owner_id="owner-err-01",
            hushh_id="ha1_err_01",
            placement_epoch=1,
            ttl_seconds=300,
        )
        headers = {"Authorization": f"Bearer {token}"}
        get_resp = client.get(
            "/api/one/pod/storage-gateway/pods/ha1_err_01/head.json", headers=headers
        )
        put_resp = client.put(
            "/api/one/pod/storage-gateway/pods/ha1_err_01/head.json",
            headers=headers,
            content=b"{}",
        )
        assert get_resp.status_code == 503
        assert put_resp.status_code == 503
    finally:
        set_storage_gateway_overrides_for_tests()
