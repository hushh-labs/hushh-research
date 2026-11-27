"""The pod's app surface over HTTP: challenge, admit, renew, revoke, status, config.

Driven through a real ASGI app with the ingress policy mounted, so the tests prove
the surface a browser or a device actually meets: which routes pass the wall, which
role each accepts, and that every refusal is the authority's own exact code.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from api.middlewares.pod_ingress import PodIngressPolicy
from api.middlewares.rate_limit import limiter
from api.routes.one import pod_session
from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_config
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityStore,
    claim_incarnation,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_owner"
USER = "uid-1"
POD_KEY_ID = "podk_route_test"
POD_PUBLIC_KEY = base64.b64encode(b"R" * 32).decode()
DEK = b"S" * 32
KID = "hushh-consent-routes"


@pytest.fixture
def hub_key(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", KID)
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({KID: base64.b64encode(public).decode()})
    )
    token_signing.reset_caches()
    yield
    token_signing.reset_caches()


class Subject:
    def __init__(self, subject_id: str, platform: str) -> None:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        self.subject_id = subject_id
        self.platform = platform
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._hashes, self._ec = hashes, ec
        self.public_key_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode()

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode(), self._ec.ECDSA(self._hashes.SHA256()))
        ).decode()

    def binding(self, *, version=1, scopes=None) -> dict:
        role = psa.role_for_platform(self.platform)
        now = int(time.time() * 1000)
        return {
            "kind": psa.BINDING_KIND,
            "hushh_id": OWNER,
            "user_id": USER,
            "environment": "dev",
            "deployment_target": "user_gcp",
            "pod_key_id": POD_KEY_ID,
            "pod_public_key": POD_PUBLIC_KEY,
            "url": "https://pod.example",
            "subject_id": self.subject_id,
            "subject_kind": role,
            "subject_public_key": self.public_key_b64,
            "platform": self.platform,
            "role": role,
            "scopes": list(
                scopes
                if scopes is not None
                else (psa.APP_SCOPES if role == "app" else psa.DEVICE_INFERENCE_SCOPES)
            ),
            "version": version,
            "issued_at_ms": now,
            "expires_at_ms": now + 86_400_000,
        }


@pytest.fixture
async def pod(tmp_path, monkeypatch, hub_key):
    """A pod app with the session router, the wall and a live local authority."""
    # The shared SlowAPI limiter also serves other route tests in this worker.
    # Keep their TestClient admission traffic from exhausting this fixture's
    # 30/min budget before its own role assertions run.
    limiter.reset()
    monkeypatch.setattr(pod_session, "pod_mode", lambda: True)
    monkeypatch.setenv("HUSSH_POD_IMAGE_TAG", "dev-test")
    object_store = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(object_store, DEK, owner_id=OWNER)
    incarnation = await claim_incarnation(object_store, DEK, instance_id="rev-a")
    store = PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=IncarnationLease(object_store, incarnation),
        dek=DEK,
        pod_key_id=POD_KEY_ID,
        pod_public_key=POD_PUBLIC_KEY,
        environment="dev",
    )
    psa.set_active_session_authority(authority)
    pod_config.set_active_pod_config(None)
    from hushh_mcp.services import pod_memory_service

    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(pod_session.router)
    from api.middlewares.chat_key import ChatKeyMiddleware, chat_key_error_handler
    from api.routes.one.pod_agent_chat import router as chat_router
    from hushh_mcp.one_adk import pod_agui_context
    from hushh_mcp.services.chat_key import CHAT_KEY_ERRORS

    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_POD_TURN_ENABLED", "true")
    monkeypatch.setattr(pod_agui_context, "_projection", None)
    app.include_router(chat_router)
    app.add_middleware(ChatKeyMiddleware)
    for error in CHAT_KEY_ERRORS:
        app.add_exception_handler(error, chat_key_error_handler)
    app.add_middleware(PodIngressPolicy)
    client = TestClient(app, raise_server_exceptions=False)
    yield {"client": client, "authority": authority, "log": log, "store": store}
    limiter.reset()
    psa.set_active_session_authority(None)
    pod_config.set_active_pod_config(None)


def _sign(binding: dict) -> str:
    return token_signing.sign_payload(
        psa.canonical_json(binding), hmac_key="unused", require_asymmetric=True
    )


def _admit(client: TestClient, subject: Subject, binding: dict | None = None) -> dict:
    binding = binding or subject.binding()
    challenge = client.post(
        "/api/one/pod/session/challenge", json={"subjectId": subject.subject_id}
    )
    assert challenge.status_code == 200, challenge.text
    body = challenge.json()
    response = client.post(
        "/api/one/pod/session/admit",
        json={
            "binding": binding,
            "signature": _sign(binding),
            "challengeId": body["challengeId"],
            "nonce": body["nonce"],
            "proof": subject.sign(body["signingPayload"]),
            "epoch": body["epoch"],
        },
    )
    return (
        response.json()
        if response.status_code == 200
        else {"error": response.json(), "status": response.status_code}
    )


def _auth(session: dict) -> dict:
    return {"Authorization": f"Bearer {session['session']}"}


# -- admission --------------------------------------------------------------------


def test_challenge_and_admit_open_an_app_session(pod):
    app = Subject("tdv_web_1", "web")
    session = _admit(pod["client"], app)
    assert "session" in session, session
    assert session["role"] == "app" and session["epoch"] == pod["authority"].epoch
    assert set(psa.APP_SCOPES) <= set(session["scopes"])


def test_a_refused_admission_carries_the_exact_code(pod):
    app = Subject("tdv_web_1", "web")
    foreign = {**app.binding(), "hushh_id": "ha1_other"}
    result = _admit(pod["client"], app, foreign)
    assert result["status"] == 403
    assert result["error"]["detail"]["code"] == "foreign_owner"
    assert pod["store"].subject(app.subject_id).state == "unknown"


@pytest.mark.parametrize("placement", [None, "gcp"])
def test_device_admission_refuses_missing_or_hosted_placement(pod, placement):
    device = Subject("tdv_mac_refused", "macos")
    binding = device.binding()
    if placement is None:
        binding.pop("deployment_target")
    else:
        binding["deployment_target"] = placement
    result = _admit(pod["client"], device, binding)
    assert result["status"] == 403
    assert result["error"]["detail"]["code"] == "non_byoc_puppy"
    assert pod["store"].subject(device.subject_id).state == "unknown"


def test_admission_answers_503_when_no_local_authority_exists(pod):
    psa.set_active_session_authority(None)
    response = pod["client"].post("/api/one/pod/session/challenge", json={"subjectId": "x"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "LOCAL_AUTHORITY_UNAVAILABLE"


def test_renew_returns_a_fresh_session(pod):
    session = _admit(pod["client"], Subject("tdv_web_1", "web"))
    renewed = pod["client"].post("/api/one/pod/session/renew", headers=_auth(session))
    assert renewed.status_code == 200
    assert renewed.json()["sid"] != session["sid"]


# -- roles on the app surface ----------------------------------------------------------


def test_a_device_role_session_is_refused_on_app_routes(pod, monkeypatch):
    monkeypatch.setattr(
        pod_session, "resource_snapshot", lambda: pytest.fail("sampled before owner authorization")
    )
    device = _admit(pod["client"], Subject("tdv_mac_1", "macos"))
    assert device.get("role") == "device", device
    client = pod["client"]
    for method, path, body in (
        ("GET", "/api/one/pod/status", None),
        ("POST", "/api/one/pod/config", {"changes": {}}),
        ("POST", "/api/one/pod/session/revoke", {"subjectId": "tdv_mac_1"}),
    ):
        response = client.request(method, path, json=body, headers=_auth(device))
        assert response.status_code == 403, path
        assert response.json()["detail"]["code"] == "role_mismatch"


def test_no_bearer_and_a_hub_token_are_refused_by_shape(pod, monkeypatch):
    monkeypatch.setattr(
        pod_session, "resource_snapshot", lambda: pytest.fail("sampled before owner authorization")
    )
    client = pod["client"]
    assert client.get("/api/one/pod/status").status_code == 401
    assert client.get("/api/one/pod/status").json()["detail"]["code"] == "not_local_authority"
    hct = "HCT:" + base64.urlsafe_b64encode(b"u|a|s|1|2").decode() + ".abcd"
    response = client.get("/api/one/pod/status", headers={"Authorization": f"Bearer {hct}"})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "not_local_authority"


# -- status and config -----------------------------------------------------------------


def test_status_reports_config_identity_epoch_subjects_and_image(pod, monkeypatch):
    snapshot = {"status": "unavailable", "observedAtMs": 123}
    monkeypatch.setattr(pod_session, "resource_snapshot", lambda: snapshot)
    app = Subject("tdv_web_1", "web")
    session = _admit(pod["client"], app)
    _admit(pod["client"], Subject("tdv_mac_1", "macos"))
    response = pod["client"].get("/api/one/pod/status", headers=_auth(session))
    assert response.status_code == 200
    body = response.json()
    assert body["podKeyId"] == POD_KEY_ID
    assert body["epoch"] == pod["authority"].epoch
    assert body["incarnation"] == "held"
    assert body["config"]["puppy_broker"] is True
    assert body["imageTag"] == "dev-test"
    subjects = {s["subjectId"]: s for s in body["subjects"]}
    assert subjects["tdv_web_1"]["role"] == "app" and subjects["tdv_mac_1"]["role"] == "device"
    assert "subject_public_key" not in response.text
    assert "puppy" in body
    assert body["resources"] == snapshot


def test_resource_snapshot_is_bounded_numeric_and_reports_missing_limits(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services import pod_resource_snapshot as resources

    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(resources, "_CGROUP", tmp_path)
    monkeypatch.setattr(
        resources,
        "os",
        SimpleNamespace(
            statvfs=lambda _: SimpleNamespace(f_blocks=100, f_bfree=70, f_bavail=60, f_frsize=4096)
        ),
    )
    values = {
        "memory.current": "256",
        "memory.peak": "512",
        "memory.max": "1024",
        "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\nprivate_sentinel 99",
        "cpu.stat": "usage_usec 10\nuser_usec 6\nsystem_usec 4\nnr_periods 2\nnr_throttled 1\nthrottled_usec 3",
    }
    for name, value in values.items():
        (tmp_path / name).write_text(value)
    snapshot = resources.resource_snapshot()
    assert snapshot["status"] == "available"
    assert snapshot["memory"]["peakBytes"] == 512
    assert snapshot["memory"]["limitBytes"] == 1024
    assert snapshot["memory"]["unlimited"] is False
    assert snapshot["cpu"]["throttled_usec"] == 3
    assert snapshot["sharedMemory"]["usedBytes"] == 30 * 4096
    assert "private_sentinel" not in json.dumps(snapshot)
    (tmp_path / "memory.max").write_text("max")
    assert resources.resource_snapshot()["memory"]["unlimited"] is True
    (tmp_path / "memory.peak").unlink()
    (tmp_path / "memory.max").write_text("-1")
    (tmp_path / "cpu.stat").write_text("usage_usec " + "9" * 9000)
    partial = resources.resource_snapshot()
    assert partial["status"] == "partial"
    assert partial["memory"]["currentBytes"] == 256
    assert partial["memory"]["peakBytes"] is None
    assert partial["memory"]["limitBytes"] is None and partial["cpu"] == {}

    def absent_volume(_):
        raise OSError

    for file in tmp_path.iterdir():
        file.unlink()
    (tmp_path / "memory.max").write_text("max")
    monkeypatch.setattr(resources, "os", SimpleNamespace(statvfs=absent_volume))
    limit_only = resources.resource_snapshot()
    assert limit_only["status"] == "partial" and limit_only["memory"]["unlimited"] is True
    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(resources, "_read", lambda _: pytest.fail("off-Linux cgroup read"))
    assert resources.resource_snapshot()["status"] == "unavailable"


def test_config_write_updates_the_active_record_and_refuses_unknown_fields(pod):
    session = _admit(pod["client"], Subject("tdv_web_1", "web"))
    ok = pod["client"].post(
        "/api/one/pod/config",
        json={"changes": {"puppy_broker": False, "memory_review_max_records": 5}},
        headers=_auth(session),
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["config"]["puppy_broker"] is False
    assert pod_config.active_pod_config().memory_review_max_records == 5

    bad = pod["client"].post(
        "/api/one/pod/config", json={"changes": {"not_a_field": 1}}, headers=_auth(session)
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["code"] == "POD_CONFIG_INVALID"
    assert pod_config.active_pod_config().puppy_broker is False


def test_session_only_config_is_durable_before_browser_fence_and_failed_cleanup_retries(
    pod, monkeypatch
):
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from tests.helpers.pod_browser import task_runtime_fixture

    fixture = task_runtime_fixture(monkeypatch)
    pod["client"].app.state.browser_task_runtime = fixture.runtime
    calls = []

    async def suspend(*, pod_id):
        assert pod_id == OWNER
        assert pod_config.active_pod_config().session_only_lockdown
        stored = await pod_config.resolve_pod_config(pod["log"], hushh_id=OWNER)
        assert stored.session_only_lockdown
        calls.append(pod_id)
        if len(calls) == 1:
            raise BrowserRefused("BROWSER_CLOSE_UNCONFIRMED")

    monkeypatch.setattr(fixture.runtime, "suspend_private_contexts", suspend)
    client = pod["client"]
    restricted = Subject("tdv_config_readonly", "web")
    session = _admit(client, restricted, restricted.binding(scopes=[psa.SCOPE_POD_STATUS]))
    denied = client.post(
        "/api/one/pod/config",
        json={"changes": {"session_only_lockdown": True}},
        headers=_auth(session),
    )
    assert denied.status_code == 403 and not calls
    assert not pod_config.active_pod_config().session_only_lockdown
    session = _admit(client, Subject("tdv_config_owner", "web"))
    response = client.post(
        "/api/one/pod/config",
        json={"changes": {"session_only_lockdown": True}},
        headers=_auth(session),
    )
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "BROWSER_CLOSE_UNCONFIRMED",
        "config_retained": True,
    }
    assert pod_config.active_pod_config().session_only_lockdown
    retry = client.post(
        "/api/one/pod/config",
        json={"changes": {"session_only_lockdown": True}},
        headers=_auth(session),
    )
    assert retry.status_code == 200 and len(calls) == 2
    assert retry.json()["config"]["session_only_lockdown"]
    assert fixture.launcher.calls == 0  # changing config never starts Browser


async def _owner_session_cleanup_fixture(pod, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api.routes.one import pod_browser
    from hushh_mcp.services import pod_storage
    from hushh_mcp.services.pod_browser import composition
    from hushh_mcp.services.pod_browser.session_erasure import (
        browser_custody_key,
        install_session_cleanup,
    )
    from hushh_mcp.services.pod_browser.sessions import BrowserSessions
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
    from tests.helpers.pod_browser import _remembered, binding, readiness

    pod["objects"] = pod["authority"].lease._store
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "false")
    monkeypatch.setattr(pod_storage, "resolve_pod_object_store", lambda: pod["objects"])
    monkeypatch.setattr(
        composition,
        "bind_browser_owner",
        AsyncMock(side_effect=AssertionError("erasure must not bind Browser")),
    )
    app = pod["client"].app
    app.include_router(pod_browser.router)
    admission = PodUpgradeAdmission(log_resolver=lambda: pod["log"])
    install_session_cleanup(
        app, log=pod["log"], dek=DEK, logger=pod_session.logger, admission=admission
    )
    cleanup = app.state.browser_session_cleanup
    # Seed an approved synthetic cookie object through the production writer.
    # This fixture does not stand in for website login or owner grant admission.
    sessions = BrowserSessions(
        owner_id=USER,
        store=pod["objects"],
        log=pod["log"],
        custody_key=browser_custody_key(DEK),
        consent=SimpleNamespace(check_binding=AsyncMock(), require=AsyncMock()),
        readiness=readiness(),
        fence_live_contexts=AsyncMock(),
        clock=lambda: 1000,
        mutations=cleanup.mutations,
    )
    sec_id, origins = "sec_" + "a" * 16, ["https://example.com"]
    site = sessions.site_id(origins[0], sec_id)
    saved = await sessions.remember(
        binding(owner_id=USER), site, _remembered(), approved_origins=frozenset(origins)
    )
    return cleanup, sessions, saved, admission, {"sec_id": sec_id, "origins": origins}


@pytest.mark.parametrize("delete_fault", [False, True])
async def test_owner_forget_after_restart_needs_no_task_browser_or_cookie_decryption(
    pod, monkeypatch, delete_fault
):
    from dataclasses import replace

    from hushh_mcp.services.pod_browser.session_cipher import BrowserSessionCipher
    from hushh_mcp.services.pod_browser.session_erasure import install_session_cleanup

    cleanup, _, saved, admission, body = await _owner_session_cleanup_fixture(pod, monkeypatch)
    app, client = pod["client"].app, pod["client"]
    owner = _admit(client, Subject("tdv_erase_owner", "web"))
    headers = _auth(owner)
    path = "/api/one/pod/browser/sessions/forget"
    ciphertext = await pod["objects"].get(saved.object_key)
    assert ciphertext and b"synthetic-session" not in ciphertext
    monkeypatch.setattr(
        BrowserSessionCipher, "open", lambda *_: pytest.fail("Forget must not decrypt cookies")
    )
    for subject, scopes in (
        (Subject("tdv_erase_device", "macos"), None),
        (Subject("tdv_erase_readonly", "web"), [psa.SCOPE_BROWSER_OBSERVE]),
    ):
        session = _admit(client, subject, subject.binding(scopes=scopes))
        denied = client.post(path, headers=_auth(session), json=body)
        assert denied.status_code == 403
        assert await pod["objects"].get(saved.object_key) == ciphertext
    for attribute in ("_pod", "_incarnation"):
        with monkeypatch.context() as context:
            context.setattr(cleanup, attribute, "foreign")
            assert client.post(path, headers=headers, json=body).status_code == 403
    with monkeypatch.context() as context:
        lease = pod["authority"].lease
        context.setattr(lease, "_incarnation", replace(lease.incarnation, epoch=lease.epoch + 1))
        assert client.post(path, headers=headers, json=body).status_code == 403
    for invalid in (
        {**body, "sec_id": "manual-label"},
        {**body, "origins": ["https://example.com/path"]},
        {**body, "origins": body["origins"] * 2},
        {**body, "origins": ["https://example.com"] * 17},
        {**body, "password": "CANARY_PRIVATE"},
    ):
        response = client.post(path, headers=headers, json=invalid)
        assert response.status_code == 422 and "CANARY_PRIVATE" not in response.text
    assert (
        client.post(
            "/api/one/pod/config",
            headers=headers,
            json={"changes": {"session_only_lockdown": True}},
        ).status_code
        == 200
    )
    cleanup.close()
    install_session_cleanup(
        app, log=pod["log"], dek=DEK, logger=pod_session.logger, admission=admission
    )
    assert app.state.browser_session_cleanup is not cleanup
    delete = pod["objects"].delete
    attempts = []

    async def maybe_delete(object_key):
        attempts.append(object_key)
        if delete_fault and len(attempts) == 1:
            raise RuntimeError("synthetic deletion failure")
        await delete(object_key)

    monkeypatch.setattr(pod["objects"], "delete", maybe_delete)
    response = client.post(path, headers=headers, json=body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store, private"
    assert response.json() == {
        "fenced": True,
        "persisted": True,
        "deletion_requested": not delete_fault,
        "physical_deletion": "subject_to_cloud_retention",
        "remote_logout": False,
    }
    if delete_fault:
        assert await pod["objects"].get(saved.object_key) == ciphertext
    retried = client.post(path, headers=headers, json=body)
    assert retried.status_code == 200 and retried.json()["deletion_requested"]
    assert await pod["objects"].get(saved.object_key) is None
    records = await pod["log"].replay()
    assert (
        len(
            [
                record
                for record in records
                if record["kind"] == "browser_session_v1"
                and record["payload"]["operation"] == "forget"
            ]
        )
        == 1
    )
    assert not hasattr(app.state, "browser_task_runtime")
    assert all(state.active == 0 for state in admission._states.values())


@pytest.mark.parametrize("change", ["revoke", "epoch", "incarnation"])
async def test_owner_forget_rechecks_authority_after_inventory_await_before_tombstone(
    pod, monkeypatch, change
):
    import asyncio
    from dataclasses import replace

    from httpx import ASGITransport, AsyncClient

    from api.routes.one import pod_browser

    _, _, saved, admission, body = await _owner_session_cleanup_fixture(pod, monkeypatch)
    subject = Subject("tdv_erase_current", "web")
    owner = _admit(pod["client"], subject)
    entered, release = asyncio.Event(), asyncio.Event()
    fold = pod["log"].fold_since

    async def pause(*args, **kwargs):
        result = await fold(*args, **kwargs)
        entered.set()
        await release.wait()
        return result

    monkeypatch.setattr(pod["log"], "fold_since", pause)
    async with AsyncClient(
        transport=ASGITransport(app=pod["client"].app), base_url="https://pod"
    ) as client:
        work = asyncio.create_task(
            client.post("/api/one/pod/browser/sessions/forget", headers=_auth(owner), json=body)
        )
        try:
            await asyncio.wait_for(entered.wait(), 2)
            if change == "revoke":
                await pod["authority"].revoke_subject(subject.subject_id)
            elif change == "epoch":
                lease = pod["authority"].lease
                monkeypatch.setattr(
                    lease, "_incarnation", replace(lease.incarnation, epoch=lease.epoch + 1)
                )
            else:
                monkeypatch.setattr(pod_browser, "pod_incarnation", lambda: "replacement")
            release.set()
            response = await asyncio.wait_for(work, 2)
            assert response.status_code == 403
            assert response.json()["detail"]["code"] == "BROWSER_OWNER_REFUSED"
            assert await pod["objects"].get(saved.object_key) is not None
            assert not any(
                record["kind"] == "browser_session_v1"
                and record["payload"]["operation"] == "forget"
                for record in await pod["log"].replay()
            )
            assert all(state.active == 0 for state in admission._states.values())
        finally:
            release.set()
            await asyncio.gather(work, return_exceptions=True)


@pytest.mark.parametrize("overlap", [False, True])
async def test_owner_forget_fences_new_task_restore_until_erasure_finishes(
    pod, monkeypatch, overlap
):
    import asyncio

    from httpx import ASGITransport, AsyncClient
    from starlette.requests import Request

    from api.routes.one import pod_browser
    from hushh_mcp.services.pod_browser.sessions import BrowserSessions
    from tests.helpers.pod_browser import (
        _remembered,
        approved_task,
        readiness,
        task_runtime_fixture,
    )

    cleanup, _, saved, _, body = await _owner_session_cleanup_fixture(pod, monkeypatch)
    if not overlap:
        body["origins"].append("https://second.example")
    app = pod["client"].app
    admitted = _admit(pod["client"], Subject("tdv_erase_restore", "web"))
    headers = _auth(admitted)
    path = "/api/one/pod/browser/sessions/forget"
    access = await pod_browser.owner_access(
        Request({"type": "http", "app": app, "path": path, "headers": []}),
        headers["Authorization"],
        psa.SCOPE_BROWSER_CONTROL,
        bind_runtime=False,
    )
    fixture = task_runtime_fixture(monkeypatch, log=pod["log"])
    runtime = fixture.runtime
    runtime._owner, runtime._pod, runtime._incarnation = USER, OWNER, access.incarnation
    runtime._public_research_only = False
    runtime._session_mutations = cleanup.mutations
    fixture.owner = access
    fixture.request = fixture.request.model_copy(update={"allowed_origins": tuple(body["origins"])})

    async def check_binding(_):
        await access.check()

    monkeypatch.setattr(fixture.auth, "check_binding", check_binding)
    imported = []

    async def install(state, _origins):
        imported.append(state)

    monkeypatch.setattr(fixture.driver, "import_session", install, raising=False)
    runtime._sessions_factory = lambda consent: BrowserSessions(
        owner_id=USER,
        store=pod["objects"],
        log=pod["log"],
        custody_key=cleanup._key,
        consent=consent,
        readiness=readiness(),
        fence_live_contexts=runtime.fence_live_contexts,
        clock=lambda: 1000,
        mutations=cleanup.mutations,
    )
    app.state.browser_task_runtime = runtime
    fenced = [asyncio.Event(), asyncio.Event()]
    release = [asyncio.Event(), asyncio.Event()]
    close_calls = 0
    close_contexts = runtime.fence_live_contexts

    async def pause_after_close(site):
        nonlocal close_calls
        index = close_calls
        close_calls += 1
        await close_contexts(site)
        if index < (2 if overlap else 1):
            fenced[index].set()
            await release[index].wait()

    monkeypatch.setattr(runtime, "fence_live_contexts", pause_after_close)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://pod") as client:
        erasing = asyncio.create_task(client.post(path, headers=headers, json=body))
        overlapping = None
        try:
            await asyncio.wait_for(fenced[0].wait(), 2)
            if overlap:
                overlapping = asyncio.create_task(client.post(path, headers=headers, json=body))
                await asyncio.wait_for(fenced[1].wait(), 2)
            # A newly admitted public task remains usable while erasure closes
            # the prior context. Its new session port must share the fence.
            snapshot = await asyncio.wait_for(approved_task(fixture), 3)
            task = runtime._tasks[snapshot.binding.task_id]
            await asyncio.wait_for(
                runtime.control(access, task.binding.task_id, "takeover", snapshot.control_epoch), 3
            )
            site = task.sessions.site_id(body["origins"][0], body["sec_id"])
            terms = {
                "site": site,
                "generation": saved.generation,
                "object": saved.object_key,
                "digest": saved.digest,
                "origins": [body["origins"][0]],
            }
            fixture.reviews.grants.add(
                fixture.reviews.identity(task.binding, "session_restore", terms)
            )
            for origin in body["origins"]:
                with pytest.raises(pod_browser.BrowserRefused, match="FORGET_PENDING"):
                    await asyncio.wait_for(
                        runtime.session(
                            access, task.binding.task_id, "restore", origin, body["sec_id"]
                        ),
                        3,
                    )
            with pytest.raises(pod_browser.BrowserRefused, match="FORGET_PENDING"):
                await runtime.session(
                    access, task.binding.task_id, "remember", body["origins"][0], body["sec_id"]
                )
            assert not imported
            release[0].set()
            receipt = await asyncio.wait_for(erasing, 2)
            assert receipt.status_code == 200 and receipt.json()["fenced"]
            assert await pod["objects"].get(saved.object_key) is None
            if overlapping is not None:
                assert not overlapping.done()
                with pytest.raises(pod_browser.BrowserRefused, match="FORGET_PENDING"):
                    await runtime.session(
                        access, task.binding.task_id, "restore", body["origins"][0], body["sec_id"]
                    )
                release[1].set()
                second_receipt = await asyncio.wait_for(overlapping, 2)
                assert second_receipt.status_code == 200 and second_receipt.json()["fenced"]
            # Completion releases the temporary fence; an explicit new save
            # and review can create a new generation without a permanent drain.
            if task.closed:
                fixture.request = fixture.request.model_copy(update={"request_id": "new_request"})
                fixture.model.entered.clear()
                launches = fixture.launcher.calls
                snapshot = await runtime.start(access, fixture.request)
                await runtime._tasks[snapshot.binding.task_id].worker
                snapshot = await runtime.read(access, snapshot.binding.task_id)
                assert snapshot.phase == "needs_owner" and fixture.launcher.calls == launches
                await runtime.confirm_review(
                    access,
                    snapshot.binding.task_id,
                    snapshot.review.review_id,
                    "synthetic-owner-receipt-" + "x" * 32,
                )
                await asyncio.wait_for(fixture.model.entered.wait(), 3)
                assert fixture.launcher.calls == launches + 1
                snapshot = await runtime.read(access, snapshot.binding.task_id)
                task = runtime._tasks[snapshot.binding.task_id]
                await runtime.control(
                    access, task.binding.task_id, "takeover", snapshot.control_epoch
                )
            state = _remembered()
            remember_terms = {
                "site": site,
                "generation": 1,
                "origins": [body["origins"][0]],
                "state": state.model_dump(mode="json"),
            }
            fixture.reviews.grants.add(
                fixture.reviews.identity(task.binding, "session_remember", remember_terms)
            )
            current = await task.sessions.remember(
                task.binding, site, state, approved_origins=frozenset({body["origins"][0]})
            )
            assert current.generation == 1 and current.object_key != saved.object_key
        finally:
            for event in release:
                event.set()
            await asyncio.gather(
                erasing, *([overlapping] if overlapping is not None else []), return_exceptions=True
            )
            await asyncio.wait_for(runtime.drain(), 3)


# -- revocation -----------------------------------------------------------------------


def test_the_owner_revokes_a_device_at_the_pod_and_its_session_dies(pod):
    client = pod["client"]
    owner = _admit(client, Subject("tdv_web_1", "web"))
    device = _admit(client, Subject("tdv_mac_1", "macos"))
    response = client.post(
        "/api/one/pod/session/revoke", json={"subjectId": "tdv_mac_1"}, headers=_auth(owner)
    )
    assert response.status_code == 200
    assert response.json() == {"revoked": True, "subjectId": "tdv_mac_1", "atVersion": 1}
    renew = client.post("/api/one/pod/session/renew", headers=_auth(device))
    assert renew.status_code == 403
    assert renew.json()["detail"]["code"] == "revoked"
    status = client.get("/api/one/pod/status", headers=_auth(owner)).json()
    assert {s["subjectId"]: s["state"] for s in status["subjects"]}["tdv_mac_1"] == "revoked"


def test_the_wall_passes_the_app_surface_and_walls_the_rest(pod):
    client = pod["client"]
    assert client.get("/api/one/pod/status").status_code == 401  # the route answered
    assert client.get("/pod/info").status_code == 404  # the wall answered


async def test_private_chat_recovers_with_owner_key_and_refuses_device_or_other_owner(pod):
    from google.adk.events import Event
    from google.genai import types

    from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.services.chat_key import RequestChatKey, bind_request_chat_key

    client = pod["client"]
    app = _admit(client, Subject("tdv_chat_app", "web"))
    device = _admit(client, Subject("tdv_chat_device", "macos"))
    authorization = f"Bearer {app['session']}"
    with bind_request_chat_key(RequestChatKey(b"c" * 32)):
        owner = PodChatContext(authorization)
        session = await owner.sessions.create_session(
            app_name=ONE_APP_NAME, user_id=USER, session_id="synthetic-chat"
        )
        await owner.sessions.append_event(
            session,
            Event(
                author="user",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="Synthetic private note")],
                ),
            ),
        )
    headers = {"Authorization": authorization, "X-Hussh-Chat-Key": "hck1." + (b"c" * 32).hex()}
    path = "/api/one/pod/agent-chat/history/synthetic-chat"
    response = client.get(path, headers=headers)
    assert response.status_code == 200, response.text
    assert "Synthetic private note" in response.text
    # A cold request has its own key lifetime. Neither the previous session nor
    # the ciphertext cache can authorize a locked, wrong-key or device request.
    assert client.get(path, headers={"Authorization": authorization}).status_code == 403
    assert (
        client.get(
            path, headers={**headers, "X-Hussh-Chat-Key": "hck1." + (b"x" * 32).hex()}
        ).status_code
        == 403
    )
    assert (
        client.get(
            path, headers={**headers, "Authorization": f"Bearer {device['session']}"}
        ).status_code
        == 403
    )
    assert (
        client.get(
            "/api/one/pod/agent-chat/conversations/another-owner", headers=headers
        ).status_code
        == 403
    )
    assert (
        client.get(
            "/api/one/pod/agent-chat/history/synthetic-chat/admin", headers=headers
        ).status_code
        == 404
    )
    assert client.get(path, headers=headers).status_code == 200
