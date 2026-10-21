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
    shared_readiness,
    task_runtime_fixture,
)


@pytest.mark.parametrize("cloud", ["gcp", "azure"])
@pytest.mark.parametrize(
    "fault", [None, "wrong_mode", "false_containment", "unconfirmed_stop", "wrong_host"]
)
async def test_shared_owner_execution_qualifies_explicit_mode_without_old_isolation(cloud, fault):
    from browser_runtime.qualification import validate_qualification

    changes = {"cloud": cloud}
    if fault == "wrong_mode":
        changes["chromium_sandbox"] = cloud != "gcp"
    elif fault == "false_containment":
        changes["private_access_denied"] = True
    elif fault == "unconfirmed_stop":
        changes["lifecycle_verified"] = False
    ready = shared_readiness(**changes)
    statement = {
        "version": 2,
        "host_kind": "gcp_cloud_run" if cloud == "gcp" else "azure_container_apps",
        "source_revision": "a" * 40,
        "image_tag": "synthetic-source",
        "evidence_sha256": "b" * 64,
        "public_policy_sha256": "c" * 64,
        "readiness": ready.model_dump(),
    }
    if fault == "wrong_host":
        statement["host_kind"] = "azure_vm"
    arguments = {"image_digest": ready.component_digest, "source_revision": "a" * 40}
    if fault is None:
        driver = Executor()
        await control(ready=ready, driver=driver).initialize()
        assert driver.calls == ["initialize"]
        assert validate_qualification(statement, **arguments) == statement
    else:
        with pytest.raises(ValueError):
            validate_qualification(statement, **arguments)
        if fault != "wrong_host":
            driver = Executor()
            with pytest.raises(BrowserRefused, match="EXECUTION_NOT_READY"):
                await control(ready=ready, driver=driver).initialize()
            assert driver.calls == []


@pytest.mark.parametrize("sandbox", [True, False])
async def test_chromium_uses_only_the_qualified_mode_and_never_retries_without_sandbox(
    monkeypatch, sandbox
):
    import sys
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor

    launch = AsyncMock(side_effect=RuntimeError("synthetic startup failure"))
    stop = AsyncMock()
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch), stop=stop)
    monkeypatch.setitem(
        sys.modules,
        "playwright.async_api",
        SimpleNamespace(
            async_playwright=lambda: SimpleNamespace(start=AsyncMock(return_value=playwright))
        ),
    )
    executor = PlaywrightExecutor(network=Authority(), chromium_sandbox=sandbox)
    with pytest.raises(BrowserRefused, match="STARTUP_FAILED"):
        await executor.initialize()
    assert launch.await_count == 1
    assert launch.call_args.kwargs["chromium_sandbox"] is sandbox
    stop.assert_awaited_once()


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


async def test_sealed_dispatch_lanes_prevent_replay_and_preserve_uncertain_effects(tmp_path):
    from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")

    def journal():
        return BrowserDispatchJournal(log, key=b"J" * 32, owner_id="owner", pod_id="pod")

    original, competing = journal(), journal()
    bound = binding()
    action = {"sequence": 1, "control_epoch": 1, "url": "https://example.com/private-query"}
    commitment = original.commitment(bound, "action", action)
    # Two writers cannot both publish an intent against the same sealed head.
    outcomes = await asyncio.gather(
        original.begin(bound, "action", commitment),
        competing.begin(bound, "action", commitment),
        return_exceptions=True,
    )
    assert sum(result is None for result in outcomes) == 1
    refused = next(result for result in outcomes if result is not None)
    assert isinstance(refused, BrowserRefused) and refused.code == "BROWSER_ACTION_REPLAY"
    await original.require_settled(bound, lane="network")  # navigation's broker can proceed
    with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
        await journal().require_settled(bound)  # restart cannot adopt the in-flight intent
    await competing.settle(bound, "action", commitment, uncertain=False)
    await original.settle(bound, "action", commitment, uncertain=False)  # lost ack is idempotent
    await original.require_settled(bound)
    with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
        await original.begin(bound, "action", commitment)
    with pytest.raises(BrowserRefused, match="BINDING_REFUSED"):
        await original.require_settled(bound.model_copy(update={"owner_id": "another"}))
    network = original.commitment(bound, "network", {"receipt": "synthetic-private-receipt"})
    await original.begin(bound, "network", network)
    await original.settle(bound, "network", network, uncertain=True)
    with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
        await journal().require_settled(bound.model_copy(update={"incarnation": "replacement"}))
    with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
        await original.settle(bound, "network", network, uncertain=False)
    records = await log.replay()
    assert "private-query" not in str(records) and "synthetic-private-receipt" not in str(records)


async def test_composed_public_authority_fences_unknown_requests_and_recovery(tmp_path):
    from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
    from hushh_mcp.services.pod_browser.execution_authority import (
        BrowserExecutionAuthority,
        PublicResearchNetworkAuthority,
        PublicResearchPolicy,
    )
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")
    journal = BrowserDispatchJournal(log, key=b"J" * 32, owner_id="owner", pod_id="pod")
    policy = PublicResearchPolicy(
        page_urls=("https://example.com/research",),
        static_prefixes=("https://example.com/static/",),
    )
    bound, consent = binding(), Authority(approved=True)
    action_auth = BrowserExecutionAuthority(bound, consent, journal, policy)
    network = PublicResearchNetworkAuthority(bound, consent, journal, policy)
    action = BrowserAction(
        operation="navigate", sequence=1, control_epoch=1, url=policy.page_urls[0]
    )
    await action_auth.journal_dispatch(bound, action)
    await network.check_no_pending_dispatch(bound)  # navigation can receive its own response
    request = BrowserRequest(url=policy.page_urls[0], method="GET")
    assert not (
        await network.authorize_request(bound, request, request.commitment())
    ).effect_receipt_required
    for refused in (
        request.model_copy(update={"url": "https://example.com/logout"}),
        request.model_copy(update={"headers": (("Cookie", "synthetic"),)}),
        request.model_copy(update={"headers": (("Accept", "synthetic-private"),)}),
        request.model_copy(update={"headers": (("Accept-Language", "synthetic-private"),)}),
        request.model_copy(update={"headers": (("Referer", "https://example.com/private"),)}),
        request.model_copy(update={"headers": (("X-Private", "synthetic"),)}),
        request.model_copy(update={"method": "POST"}),
        request.model_copy(update={"url": "https://example.com/static/../delete"}),
        request.model_copy(update={"url": "https://example.com/static/file?secret=synthetic"}),
    ):
        with pytest.raises(BrowserRefused, match="REQUEST_NOT_QUALIFIED"):
            await network.authorize_request(bound, refused, refused.commitment())
    with pytest.raises(BrowserRefused, match="ACTION_NOT_QUALIFIED"):
        await action_auth.authorize_action(
            bound,
            BrowserAction(operation="type", sequence=2, control_epoch=1, x=1, y=1, text="private"),
        )
    for keys in (("Tab",), ("Shift", "Tab"), ("PageDown",), ("ArrowUp",)):
        await action_auth.authorize_action(
            bound, BrowserAction(operation="keys", sequence=2, control_epoch=1, keys=keys)
        )
    for keys in (("Enter",), ("Control", "v"), ("a",), ("Tab+Enter",)):
        with pytest.raises(BrowserRefused, match="ACTION_NOT_QUALIFIED"):
            await action_auth.authorize_action(
                bound, BrowserAction(operation="keys", sequence=2, control_epoch=1, keys=keys)
            )
    await action_auth.settle_dispatch(bound, action, uncertain=True)
    recovered = BrowserExecutionAuthority(bound, consent, journal, policy)
    with pytest.raises(BrowserRefused, match="OUTCOME_UNCERTAIN"):
        await recovered.check_no_pending_dispatch(bound)


@pytest.mark.parametrize("host_kind", ["gcp_cloud_run", "azure_vm"])
async def test_browser_startup_binds_one_owner_after_recovery_and_closes_launcher(
    monkeypatch, tmp_path, host_kind
):
    from dataclasses import replace

    from hushh_mcp.services.pod_browser import composition as startup
    from hushh_mcp.services.pod_browser import deployment as install
    from tests.helpers.pod_browser_composition import (
        browser_startup_ports,
        install_test_browser_host,
        qualified_browser_installation_fixture,
    )

    fixture = qualified_browser_installation_fixture(monkeypatch, tmp_path, host_kind)
    authority, log = fixture.authority, fixture.log
    qualified, policy, cloud = fixture.qualified, fixture.policy, fixture.cloud
    with pytest.raises(BrowserRefused, match="QUALIFICATION_REQUIRED"):
        startup.configure_browser_startup(authority=authority, log=log, dek=b"K" * 32)
    import json

    monkeypatch.setenv("HUSSH_BROWSER_QUALIFICATION_JSON", json.dumps(qualified))
    with pytest.raises(BrowserRefused, match="OWNER_POLICY_REQUIRED"):
        startup.configure_browser_startup(authority=authority, log=log, dek=b"K" * 32)
    monkeypatch.setenv("HUSSH_BROWSER_POLICY_JSON", json.dumps(policy))
    # Azure cloud identity alone must never admit the denied Container Apps host.
    with pytest.raises(BrowserRefused, match="HOST_UNQUALIFIED"):
        install.recovered_browser_deployment(authority)
    install_test_browser_host(monkeypatch, cloud)
    deployment = install.recovered_browser_deployment(authority)
    assert deployment.incarnation == "epoch"  # bound after recovery, absent from both documents
    assert "incarnation" not in policy and "incarnation" not in qualified
    authority.pod_key_id = "changed-key"
    with pytest.raises(BrowserRefused, match="QUALIFICATION_CHANGED"):
        install.recovered_browser_deployment(authority)
    authority.pod_key_id = "key"
    changed_policy = {**policy, "public_policy": {"page_urls": ["https://example.com/other"]}}
    monkeypatch.setenv("HUSSH_BROWSER_POLICY_JSON", json.dumps(changed_policy))
    with pytest.raises(BrowserRefused, match="OWNER_POLICY_UNQUALIFIED"):
        install.recovered_browser_deployment(authority)
    monkeypatch.setenv("HUSSH_BROWSER_POLICY_JSON", json.dumps(policy))
    changed = {
        **qualified,
        "readiness": {**qualified["readiness"], "component_digest": "sha256:" + "c" * 64},
    }
    monkeypatch.setenv("HUSSH_BROWSER_QUALIFICATION_JSON", json.dumps(changed))
    with pytest.raises(BrowserRefused, match="QUALIFICATION_INVALID"):
        install.recovered_browser_deployment(authority)
    monkeypatch.setenv("HUSSH_BROWSER_QUALIFICATION_JSON", json.dumps(qualified))
    ports = browser_startup_ports(monkeypatch, deployment)
    composed = startup.configure_browser_startup(authority=authority, log=log, dek=b"K" * 32)
    owner = ports.owner
    try:
        runtime, same = await asyncio.gather(composed.bind(owner), composed.bind(owner))
        assert runtime is same and runtime.capability().public_research_only
        with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
            await composed.bind(replace(owner, owner_id="another"))
        monkeypatch.setattr(startup, "ai_selection_revision", lambda: -1)
        assert runtime.capability().code == "BROWSER_MODEL_SELECTION_CHANGED"
        # A request already admitted before shutdown may still be queued for
        # composition. It must not return the runtime after its launcher closes.
        await composed._lock.acquire()
        closing = asyncio.create_task(composed.close())
        await asyncio.sleep(0)
        binding_owner = asyncio.create_task(composed.bind(owner))
        await asyncio.sleep(0)
        composed._lock.release()
        await closing
        with pytest.raises(BrowserRefused, match="STOPPED"):
            await binding_owner
        assert not runtime.capability().available
    finally:
        await composed.close()
    ports.launcher.close.assert_awaited_once()


async def test_current_owner_can_read_and_stop_after_original_grant_ends_but_cannot_resume(
    monkeypatch,
):
    from dataclasses import replace

    fixture = task_runtime_fixture(monkeypatch)
    started = await approved_task(fixture)
    task_id = started.binding.task_id
    task = fixture.runtime._tasks[task_id]

    async def ended():
        raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")

    task.access = replace(task.access, check=ended)
    assert (await fixture.runtime.read(fixture.owner, task_id)).binding == started.binding
    with pytest.raises(BrowserRefused, match="AUTHORIZATION_EXPIRED"):
        await fixture.runtime.control(fixture.owner, task_id, "resume", started.control_epoch)
    with pytest.raises(BrowserRefused, match="AUTHORIZATION_EXPIRED"):
        await fixture.runtime.frame(fixture.owner, task_id)
    stopped = await fixture.runtime.control(fixture.owner, task_id, "cancel", started.control_epoch)
    assert stopped.phase == "cancelled" and task.closed
    assert task.request is task.access is task.processing is task.consent is None
    assert task.sessions is task.authority is task.control is task.worker is task.monitor is None
    # A fresh admitted owner can recover the same terminal receipt even though
    # the original bearer has expired and has been released from memory.
    repeated = await fixture.runtime.start(fixture.owner, fixture.request)
    assert repeated.binding == stopped.binding and repeated.phase == "cancelled"
    assert fixture.launcher.calls == 1
    with pytest.raises(BrowserRefused, match="REQUEST_CONFLICT"):
        await fixture.runtime.start(
            fixture.owner, fixture.request.model_copy(update={"goal": "Changed private goal"})
        )
    with pytest.raises(BrowserRefused, match="CONTROL_UNAVAILABLE"):
        await fixture.runtime.control(fixture.owner, task_id, "resume", stopped.control_epoch)


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
        fixture.owner,
        pending.binding.task_id,
        pending.review.review_id,
        "synthetic-owner-receipt-" + "x" * 32,
    )
    with pytest.raises(BrowserRefused, match="MODEL_STOP_UNCONFIRMED"):
        await task.worker
    assert fixture.admission._states["epoch"].active == 1
    with pytest.raises(BrowserRefused, match="MODEL_STOP_UNCONFIRMED"):
        await fixture.runtime.drain()  # browser close alone cannot prove model shutdown
    failed = await fixture.runtime.read(fixture.owner, pending.binding.task_id)
    assert failed.phase == "unavailable" and failed.code == "BROWSER_MODEL_STOP_UNCONFIRMED"
    task.monitor.cancel()  # fixture keeps the permit held intentionally


async def test_browser_cancel_and_update_join_shutdown_before_releasing_admission(monkeypatch):
    from unittest.mock import AsyncMock

    fixture = task_runtime_fixture(monkeypatch)
    started = await approved_task(fixture)
    task = fixture.runtime._tasks[started.binding.task_id]
    entered, finish = asyncio.Event(), asyncio.Event()
    original_close, original_release = fixture.driver.close, task.permit.release
    released = []

    async def close():
        entered.set()
        await finish.wait()
        await original_close()

    async def release():
        # An update idle receipt cannot precede the terminal sealed write or
        # cleanup of closures retaining the owner token and private task.
        assert task.closed and task.terminal is not None
        assert task.request is task.access is task.control is None
        assert fixture.log.records[-1]["payload"]["snapshot"]["phase"] == "cancelled"
        released.append(len(fixture.log.records))
        await original_release()

    monkeypatch.setattr(fixture.driver, "close", close)
    monkeypatch.setattr(task.permit, "release", release)
    review_release = AsyncMock(wraps=fixture.reviews.release)
    monkeypatch.setattr(fixture.reviews, "release", review_release)
    owner = asyncio.create_task(
        fixture.runtime.control(
            fixture.owner, started.binding.task_id, "cancel", started.control_epoch
        )
    )
    drain = None
    try:
        async with asyncio.timeout(3):
            await entered.wait()
            drain = asyncio.create_task(fixture.runtime.drain())
            fixture.model.release.set()
            await asyncio.gather(task.worker, return_exceptions=True)
            # The cancelled native worker is joined; completion cannot overwrite Stop.
            assert fixture.admission._states["epoch"].active == 1
            assert not released
            finish.set()
            result, _ = await asyncio.gather(owner, drain)
        assert result.phase == "cancelled" and result.code == "BROWSER_OWNER_CANCELLED"
        assert fixture.driver.calls.count("close") == 1
        review_release.assert_awaited_once()
        assert released == [len(fixture.log.records)]  # no writes after the idle fence
        assert fixture.admission._states["epoch"].active == 0
    finally:
        finish.set()
        await asyncio.gather(owner, *([drain] if drain else []), return_exceptions=True)
        await fixture.runtime.drain()


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


async def test_owner_resize_fences_old_coordinates_and_enforces_new_geometry(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    snapshot = await approved_task(fixture)
    task_id = snapshot.binding.task_id
    taken = await fixture.runtime.control(
        fixture.owner, task_id, "takeover", snapshot.control_epoch
    )
    original_execute = fixture.driver.execute

    async def checked_scope(action, *, scope=None):
        control = fixture.runtime._tasks[task_id].control
        control.require_execution_scope(scope)
        assert scope.control_epoch == action.control_epoch == control.control_epoch
        return await original_execute(action, scope=scope)

    monkeypatch.setattr(fixture.driver, "execute", checked_scope)
    resized = await fixture.runtime.input(
        fixture.owner,
        task_id,
        BrowserAction(
            operation="resize",
            width=390,
            height=700,
            sequence=taken.next_sequence,
            control_epoch=taken.control_epoch,
        ),
    )
    assert resized.viewport.width == 390 and resized.viewport.height == 700
    assert resized.control_owner == "owner" and resized.control_epoch > taken.control_epoch
    old_coordinates = BrowserAction(
        operation="click",
        x=10,
        y=10,
        sequence=resized.next_sequence,
        control_epoch=taken.control_epoch,
    )
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await fixture.runtime.input(fixture.owner, task_id, old_coordinates)
    with pytest.raises(BrowserRefused, match="COORDINATES_INVALID"):
        await fixture.runtime.input(
            fixture.owner,
            task_id,
            BrowserAction(
                operation="click",
                x=500,
                y=10,
                sequence=resized.next_sequence,
                control_epoch=resized.control_epoch,
            ),
        )
    await fixture.runtime.control(fixture.owner, task_id, "cancel", resized.control_epoch)


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
    discovered = await recovered.runtime.list_tasks(recovered.owner)
    assert len(discovered) == 1 and discovered[0].phase == "outcome_uncertain"
    assert discovered[0].binding.task_id == task_id
    assert not {"goal", "summary", "review", "fields", "frame", "approved_origins"} & set(
        discovered[0].model_dump()
    )
    state = await recovered.runtime.read(recovered.owner, task_id)
    assert state.phase == "outcome_uncertain" and state.control_owner == "stopped"
    with pytest.raises(BrowserRefused, match="RECOVERY_REQUIRES_OWNER"):
        await recovered.runtime.start(recovered.owner, recovered.request)
    assert recovered.launcher.calls == 0


@pytest.mark.parametrize("operation", ["read", "list_tasks"])
async def test_browser_metadata_refuses_owner_revoked_during_recovery(monkeypatch, operation):
    fixture = task_runtime_fixture(monkeypatch)
    replay = fixture.log.replay

    async def revoke_during_replay():
        records = await replay()
        fixture.auth.revoked = True
        return records

    fixture.log.replay = revoke_during_replay
    with pytest.raises(BrowserRefused, match="BROWSER_OWNER_REFUSED"):
        if operation == "read":
            await fixture.runtime.read(fixture.owner, "browser_" + "a" * 32)
        else:
            await fixture.runtime.list_tasks(fixture.owner)
    assert fixture.launcher.calls == 0


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


@pytest.mark.parametrize("operation", ["observe", "click"])
async def test_takeover_waits_for_current_dispatch_and_fences_old_actions_and_observations(
    monkeypatch, operation
):
    driver, auth = Executor(), Authority(approved=True)
    runtime = control(driver=driver, auth=auth)
    finished, checking, release = False, asyncio.Event(), asyncio.Event()
    original_execute, original_check = driver.execute, auth.check_binding
    active = None

    async def execute(*args, **kwargs):
        nonlocal finished
        frame = await original_execute(*args, **kwargs)
        finished = True
        return frame

    async def check(value):
        await original_check(value)
        if finished and asyncio.current_task() is active:
            checking.set()
            await release.wait()

    monkeypatch.setattr(driver, "execute", execute)
    monkeypatch.setattr(auth, "check_binding", check)
    await runtime.initialize()
    with pytest.raises(BrowserRefused, match="OWNER_INPUT_REQUIRED"):
        await runtime.execute(
            BrowserAction(operation="resize", width=390, height=700, sequence=1, control_epoch=1)
        )
    assert driver.calls == ["initialize"]
    active = asyncio.create_task(
        runtime.execute(
            BrowserAction(
                operation=operation,
                sequence=1,
                control_epoch=1,
                **({"x": 1, "y": 1} if operation == "click" else {}),
            )
        )
    )
    await asyncio.wait_for(checking.wait(), 1)
    takeover = asyncio.create_task(runtime.take_control())
    await asyncio.sleep(0)
    assert not takeover.done()
    release.set()
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await active
    assert runtime.latest_frame is None
    if operation == "click":
        with pytest.raises(BrowserRefused, match="UNCERTAIN"):
            await takeover
        assert runtime.outcome_uncertain and auth.journal[-1] == (1, "uncertain")
        await runtime.stop()
        return
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


@pytest.mark.parametrize("resize", [False, True])
async def test_worker_frame_mismatch_never_settles_effect_as_success(resize):
    class WrongFrame(Executor):
        async def execute(self, action, *, scope=None):
            return (await super().execute(action)).model_copy(
                update={"width": 1280} if resize else {"sequence": 99}
            )

    auth = Authority(approved=True)
    runtime = control(auth=auth, driver=WrongFrame())
    await runtime.initialize()
    epoch = await runtime.take_control() if resize else 1
    with pytest.raises(BrowserRefused, match="FRAME_MISMATCH"):
        await runtime.execute(
            BrowserAction(
                operation="resize", sequence=1, control_epoch=epoch, width=390, height=700
            )
            if resize
            else BrowserAction(operation="click", sequence=1, control_epoch=epoch, x=1, y=1),
            actor="owner" if resize else "agent",
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
    from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor

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
        driver = PlaywrightExecutor(network=broker, chromium_sandbox=True)

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
