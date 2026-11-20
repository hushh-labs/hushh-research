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
