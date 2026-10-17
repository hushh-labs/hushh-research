"""Where standby sync is wired: the owner's route, the reconcile sweep, the pod's epoch.

- ``POST /api/one/runtime/standby/sync`` syncs the CALLER's own standby and nobody else's.
- The reconcile loop runs the injected sweep after each unskipped pass and survives its
  failure; the reconcile worker class itself never runs it.
- A pod's signed hub requests carry ``X-Hushh-Pod-Epoch`` once it has a role object, and
  are byte-for-byte today's requests while it has none (E4).
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from api.middleware import require_firebase_auth  # noqa: E402
from api.routes.one import router as one_router  # noqa: E402
from api.routes.one import runtime_standby  # noqa: E402
from hushh_mcp.services import (  # noqa: E402
    personal_agent_reconcile_worker as worker_module,
)
from hushh_mcp.services import pod_hub_client, pod_role, pod_standby_sync  # noqa: E402
from hushh_mcp.services.pod_request_signing import (  # noqa: E402
    EPOCH_HEADER,
    parse_signature_headers,
    public_key_b64,
    verify_request_signature,
)
from hushh_mcp.services.pod_role import PRIMARY_AT_ZERO, PodRole, PodRoleUnreadable  # noqa: E402
from hushh_mcp.services.pod_standby_sync_checks import outcome  # noqa: E402

ROUTE = "/api/one/runtime/standby/sync"


# -- the owner's route -------------------------------------------------------------------


def _client(uid: str | None) -> TestClient:
    app = FastAPI()
    app.include_router(runtime_standby.router)
    if uid is not None:
        app.dependency_overrides[require_firebase_auth] = lambda: uid
    return TestClient(app)


@pytest.fixture
def synced(monkeypatch) -> list[str]:
    seen: list[str] = []

    async def fake(user_id: str):
        seen.append(user_id)
        return outcome("equal_heads", synced_seq=4, synced_head_sha="a" * 64, recorded=True)

    monkeypatch.setattr(pod_standby_sync, "sync_standby_on_demand", fake)
    return seen


def test_the_route_refuses_a_caller_without_a_firebase_identity(synced):
    response = _client(None).post(ROUTE)
    assert response.status_code == 401
    assert synced == []


def test_the_hub_one_router_mounts_the_route():
    assert any(getattr(r, "path", None) == ROUTE for r in one_router.routes)


def test_the_route_syncs_only_the_callers_own_standby(synced):
    response = _client("uid-owner").post(ROUTE, json={"user_id": "uid-somebody-else"})
    assert response.status_code == 200
    assert synced == ["uid-owner"]
    assert response.json() == {
        "status": "synced",
        "reason": "equal_heads",
        "synced_seq": 4,
        "synced_head_sha": "a" * 64,
        "records_transferred": 0,
        "recorded": True,
    }


# -- the reconcile sweep -----------------------------------------------------------------


async def _none() -> list:
    return []


async def _noop(_: object) -> None:
    return None


def _worker():
    return worker_module.PersonalAgentReconcileWorker(
        fetch_stalled=_none,
        retry=_noop,
        fetch_idle=lambda _since: _none(),
        reap=_noop,
    )


@pytest.fixture
def switches_on(monkeypatch):
    monkeypatch.setattr(worker_module, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(worker_module, "personal_agent_reconcile_enabled", lambda: True)


async def _run_passes(monkeypatch, passes: int, sync_standbys=None) -> None:
    """Drive the real reconcile loop for ``passes`` passes; the loop's own sleep ends it."""
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        if len(slept) >= passes:
            raise asyncio.CancelledError

    fake = SimpleNamespace(CancelledError=asyncio.CancelledError, sleep=sleep)
    monkeypatch.setattr(worker_module, "asyncio", fake)
    with pytest.raises(asyncio.CancelledError):
        await worker_module._reconcile_loop(_worker(), 0, sync_standbys)
    assert len(slept) == passes


async def test_each_pass_runs_the_standby_sweep_once(switches_on, monkeypatch):
    passes: list[int] = []

    async def sweep() -> None:
        passes.append(1)

    await _run_passes(monkeypatch, 2, sweep)
    assert passes == [1, 1]


async def test_a_failing_standby_sweep_never_stops_the_loop(switches_on, monkeypatch):
    calls: list[int] = []

    async def sweep() -> None:
        calls.append(1)
        raise RuntimeError("store down")

    await _run_passes(monkeypatch, 3, sweep)
    assert calls == [1, 1, 1]


async def test_the_sweep_is_off_with_the_reconcile_switch(monkeypatch):
    monkeypatch.setattr(worker_module, "personal_agent_reconcile_enabled", lambda: False)
    passes: list[int] = []

    async def sweep() -> None:
        passes.append(1)

    await _run_passes(monkeypatch, 2, sweep)
    assert passes == []


async def test_no_injected_sweep_is_today_exactly(switches_on, monkeypatch):
    await _run_passes(monkeypatch, 2)
    assert (await _worker().scan_and_reconcile()).skipped is False


def test_the_worker_class_never_runs_the_standby_sweep():
    """The sweep rides the loop, so a direct scan (and its report) is exactly today's."""
    params = worker_module.PersonalAgentReconcileWorker.__init__.__code__.co_varnames
    assert "sync_standbys" not in params


def test_the_loop_is_handed_the_sweep_from_the_start_function(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(worker_module, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(worker_module, "personal_agent_reconcile_enabled", lambda: True)

    def loop(worker, interval_seconds, sync_standbys):
        seen.update(interval=interval_seconds, sweep=sync_standbys)
        return "loop"

    monkeypatch.setattr(worker_module, "_reconcile_loop", loop)
    monkeypatch.setattr(
        worker_module, "asyncio", SimpleNamespace(create_task=lambda coro, name: (coro, name))
    )

    async def sweep() -> None:
        return None

    task = worker_module.start_personal_agent_reconcile_loop(
        fetch_stalled=_none,
        retry=_noop,
        fetch_idle=lambda _since: _none(),
        reap=_noop,
        interval_seconds=7,
        sync_standbys=sweep,
    )
    assert task == ("loop", "personal-agent-reconcile-worker")
    assert seen == {"interval": 7, "sweep": sweep}


def test_the_server_wires_the_standby_sweep_into_the_reconcile_loop():
    source = (Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")
    assert "from hushh_mcp.services.pod_standby_sync import sweep_due_standbys" in source
    assert "sync_standbys=sweep_due_standbys," in source


# -- the pod's signed epoch --------------------------------------------------------------

KEY = Ed25519PrivateKey.from_private_bytes(b"\x07" * 32)
STANDBY_AT_3 = PodRole(role="standby", epoch=3, primary_signing_key_id="pods_" + "a" * 32)


@pytest.fixture
def pod(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "ha1_owner")
    monkeypatch.setattr("hushh_mcp.services.pod_self_registration.pod_signing_key", lambda: KEY)
    pod_role.reset_role_cache()
    yield
    pod_role.reset_role_cache()


def _signed(path: str = "/api/pod/heartbeat", body: bytes = b"{}") -> dict:
    return pod_hub_client._signature_headers(
        "https://hub.test", "POST", f"https://hub.test{path}", [], body
    )


def _verifies(signed, body: bytes) -> bool:
    return verify_request_signature(
        public_key_b64(KEY),
        signed,
        aud="https://hub.test",
        hushh_id="ha1_owner",
        method="POST",
        path="/api/pod/heartbeat",
        query_pairs=[],
        body=body,
    )


def _durable(monkeypatch, value: bool = True) -> None:
    monkeypatch.setattr(pod_role, "durable_storage_configured", lambda: value)


def test_a_pod_without_durable_storage_signs_exactly_as_today(pod, monkeypatch):
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    assert pod_role.signing_epoch() is None
    headers = _signed()
    assert EPOCH_HEADER not in headers
    assert parse_signature_headers(headers).epoch is None


def test_a_pod_with_no_role_object_signs_exactly_as_today(pod, monkeypatch):
    _durable(monkeypatch)
    pod_role.remember_role(PRIMARY_AT_ZERO)
    assert EPOCH_HEADER not in _signed()


def test_a_pod_with_a_role_signs_its_epoch_inside_the_signature(pod, monkeypatch):
    _durable(monkeypatch)
    pod_role.remember_role(STANDBY_AT_3)
    headers = _signed(body=b'{"a":1}')
    assert headers[EPOCH_HEADER] == "3"
    signed = parse_signature_headers(headers)
    assert signed.epoch == 3
    assert _verifies(signed, b'{"a":1}')
    assert not _verifies(dataclasses.replace(signed, epoch=4), b'{"a":1}')
    assert not _verifies(dataclasses.replace(signed, epoch=None), b'{"a":1}')


def test_a_sealed_primary_at_zero_still_signs_epoch_zero(pod, monkeypatch):
    """Not the absent default: once the hub wrote a role, the fence expects the header."""
    _durable(monkeypatch)
    pod_role.remember_role(PodRole(role="primary", epoch=0))
    assert _signed()[EPOCH_HEADER] == "0"


def test_an_unreadable_role_sends_no_epoch_so_the_hub_fence_refuses(pod, monkeypatch):
    _durable(monkeypatch)

    async def unreadable(*, fresh=False):
        raise PodRoleUnreadable("forbidden")

    monkeypatch.setattr(pod_role, "read_pod_role", unreadable)
    assert pod_role.signing_epoch() is None
    assert EPOCH_HEADER not in _signed()


async def test_the_epoch_is_read_even_from_a_running_loop_thread(pod, monkeypatch):
    _durable(monkeypatch)

    async def read(*, fresh=False):
        return PodRole(role="primary", epoch=2)

    monkeypatch.setattr(pod_role, "read_pod_role", read)
    assert pod_role.signing_epoch() == 2


def test_the_epoch_is_read_from_a_worker_thread_without_a_loop(pod, monkeypatch):
    import threading

    _durable(monkeypatch)

    async def read(*, fresh=False):
        return STANDBY_AT_3

    monkeypatch.setattr(pod_role, "read_pod_role", read)
    seen: list = []
    thread = threading.Thread(target=lambda: seen.append(pod_role.signing_epoch()))
    thread.start()
    thread.join(5)
    assert seen == [3]
