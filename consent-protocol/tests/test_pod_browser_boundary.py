"""Core native browser boundaries; no claim of cloud isolation from fakes."""

import asyncio
import os

import pytest

from hushh_mcp.services.pod_browser.contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserNetworkPermit,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.network import (
    BrowserNetworkBroker,
    BrowserRequest,
    public_origin,
)
from tests.helpers.pod_browser import (
    Authority,
    Executor,
    approved_task,
    binding,
    control,
    readiness,
    task_runtime_fixture,
)


def test_worker_privilege_drop_refuses_retained_authority_before_private_scratch(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import worker_identity as worker

    ids = {"uid": (0, 0, 0), "gid": (0, 0, 0)}
    environment = {}
    capability = "0"
    native = SimpleNamespace(
        geteuid=lambda: ids["uid"][1],
        getgroups=lambda: [],
        setresuid=lambda *values: ids.update(uid=values),
        setresgid=lambda *values: ids.update(gid=values),
        getresuid=lambda: ids["uid"],
        getresgid=lambda: ids["gid"],
        environ=environment,
    )
    monkeypatch.setattr(worker, "os", native)
    monkeypatch.setattr(worker, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(
        worker,
        "ctypes",
        SimpleNamespace(CDLL=lambda *_args, **_kw: SimpleNamespace(prctl=lambda *_: 0)),
    )
    monkeypatch.setattr(
        worker,
        "Path",
        lambda _: SimpleNamespace(
            read_text=lambda: f"NoNewPrivs: 1\nCapPrm: 0\nCapEff: {capability}\nCapAmb: 0"
        ),
    )
    monkeypatch.setattr(worker, "MemoryScratch", lambda: SimpleNamespace(path="private-scratch"))
    worker.prepare_worker_identity()
    assert ids == {"uid": (10002, 10002, 10002), "gid": (10002, 10002, 10002)}
    assert environment["HOME"] == "private-scratch"

    capability = "1"
    environment.clear()
    with pytest.raises(BrowserRefused, match="WORKER_IDENTITY_REFUSED"):
        worker.prepare_worker_identity()
    assert not environment  # no browser/home initialization under retained authority


@pytest.mark.parametrize(
    "gate",
    [
        "isolated",
        "direct_egress_denied",
        "broker_bridge_verified",
        "ephemeral_bridge_verified",
        "private_access_denied",
        "model_transport_verified",
    ],
)
async def test_unverified_substrate_never_initializes_browser(gate):
    driver = Executor()
    with pytest.raises(BrowserRefused, match="ISOLATION_NOT_READY"):
        await control(ready=readiness(**{gate: False}), driver=driver).initialize()
    assert driver.calls == []
    await control(driver=driver).initialize()  # positive control
    assert driver.calls == ["initialize"]


@pytest.mark.parametrize(
    "change", [{"owner_id": "other"}, {"incarnation": "old"}, {"expires_at": 999}]
)
async def test_owner_incarnation_and_expiry_before_initialization(change):
    driver = Executor()
    values = binding().model_dump() | change
    with pytest.raises(BrowserRefused):
        await control(driver=driver, bound=BrowserBinding(**values)).initialize()
    assert driver.calls == []


async def test_browser_task_unqualified_owner_and_replayed_request_are_refused(monkeypatch):
    from dataclasses import replace

    fixture = task_runtime_fixture(monkeypatch, ready=readiness(private_access_denied=False))
    with pytest.raises(BrowserRefused, match="ISOLATION_NOT_READY"):
        await fixture.runtime.start(fixture.owner, fixture.request)
    assert fixture.launcher.calls == 0 and not fixture.log.records
    fixture = task_runtime_fixture(monkeypatch)
    with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
        await fixture.runtime.start(replace(fixture.owner, owner_id="other"), fixture.request)
    snapshot = await approved_task(fixture)  # positive control
    assert (await fixture.runtime.start(fixture.owner, fixture.request)).binding == snapshot.binding
    changed = fixture.request.model_copy(update={"goal": "A different request"})
    with pytest.raises(BrowserRefused, match="REQUEST_CONFLICT"):
        await fixture.runtime.start(fixture.owner, changed)
    await fixture.runtime.drain()


async def test_browser_preallocation_cancel_and_unconfirmed_close_hold_update_permit(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    started = await fixture.runtime.start(fixture.owner, fixture.request)
    await fixture.runtime._tasks[started.binding.task_id].worker
    pending = await fixture.runtime.read(fixture.owner, started.binding.task_id)
    assert pending.review is not None and not pending.approved_origins
    cancelled = await fixture.runtime.control(
        fixture.owner, started.binding.task_id, "cancel", pending.control_epoch
    )
    assert cancelled.phase == "cancelled" and cancelled.control_owner == "stopped"
    assert cancelled.revision > pending.revision and fixture.launcher.calls == 0
    assert fixture.admission._states["epoch"].active == 0

    fixture = task_runtime_fixture(monkeypatch)
    snapshot = await approved_task(fixture)
    assert snapshot.approved_origins == fixture.request.allowed_origins
    assert "https://example.com" not in str(fixture.log.records)

    async def failed_close():
        raise OSError("synthetic close failure")

    monkeypatch.setattr(fixture.driver, "close", failed_close)
    with pytest.raises(BrowserRefused, match="CLOSE_UNCONFIRMED"):
        await fixture.runtime.drain()
    assert fixture.admission._states["epoch"].active == 1
    failed = await fixture.runtime.read(fixture.owner, snapshot.binding.task_id)
    assert failed.phase == "unavailable" and failed.code == "BROWSER_CLOSE_UNCONFIRMED"
    # Finish the fixture after proving that close failure retained the permit.
    monkeypatch.setattr(fixture.driver, "close", Executor.close.__get__(fixture.driver))
    await fixture.runtime.drain()

    fixture = task_runtime_fixture(monkeypatch)

    async def unconfirmed_model_stop(**_args):
        raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED")

    monkeypatch.setattr(fixture.model, "run", unconfirmed_model_stop)
    pending = await fixture.runtime.start(fixture.owner, fixture.request)
    task = fixture.runtime._tasks[pending.binding.task_id]
    await task.worker
    pending = await fixture.runtime.read(fixture.owner, pending.binding.task_id)
    await fixture.runtime.confirm_review(
        fixture.owner, pending.binding.task_id, pending.review.review_id
    )
    with pytest.raises(BrowserRefused, match="MODEL_STOP_UNCONFIRMED"):
        await task.worker
    assert fixture.admission._states["epoch"].active == 1
    with pytest.raises(BrowserRefused, match="MODEL_STOP_UNCONFIRMED"):
        await fixture.runtime.drain()  # browser close alone cannot prove model shutdown
    failed = await fixture.runtime.read(fixture.owner, pending.binding.task_id)
    assert failed.phase == "unavailable" and failed.code == "BROWSER_MODEL_STOP_UNCONFIRMED"
    task.monitor.cancel()  # fixture keeps the permit held intentionally


async def test_browser_one_roster_requires_qualified_runtime_and_current_app_scope(monkeypatch):
    from types import SimpleNamespace

    from fastapi import HTTPException

    from api.routes.one import pod_session
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.one_adk.computer_use_agent import browser_task_hand_available, start_browser_task
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.services import pod_upgrade_admission

    fixture = task_runtime_fixture(monkeypatch)
    context = PodChatContext.__new__(PodChatContext)
    context.owner, context.hushh_id = "owner", "pod"
    context.authorization, context._browser_incarnation = "Bearer owner", "epoch"
    context.authority = SimpleNamespace(environment="dev")
    context.claims = {"scopes": [], "exp": 1900}
    context.browser_runtime = fixture.runtime

    async def access():
        return None

    context.require_access = access
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_upgrade_admission, "pod_incarnation", lambda: "epoch")
    monkeypatch.setattr(
        pod_session, "verified_session", lambda *_args, **_kw: (context.authority, context.claims)
    )
    with context._browser_scope():
        assert not browser_task_hand_available()  # flag alone and PKM scope are insufficient
        assert start_browser_task not in agent_tree._one_roster_tools(specialist_model="test-model")
    context.claims["scopes"] = ["browser.invoke"]
    with context._browser_scope():
        assert browser_task_hand_available()
        assert start_browser_task in agent_tree._one_roster_tools(specialist_model="test-model")
        await context._browser_access()
        monkeypatch.setattr(pod_upgrade_admission, "pod_incarnation", lambda: "changed")
        with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
            await context._browser_access()
    monkeypatch.setattr(pod_upgrade_admission, "pod_incarnation", lambda: "epoch")

    def revoked(*_args, **_kw):
        raise HTTPException(403, detail={"code": "revoked"})

    monkeypatch.setattr(pod_session, "verified_session", revoked)
    with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
        await context._browser_access()
    context.browser_runtime = task_runtime_fixture(
        monkeypatch, ready=readiness(private_access_denied=False)
    ).runtime
    with context._browser_scope():
        assert not browser_task_hand_available()  # an injected runtime must still qualify
    assert fixture.launcher.calls == 0


async def test_browser_task_owner_takeover_preview_resume_cancel_and_update_permit(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    snapshot = await approved_task(fixture)
    task_id = snapshot.binding.task_id
    stale = BrowserAction(
        operation="click",
        sequence=snapshot.next_sequence,
        control_epoch=snapshot.control_epoch,
        x=1,
        y=1,
    )
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await fixture.runtime.input(fixture.owner, task_id, stale)
    taken = await fixture.runtime.control(
        fixture.owner, task_id, "takeover", snapshot.control_epoch
    )
    assert taken.control_owner == "owner" and taken.phase == "needs_owner"
    for _ in range(2):
        preview, frame = await fixture.runtime.frame(fixture.owner, task_id)
        assert (
            preview.next_sequence == taken.next_sequence and frame.sequence < preview.next_sequence
        )
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await fixture.runtime.input(fixture.owner, task_id, stale)
    current = await fixture.runtime.input(
        fixture.owner,
        task_id,
        BrowserAction(
            operation="type",
            sequence=taken.next_sequence,
            control_epoch=taken.control_epoch,
            x=10,
            y=10,
            text="owner-secret",
            press_enter=False,
        ),
    )
    assert current.next_sequence == taken.next_sequence + 1
    assert current.revision > taken.revision
    resumed = await fixture.runtime.control(fixture.owner, task_id, "resume", current.control_epoch)
    assert resumed.control_owner == "agent" and resumed.control_epoch > current.control_epoch
    await asyncio.sleep(0)
    cancelled = await fixture.runtime.control(
        fixture.owner, task_id, "cancel", resumed.control_epoch
    )
    assert cancelled.phase == "cancelled" and fixture.driver.calls[-1] == "close"
    assert fixture.admission._states["epoch"].active == 0
    with pytest.raises(BrowserRefused, match="FRAME_UNAVAILABLE"):
        await fixture.runtime.frame(fixture.owner, task_id)
    serialized = str(fixture.log.records)
    assert "owner-secret" not in serialized and "PNG" not in serialized
    assert "selected page" not in serialized and "screen_processing" not in serialized


async def test_browser_task_uncertain_effect_and_recovery_never_redispatch(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    snapshot = await approved_task(fixture)
    task_id = snapshot.binding.task_id
    taken = await fixture.runtime.control(
        fixture.owner, task_id, "takeover", snapshot.control_epoch
    )
    fixture.driver.fail = True
    action = BrowserAction(
        operation="click", sequence=taken.next_sequence, control_epoch=taken.control_epoch, x=1, y=1
    )
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNAVAILABLE"):
        await fixture.runtime.input(fixture.owner, task_id, action)
    state = await fixture.runtime.read(fixture.owner, task_id)
    assert state.phase == "outcome_uncertain"
    assert fixture.auth.journal == [(action.sequence, "dispatch"), (action.sequence, "uncertain")]
    with pytest.raises(BrowserRefused, match="CONTROL_UNAVAILABLE"):
        await fixture.runtime.input(fixture.owner, task_id, action)
    recovered = task_runtime_fixture(monkeypatch, log=fixture.log)
    state = await recovered.runtime.read(recovered.owner, task_id)
    assert state.phase == "outcome_uncertain" and state.control_owner == "stopped"
    with pytest.raises(BrowserRefused, match="RECOVERY_REQUIRES_OWNER"):
        await recovered.runtime.start(recovered.owner, recovered.request)
    assert recovered.launcher.calls == 0


async def test_browser_routes_default_closed_and_input_validation_never_echoes_secrets(monkeypatch):
    from types import SimpleNamespace

    from fastapi import FastAPI, HTTPException
    from httpx import ASGITransport, AsyncClient

    from api.routes.one import pod_browser

    async def held():
        return None

    authority = SimpleNamespace(environment="development", require_held=held)
    scopes = {"browser.invoke", "browser.observe", "browser.control"}

    def verified(authorization, *, role, scope):
        if authorization != "Bearer owner-session" or scope not in scopes:
            raise HTTPException(403, detail={"code": "role_mismatch"})
        return authority, {"user_id": "owner", "hushh_id": "pod", "exp": 1900}

    monkeypatch.setattr(pod_browser, "verified_session", verified)
    monkeypatch.setattr(pod_browser, "pod_incarnation", lambda: "epoch")
    app = FastAPI()
    app.include_router(pod_browser.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://pod") as client:
        path = "/api/one/pod/browser"
        headers = {"Authorization": "Bearer owner-session"}
        denied = await client.get(
            path + "/capability", headers={"Authorization": "Bearer device-session"}
        )
        assert denied.status_code == 403
        capability = await client.get(path + "/capability", headers=headers)
        assert capability.json() == {
            "available": False,
            "code": "BROWSER_CLOUD_GATE_UNAVAILABLE",
            "remembered_sessions_available": False,
            "owner_id": "owner",
            "pod_id": "pod",
            "incarnation": "epoch",
            "environment": "development",
        }
        refused = await client.post(
            path + "/tasks",
            headers=headers,
            json={
                "request_id": "request_1",
                "goal": "private goal",
                "allowed_origins": ["https://example.com"],
            },
        )
        assert refused.status_code == 503
        invalid = await client.post(
            path + "/tasks/task/input",
            headers={**headers, "X-Browser-Pod-Incarnation": "epoch"},
            json={
                "operation": "type",
                "sequence": 1,
                "control_epoch": 1,
                "x": "owner-password",
                "y": 1,
                "text": "owner-secret",
            },
        )
        assert invalid.status_code == 422
        assert "owner-password" not in invalid.text and "owner-secret" not in invalid.text
        fixture = task_runtime_fixture(monkeypatch)
        app.state.browser_task_runtime = fixture.runtime
        accepted = await client.post(
            path + "/tasks",
            headers=headers,
            json={
                "request_id": "request_1",
                "goal": "Review a public page.",
                "allowed_origins": ["https://example.com"],
                "fields": [],
            },
        )
        assert accepted.status_code == 202
        task_id = accepted.json()["binding"]["task_id"]
        await fixture.runtime._tasks[task_id].worker
        pinned = {**headers, "X-Browser-Pod-Incarnation": "epoch"}
        status = await client.get(path + "/tasks/" + task_id, headers=pinned)
        approved = await client.post(
            path + "/tasks/" + task_id + "/review",
            headers=pinned,
            json={"review_id": status.json()["review"]["review_id"]},
        )
        assert approved.status_code == 200
        await asyncio.wait_for(fixture.model.entered.wait(), 2)
        preview = await client.get(path + "/tasks/" + task_id + "/frame", headers=pinned)
        assert preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert preview.headers["x-browser-task-id"] == task_id
        assert preview.headers["x-browser-pod-incarnation"] == "epoch"
        assert preview.headers["cache-control"] == "no-store, private"
        switched = await client.get(
            path + "/tasks/" + task_id + "/frame",
            headers={**headers, "X-Browser-Pod-Incarnation": "other"},
        )
        assert switched.status_code == 409
        snapshot = await client.get(path + "/tasks/" + task_id, headers=pinned)
        taken = await client.post(
            path + "/tasks/" + task_id + "/control",
            headers=pinned,
            json={"operation": "takeover", "control_epoch": snapshot.json()["control_epoch"]},
        )
        manual = await client.post(
            path + "/tasks/" + task_id + "/input",
            headers=pinned,
            json={
                "operation": "keys",
                "sequence": taken.json()["next_sequence"],
                "control_epoch": taken.json()["control_epoch"],
                "keys": ["Tab"],
            },
        )
        assert manual.status_code == 200  # JSON arrays become the strict tuple execution contract
        await fixture.runtime.drain()


async def test_browser_one_hand_metadata_only_and_cancellation_preserves_uncertain_effect(
    monkeypatch,
):
    from hushh_mcp.one_adk.computer_use_agent import (
        browser_task_hand_available,
        browser_task_invocation,
        start_browser_task,
    )

    fixture = task_runtime_fixture(monkeypatch)
    assert not browser_task_hand_available()
    assert (await start_browser_task("request_1", "task", ["https://example.com"]))[
        "status"
    ] == "unavailable"
    with browser_task_invocation(fixture.runtime, fixture.owner):
        assert browser_task_hand_available()
        receipt = await start_browser_task(
            "request_1", "Open the selected page.", ["https://example.com"]
        )
        assert receipt["status"] == "accepted"
        assert not ({"summary", "review", "terms", "goal", "fields", "png"} & set(receipt))
    snapshot = await approved_task(fixture)
    task_id = snapshot.binding.task_id
    # Simulate an agent dispatch whose response is lost when the owner cancels.
    fixture.driver.entered.clear()
    fixture.driver.release = asyncio.Event()
    task = fixture.runtime._tasks[task_id]
    await fixture.runtime.control(fixture.owner, task_id, "takeover", snapshot.control_epoch)
    entered = task.control.control_epoch
    dispatch = asyncio.create_task(
        fixture.runtime.input(
            fixture.owner,
            task_id,
            BrowserAction(
                operation="click",
                sequence=task.control.next_sequence,
                control_epoch=entered,
                x=1,
                y=1,
            ),
        )
    )
    await asyncio.wait_for(fixture.driver.entered.wait(), 2)
    # Control stop fences immediately and terminates native bridge out of band.
    closing = asyncio.create_task(task.control.stop())
    await asyncio.sleep(0)
    fixture.driver.release.set()
    await closing
    with pytest.raises(BrowserRefused, match="STOPPED"):
        await dispatch
    state = await fixture.runtime.read(fixture.owner, task_id)
    assert state.phase == "outcome_uncertain"
    assert fixture.auth.journal[-1][1] == "uncertain"
    await fixture.runtime.drain()


async def test_typing_requires_approval_even_without_enter_and_never_replays_uncertain_effect():
    authority, driver = Authority(), Executor()
    runtime = control(auth=authority, driver=driver)
    await runtime.initialize()
    action = BrowserAction(
        operation="type", sequence=1, control_epoch=1, x=1, y=1, text="synthetic", press_enter=False
    )
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await runtime.execute(action)
    assert driver.calls == ["initialize"]
    authority.approved = True
    driver.fail = True
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNAVAILABLE"):
        await runtime.execute(action)
    with pytest.raises(BrowserRefused, match="UNCERTAIN"):
        await runtime.execute(action)
    assert driver.calls == ["initialize", "type"]
    assert authority.journal == [(1, "dispatch"), (1, "uncertain")]


async def test_takeover_waits_for_current_dispatch_and_fences_old_actions_and_observations():
    driver = Executor(release=asyncio.Event())
    runtime = control(driver=driver)
    await runtime.initialize()
    active = asyncio.create_task(
        runtime.execute(BrowserAction(operation="observe", sequence=1, control_epoch=1))
    )
    await driver.entered.wait()
    takeover = asyncio.create_task(runtime.take_control())
    await asyncio.sleep(0)
    assert not takeover.done()
    driver.release.set()
    await active
    assert await takeover == 2
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await runtime.execute(BrowserAction(operation="observe", sequence=2, control_epoch=1))
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await runtime.execute(BrowserAction(operation="observe", sequence=2, control_epoch=2))
    await runtime.execute(
        BrowserAction(operation="observe", sequence=2, control_epoch=2), actor="owner"
    )
    await runtime.resume_agent()
    assert runtime.control_epoch == 3
    await runtime.execute(BrowserAction(operation="observe", sequence=4, control_epoch=3))


async def test_revocation_and_action_limit_before_dispatch():
    auth, driver = Authority(), Executor()
    runtime = control(auth=auth, driver=driver)
    await runtime.initialize()
    for seq in range(1, 61):
        await runtime.execute(BrowserAction(operation="observe", sequence=seq, control_epoch=1))
    with pytest.raises(BrowserRefused, match="CONTINUATION_REQUIRED"):
        await runtime.execute(BrowserAction(operation="observe", sequence=61, control_epoch=1))
    auth.revoked = True
    with pytest.raises(BrowserRefused, match="BINDING_REFUSED"):
        await runtime.take_control()
    assert len(driver.calls) == 61


async def test_idle_preview_does_not_refresh_activity():
    tick = [1000]
    driver = Executor()
    runtime = control(driver=driver, clock=lambda: tick[0])
    await runtime.initialize()
    tick[0] += 599
    assert not await runtime.close_if_idle()
    tick[0] += 1
    assert await runtime.close_if_idle()
    assert driver.calls == ["initialize", "close"]


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://[::1]",
        "https://example.com\\@169.254.169.254/",
        "https://user:pass@example.com",
        "https://example.com:8443",
        "file:///etc/passwd",
        "https://metadata.google.internal",
    ],
)
def test_browser_origin_blocks_private_and_alternate_transports(url):
    with pytest.raises(BrowserRefused, match="DESTINATION_REFUSED"):
        public_origin(url)
    assert public_origin("https://example.com/search?q=synthetic") == "https://example.com"


async def test_broker_blocks_undeclared_subresources_and_routes_before_any_socket():
    auth = Authority()
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )
    try:
        with pytest.raises(BrowserRefused, match="DESTINATION_REFUSED"):
            await broker.fetch(BrowserRequest(url="https://other.com/resource", method="GET"))
        with pytest.raises(BrowserRefused, match="HEADERS_REFUSED"):
            await broker.fetch(
                BrowserRequest(
                    url="https://example.com/",
                    method="GET",
                    headers=(("Host", "metadata.google.internal"),),
                )
            )
        with pytest.raises(BrowserRefused, match="HEADERS_REFUSED"):
            await broker.fetch(
                BrowserRequest(
                    url="https://example.com/",
                    method="POST",
                    headers=(("Cookie", "approved"), ("cookie", "changed")),
                )
            )
        with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
            await broker.fetch(BrowserRequest(url="https://example.com/", method="GET"))
    finally:
        await broker.close()


def test_network_commitment_covers_autosave_bytes_destination_and_cookies():
    request = BrowserRequest(
        url="https://example.com/autosave",
        method="POST",
        body=b"synthetic",
        headers=(("Cookie", "synthetic-session"),),
    )
    original = request.commitment()
    for change in ({"body": b"changed"}, {"url": "https://example.com/send"}, {"headers": ()}):
        assert request.model_copy(update=change).commitment() != original


@pytest.mark.parametrize(
    "url", ["javascript:alert(1)", "data:text/html,synthetic", "file:///etc/passwd"]
)
async def test_navigation_rejects_non_network_protocols_before_driver(url):
    driver = Executor()
    runtime = control(driver=driver)
    await runtime.initialize()
    with pytest.raises(BrowserRefused, match="DESTINATION_REFUSED"):
        await runtime.execute(
            BrowserAction(operation="navigate", sequence=1, control_epoch=1, url=url)
        )
    assert driver.calls == ["initialize"]


async def test_worker_frame_mismatch_never_settles_effect_as_success():
    class WrongFrame(Executor):
        async def execute(self, action):
            return (await super().execute(action)).model_copy(update={"sequence": 99})

    auth = Authority(approved=True)
    runtime = control(auth=auth, driver=WrongFrame())
    await runtime.initialize()
    with pytest.raises(BrowserRefused, match="FRAME_MISMATCH"):
        await runtime.execute(
            BrowserAction(operation="click", sequence=1, control_epoch=1, x=1, y=1)
        )
    assert auth.journal == [(1, "dispatch"), (1, "uncertain")]


@pytest.mark.parametrize("kind", ["fifo", "symlink"])
def test_mailbox_rejects_non_regular_files_without_waiting_for_a_writer(tmp_path, kind):
    from hushh_mcp.services.pod_browser.mailbox import BrowserMailbox

    os.chmod(tmp_path, 0o700)
    target = tmp_path / "command-request.json"
    if kind == "fifo":
        os.mkfifo(target)
    else:
        target.symlink_to(tmp_path / "other")
    box = BrowserMailbox(tmp_path, lane="command")
    try:
        with pytest.raises(BrowserRefused, match="BRIDGE_INVALID"):
            box.receive(None)
    finally:
        box.close()


async def test_mailbox_roundtrip_and_stale_response_not_accepted(tmp_path):
    from hushh_mcp.services.pod_browser.mailbox import BrowserMailbox

    os.chmod(tmp_path, 0o700)
    sender = BrowserMailbox(tmp_path, lane="command")
    receiver = BrowserMailbox(tmp_path, lane="command")
    try:
        receiver.reply("0" * 32, {"stale": True})
        call = asyncio.create_task(sender.exchange({"synthetic": True}))
        await asyncio.sleep(0)
        message_id, payload = receiver.receive(None)
        assert payload == {"synthetic": True}
        assert not call.done()
        receiver.reply(message_id, {"accepted": True})
        assert await call == {"accepted": True}
    finally:
        receiver.close()
        sender.close()


async def test_lost_http_effect_is_sticky_uncertain_and_cannot_be_hidden_by_a_screenshot():
    from hushh_mcp.services.pod_browser.playwright_executor import SandboxedPlaywrightExecutor

    class NetworkAuthority(Authority):
        async def authorize_request(self, value, request, commitment):
            await self.check_binding(value)
            return BrowserNetworkPermit(effect_receipt_required=True)

        async def journal_dispatch(self, value, request, commitment):
            self.journal.append("dispatch")

        async def settle_dispatch(self, value, request, commitment, *, uncertain):
            self.journal.append("uncertain" if uncertain else "settled")

    class LostResponse:
        calls = 0

        async def handle_async_request(self, request):
            self.calls += 1
            raise TimeoutError()

        async def aclose(self):
            pass

    auth = NetworkAuthority()
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )
    await broker._pool.aclose()
    pool = broker._pool = LostResponse()
    request = BrowserRequest(url="https://example.com/send", method="POST", body=b"synthetic")
    try:
        for _ in range(2):
            with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
                await broker.fetch(request)
        assert pool.calls == 1
        assert auth.journal == ["dispatch", "uncertain"]
        driver = SandboxedPlaywrightExecutor(network=broker, sandbox_verified=True)

        class Cdp:
            aborted = False

            async def send(self, method, params):
                self.aborted = method == "Fetch.failRequest"

        driver._cdp = Cdp()
        await driver._paused_request(
            {
                "requestId": "fixture",
                "request": {
                    "url": request.url,
                    "method": request.method,
                    "headers": {},
                    "hasPostData": True,
                    "postData": "synthetic",
                },
            }
        )
        assert driver._cdp.aborted

        class Page:
            def is_closed(self):
                return False

        driver._page = Page()
        with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
            await driver.execute(BrowserAction(operation="observe", sequence=1, control_epoch=1))
    finally:
        await broker.close()


async def test_mailbox_action_survives_strict_wire_roundtrip_and_host_fences_forged_frame(tmp_path):
    from hushh_mcp.services.pod_browser.mailbox import BrowserMailbox
    from hushh_mcp.services.pod_browser.mailbox_executor import MailboxExecutor

    class ReceiptAuthority(Authority):
        unresolved = False

        async def check_no_pending_dispatch(self, value):
            await self.check_binding(value)
            if self.unresolved:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")

    os.chmod(tmp_path, 0o700)
    sender = BrowserMailbox(tmp_path, lane="command")
    receiver = BrowserMailbox(tmp_path, lane="command")
    auth = ReceiptAuthority()
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )

    async def terminate():
        await broker.close()

    driver = MailboxExecutor(binding=binding(), mailbox=sender, broker=broker, terminate=terminate)
    previous = None
    try:
        for unresolved in (False, True):
            action = BrowserAction(operation="observe", sequence=1, control_epoch=1)
            call = asyncio.create_task(driver.execute(action))
            await asyncio.sleep(0)
            message_id, payload = receiver.receive(previous)
            previous = message_id
            # Uses the exact strict parser in the sandbox. Serializing default
            # fields would make a valid observe look like an invalid action.
            import json

            parsed = BrowserAction.model_validate_json(json.dumps(payload["action"]))
            assert parsed == action
            auth.unresolved = unresolved
            frame = await Executor().execute(parsed)
            receiver.reply(message_id, frame.model_dump(mode="json"))
            if unresolved:
                with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
                    await call  # a valid worker screenshot cannot bypass host receipts
            else:
                assert await call == frame
    finally:
        receiver.close()
        await driver.close()


@pytest.mark.parametrize("response", [None, {"status": "invalid"}])
async def test_lost_or_malformed_network_bridge_receipt_never_means_safe_to_retry(response):
    from hushh_mcp.services.pod_browser.sandbox_runner import _NetworkBridge

    class LostMailbox:
        async def exchange(self, payload, **kwargs):
            if response is None:
                raise BrowserRefused("BROWSER_BRIDGE_TIMEOUT")
            return response

    bridge = _NetworkBridge(LostMailbox())
    bridge.binding = binding()
    with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
        await bridge.fetch(BrowserRequest(url="https://example.com/autosave", method="POST"))


async def test_reconstructed_broker_refuses_ledger_pending_effect_before_a_new_socket():
    class PendingAuthority(Authority):
        unresolved = True

        async def check_no_pending_dispatch(self, value):
            if self.unresolved:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")

    class Pool:
        calls = 0

        async def handle_async_request(self, request):
            self.calls += 1
            raise TimeoutError()

        async def aclose(self):
            pass

    auth = PendingAuthority(approved=True)
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )
    await broker._pool.aclose()
    pool = broker._pool = Pool()
    request = BrowserRequest(url="https://example.com/next", method="POST")
    try:
        with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
            await broker.fetch(request)
        assert pool.calls == 0
        auth.unresolved = False
        with pytest.raises(BrowserRefused, match="NETWORK_UNAVAILABLE"):
            await broker.fetch(request)
        assert pool.calls == 1  # negative control: the pool is reachable after clearance
    finally:
        await broker.close()
