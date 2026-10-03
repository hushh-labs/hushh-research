"""The pod's role object: fail closed, forward only, and one gate for every standby refusal.

Negative controls first: a forbidden read, a tampered object and an unwrappable key
must each refuse turns and writes rather than read as "primary". The regression half
proves that a pod without a role object (every pod today) behaves exactly as before.
"""

from __future__ import annotations

import ast
import base64
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from api.middlewares.pod_role_guard import PodRoleGuard  # noqa: E402
from hushh_mcp.services import pod_role, pod_sync_proof  # noqa: E402
from hushh_mcp.services.pod_commit_log import LocalObjectStore  # noqa: E402
from hushh_mcp.services.pod_role import (  # noqa: E402
    CODE_STANDBY,
    CODE_UNREADABLE,
    PRIMARY_AT_ZERO,
    ROLE_OBJECT,
    PodRole,
    PodRoleConflict,
    PodRoleRefused,
    PodRoleStaleEpoch,
    PodRoleUnreadable,
    load_role,
    read_pod_role,
    role_seal_key,
    store_role,
    sync_import_scope,
)
from hushh_mcp.services.pod_role_log import RoleAwareCommitLog  # noqa: E402

LOG_KEY = b"K" * 32
OWNER = "ha1_owner"
PRIMARY_KID = "pods_" + "1" * 32
STANDBY = PodRole(role="standby", epoch=1, primary_signing_key_id=PRIMARY_KID)


@pytest.fixture(autouse=True)
def _fresh_cache():
    pod_role.reset_role_cache()
    yield
    pod_role.reset_role_cache()


@pytest.fixture
def durable(monkeypatch, tmp_path):
    """A commit-log pod on local storage, as resolve_pod_storage would build it."""
    monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path / "pod"))
    monkeypatch.setenv("HUSSH_POD_LOG_KEY", base64.b64encode(LOG_KEY).decode())
    monkeypatch.setenv("HUSSH_ID", OWNER)
    for name in ("POD_STORAGE_GCS_BUCKET", "POD_STORAGE_AZURE_BLOB_URL"):
        monkeypatch.delenv(name, raising=False)
    return LocalObjectStore(str(tmp_path / "pod"))


class _ForbiddenStore:
    """A store that refuses (403-shaped) rather than answering absent."""

    async def get(self, key):
        raise RuntimeError("403 forbidden")

    async def get_with_generation(self, key):
        raise RuntimeError("403 forbidden")


# --------------------------------------------------------------------------- #
# Reading fails closed
# --------------------------------------------------------------------------- #


async def test_absent_role_object_is_primary_at_epoch_zero(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    assert await load_role(store, role_seal_key(LOG_KEY), hushh_id=OWNER) == PRIMARY_AT_ZERO


async def test_a_forbidden_read_is_unreadable_never_primary():
    with pytest.raises(PodRoleUnreadable):
        await load_role(_ForbiddenStore(), role_seal_key(LOG_KEY), hushh_id=OWNER)


@pytest.mark.parametrize("damage", ["flip", "truncate", "other_key", "other_owner"])
async def test_a_tampered_or_foreign_role_object_is_unreadable(tmp_path, damage):
    store = LocalObjectStore(str(tmp_path))
    await store_role(store, role_seal_key(LOG_KEY), STANDBY, hushh_id=OWNER)
    key, owner = role_seal_key(LOG_KEY), OWNER
    if damage in ("flip", "truncate"):
        raw, version = await store.get_with_generation(ROLE_OBJECT)
        raw = raw[:-1] + bytes([raw[-1] ^ 1]) if damage == "flip" else raw[:10]
        assert await store.put_if_generation(ROLE_OBJECT, raw, version) is not None
    elif damage == "other_key":
        key = role_seal_key(b"Z" * 32)
    else:
        owner = "ha1_someone_else"

    with pytest.raises(PodRoleUnreadable):
        await load_role(store, key, hushh_id=owner)


async def test_the_role_key_is_derived_never_the_log_key():
    assert role_seal_key(LOG_KEY) != LOG_KEY


async def test_no_durable_storage_is_primary_without_any_io(monkeypatch):
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)

    def explode():
        raise AssertionError("a pod without durable storage must not touch storage")

    monkeypatch.setattr("hushh_mcp.services.pod_storage.resolve_pod_object_store", explode)
    assert await read_pod_role() == PRIMARY_AT_ZERO


async def test_read_pod_role_absent_needs_no_key(durable, monkeypatch):
    def explode():
        raise AssertionError("an absent role must not unwrap the pod key")

    monkeypatch.setattr("hushh_mcp.services.byoc_key_custody.resolve_pod_log_key", explode)
    assert await read_pod_role(fresh=True) == PRIMARY_AT_ZERO


async def test_read_pod_role_fails_closed_on_forbidden_storage(durable, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.pod_storage.resolve_pod_object_store", lambda: _ForbiddenStore()
    )
    with pytest.raises(PodRoleUnreadable):
        await read_pod_role(fresh=True)


async def test_read_pod_role_fails_closed_when_the_key_will_not_unwrap(durable, monkeypatch):
    await store_role(durable, role_seal_key(LOG_KEY), STANDBY, hushh_id=OWNER)
    pod_role.reset_role_cache()

    def unwrap_refused():
        raise RuntimeError("kms 403")

    monkeypatch.setattr("hushh_mcp.services.byoc_key_custody.resolve_pod_log_key", unwrap_refused)
    with pytest.raises(PodRoleUnreadable):
        await read_pod_role(fresh=True)


async def test_read_pod_role_reads_a_stored_standby(durable):
    await store_role(durable, role_seal_key(LOG_KEY), STANDBY, hushh_id=OWNER)
    pod_role.reset_role_cache()
    assert await read_pod_role(fresh=True) == STANDBY


async def test_an_unknown_storage_backend_is_unreadable(monkeypatch):
    monkeypatch.setenv("POD_STORAGE_BACKEND", "mystery")
    with pytest.raises(PodRoleUnreadable):
        await read_pod_role()


# --------------------------------------------------------------------------- #
# Writing is forward only, with compare-and-swap
# --------------------------------------------------------------------------- #


async def test_the_first_write_accepts_epoch_zero_and_later_writes_move_forward(tmp_path):
    store, key = LocalObjectStore(str(tmp_path)), role_seal_key(LOG_KEY)
    first = PodRole(role="standby", epoch=0, primary_signing_key_id=PRIMARY_KID)
    await store_role(store, key, first, hushh_id=OWNER)
    promoted = PodRole(role="primary", epoch=1)
    await store_role(store, key, promoted, hushh_id=OWNER)
    assert await load_role(store, key, hushh_id=OWNER) == promoted


@pytest.mark.parametrize("epoch", [1, 0])
async def test_an_equal_or_older_epoch_is_refused(tmp_path, epoch):
    store, key = LocalObjectStore(str(tmp_path)), role_seal_key(LOG_KEY)
    await store_role(store, key, STANDBY, hushh_id=OWNER)

    with pytest.raises(PodRoleStaleEpoch):
        await store_role(store, key, PodRole(role="primary", epoch=epoch), hushh_id=OWNER)
    assert await load_role(store, key, hushh_id=OWNER) == STANDBY


async def test_a_lost_race_writes_nothing(tmp_path, monkeypatch):
    store, key = LocalObjectStore(str(tmp_path)), role_seal_key(LOG_KEY)

    async def lost(*_args):
        return None

    monkeypatch.setattr(store, "put_if_generation", lost)
    with pytest.raises(PodRoleConflict):
        await store_role(store, key, STANDBY, hushh_id=OWNER)
    assert await store.get(ROLE_OBJECT) is None


async def test_a_write_over_an_unreadable_role_is_refused(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    await store_role(store, role_seal_key(LOG_KEY), STANDBY, hushh_id=OWNER)
    with pytest.raises(PodRoleUnreadable):
        await store_role(
            store, role_seal_key(b"Z" * 32), PodRole(role="primary", epoch=9), hushh_id=OWNER
        )


@pytest.mark.parametrize(
    "bad",
    [
        PodRole(role="standby", epoch=1, primary_signing_key_id=None),
        PodRole(role="primary", epoch=1, primary_signing_key_id=PRIMARY_KID),
        PodRole(role="leader", epoch=1),
        PodRole(role="primary", epoch=-1),
    ],
)
async def test_malformed_roles_are_never_written(tmp_path, bad):
    store = LocalObjectStore(str(tmp_path))
    with pytest.raises(ValueError):
        await store_role(store, role_seal_key(LOG_KEY), bad, hushh_id=OWNER)
    assert await store.get(ROLE_OBJECT) is None


# --------------------------------------------------------------------------- #
# The log gate: every in-process writer, one place
# --------------------------------------------------------------------------- #


async def test_a_standby_log_refuses_appends_outside_sync_import(tmp_path):
    log = RoleAwareCommitLog(LocalObjectStore(str(tmp_path)), LOG_KEY, owner_id=OWNER)
    await log.write_role(STANDBY)

    with pytest.raises(PodRoleRefused) as refusal:
        await log.append("memory_record", {"text": "a standby must not learn on its own"})
    assert refusal.value.code == CODE_STANDBY
    assert await log.verified_head() is None

    with sync_import_scope():
        written = await log.append("memory_record", {"text": "imported"}, expected_seq=0)
    assert written["seq"] == 1


async def test_an_unreadable_role_refuses_appends(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    await store_role(store, role_seal_key(b"Z" * 32), STANDBY, hushh_id=OWNER)
    log = RoleAwareCommitLog(store, LOG_KEY, owner_id=OWNER)

    with pytest.raises(PodRoleRefused) as refusal:
        await log.append("memory_record", {"text": "x"})
    assert refusal.value.code == CODE_UNREADABLE


async def test_regression_no_role_object_appends_exactly_as_before(tmp_path):
    """Same records, same chain, same head as the plain PodCommitLog."""
    from hushh_mcp.services.pod_commit_log import PodCommitLog

    aware = RoleAwareCommitLog(LocalObjectStore(str(tmp_path / "a")), LOG_KEY, owner_id=OWNER)
    plain = PodCommitLog(LocalObjectStore(str(tmp_path / "b")), LOG_KEY, owner_id=OWNER)
    for kind, payload in (("memory_record", {"n": 1}), ("pod_config", {"n": 2})):
        await aware.append(kind, payload)
        await plain.append(kind, payload)
    assert [r["sha"] for r in await aware.replay()] == [r["sha"] for r in await plain.replay()]
    assert (await aware.verified_head()).sha == (await plain.replay())[-1]["sha"]
    assert await aware._store.get(ROLE_OBJECT) is None


async def test_resolve_pod_storage_builds_the_role_aware_log(durable):
    from hushh_mcp.services.pod_storage import resolve_pod_storage

    assert isinstance(resolve_pod_storage()._log, RoleAwareCommitLog)


# --------------------------------------------------------------------------- #
# The request gate: turns, writes and websockets refused on a standby
# --------------------------------------------------------------------------- #


def _guarded_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(PodRoleGuard)

    @app.post("/api/one/pod/turn")
    async def turn():
        return {"answered": True}

    @app.post("/api/one/pod/memory/revoke")
    async def memory_write():
        return {"written": True}

    @app.get("/api/one/pod/memory/status")
    async def memory_status():
        return {"read": True}

    @app.post("/pod/sync/import")
    async def sync_import():
        return {"imported": True}

    @app.post("/pod/migration/erasure/fence")
    async def erasure():
        return {"fenced": True}

    @app.websocket("/api/one/pod/live")
    async def live(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_json({"live": True})
        await websocket.close()

    return app


async def _make_standby(store) -> None:
    await store_role(store, role_seal_key(LOG_KEY), STANDBY, hushh_id=OWNER)
    pod_role.reset_role_cache()


async def test_a_standby_refuses_a_turn_and_a_memory_write(durable):
    await _make_standby(durable)
    client = TestClient(_guarded_app())

    for path in ("/api/one/pod/turn", "/api/one/pod/memory/revoke"):
        response = client.post(path, json={})
        assert response.status_code == 409, path
        assert response.json()["code"] == CODE_STANDBY
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/api/one/pod/live") as ws:
            ws.receive_json()
    assert closed.value.code == 1008


async def test_a_standby_still_serves_reads_sync_import_and_erasure(durable):
    await _make_standby(durable)
    client = TestClient(_guarded_app())

    assert client.get("/api/one/pod/memory/status").json() == {"read": True}
    assert client.post("/pod/sync/import", json={}).json() == {"imported": True}
    assert client.post("/pod/migration/erasure/fence", json={}).json() == {"fenced": True}


async def test_an_unreadable_role_refuses_turns_with_its_own_code(durable):
    await store_role(durable, role_seal_key(b"Z" * 32), STANDBY, hushh_id=OWNER)
    pod_role.reset_role_cache()
    response = TestClient(_guarded_app()).post("/api/one/pod/turn", json={})
    assert response.status_code == 503
    assert response.json()["code"] == CODE_UNREADABLE


async def test_regression_no_role_object_serves_everything_as_before(durable):
    client = TestClient(_guarded_app())
    assert client.post("/api/one/pod/turn", json={}).json() == {"answered": True}
    assert client.post("/api/one/pod/memory/revoke", json={}).json() == {"written": True}
    with client.websocket_connect("/api/one/pod/live") as ws:
        assert ws.receive_json() == {"live": True}


async def test_regression_no_durable_storage_serves_everything_as_before(monkeypatch):
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    client = TestClient(_guarded_app())
    assert client.post("/api/one/pod/turn", json={}).json() == {"answered": True}


async def test_the_real_pod_app_mounts_the_guard_on_its_turn_route(durable):
    import pod_server

    await _make_standby(durable)
    response = TestClient(pod_server.app).post("/api/one/pod/turn", json={})
    assert response.status_code == 409
    assert response.json()["code"] == CODE_STANDBY


# --------------------------------------------------------------------------- #
# The shared proof audience
# --------------------------------------------------------------------------- #


def test_the_sync_audience_binds_purpose_and_body():
    from api.routes.one.pod_migration import hub_proof_audience

    body = {"base_seq": 3, "standby_key_id": "pod-a"}
    audience = pod_sync_proof.sync_proof_audience(OWNER, "sync-export", body)
    assert audience.startswith(f"{hub_proof_audience(OWNER)}:sync-export:")
    assert audience == pod_sync_proof.sync_proof_audience(
        OWNER, "sync-export", {"standby_key_id": "pod-a", "base_seq": 3}
    )
    assert audience != pod_sync_proof.sync_proof_audience(
        OWNER, "sync-export", {**body, "standby_key_id": "pod-b"}
    )
    assert audience != pod_sync_proof.sync_proof_audience(OWNER, "sync-import", body)
    with pytest.raises(ValueError):
        pod_sync_proof.sync_proof_audience(OWNER, "erasure", body)
    with pytest.raises(ValueError):
        pod_sync_proof.sync_proof_audience("", "sync-head", {})


def test_the_shared_proof_module_has_no_decryption_path():
    """The hub imports this module; it must carry no means of opening anything."""
    tree = ast.parse(Path(pod_sync_proof.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    called: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name:
                called.add(name)
    forbidden = {"cryptography", "open_bundle", "open_range_bundle", "pod_migration_bundle"}
    assert not {n for n in imported if any(f in n for f in forbidden)}
    assert not (called & {"decrypt", "open_bundle", "open_range_bundle", "unseal"})
