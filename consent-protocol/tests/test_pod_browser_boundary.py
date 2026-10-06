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
from tests.helpers.pod_browser import Authority, Executor, binding, control, readiness


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
    monkeypatch.setattr(worker, "tempfile", SimpleNamespace(mkdtemp=lambda **_: "private-scratch"))
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

        class FailedRequest:
            url, method, post_data_buffer = request.url, request.method, request.body

            async def all_headers(self):
                return {}

        class Route:
            request = FailedRequest()
            aborted = False

            async def abort(self, reason):
                self.aborted = True

        route = Route()
        await driver._route(route)
        assert route.aborted

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


async def test_model_factory_rejects_custom_transport_and_unverified_native_model(monkeypatch):
    from pathlib import Path

    from google.adk.models import Gemini

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.one_adk.computer_use_agent import build_computer_use_agent

    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/computer_use/agent.yaml")
    )
    runtime = control()
    native = Gemini(model="gemini-3.7-flash")
    monkeypatch.delenv("POD_COMPUTER_USE_ENABLED", raising=False)
    with pytest.raises(BrowserRefused, match="DISABLED"):
        build_computer_use_agent(manifest, control=runtime, model=native)
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNSUPPORTED"):
        build_computer_use_agent(manifest, control=runtime, model=object())
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNVERIFIED"):
        build_computer_use_agent(manifest, control=runtime, model=Gemini(model="gemini-3.6-flash"))
    agent = build_computer_use_agent(manifest, control=runtime, model=native)
    assert agent.mode == "task"
    assert agent.model is native
    # Exercise native ADK discovery, which initializes before ToolContext prepare.
    tools = await agent.tools[0].get_tools()
    assert "initialize" not in {tool.name for tool in tools}
    assert "search" not in {tool.name for tool in tools}
    assert "click_at" in {tool.name for tool in tools}


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
