"""Owner takeover and exact website review share the existing task authority."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import (
    BrowserAction,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.network import (
    BrowserNetworkBroker,
    BrowserRequest,
)
from tests.helpers.pod_browser import (
    Authority,
    approved_task,
    binding,
    task_runtime_fixture,
)


async def test_redirect_joins_original_scope_and_unknown_parent_cannot_borrow_next_input():
    import time
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_browser.contracts import BrowserExecutionScope, BrowserResponse
    from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor

    scope = BrowserExecutionScope(
        sequence=1, control_epoch=1, actor="owner", deadline_at=time.time() + 10
    )
    sent, failed = [], []
    parent_finished = asyncio.Event()

    async def fetch(request):
        sent.append(request)
        return BrowserResponse(
            status=303 if request.url.endswith("/login") else 200,
            headers=(("Location", "/account"),) if request.url.endswith("/login") else (),
            body=b"ok",
        )

    driver = PlaywrightExecutor(network=SimpleNamespace(fetch=fetch), chromium_sandbox=True)
    driver._main_frame_id = "main"

    def event(identifier, path, predecessor=None):
        return {
            "requestId": identifier,
            "frameId": "main",
            "resourceType": "Document",
            "request": {"url": "https://example.com" + path, "method": "GET", "headers": {}},
            **({"redirectedRequestId": predecessor} if predecessor else {}),
        }

    async def send(method, params):
        if method == "Fetch.fulfillRequest" and params["requestId"] == "parent":
            parent_finished.set()
        if method == "Fetch.failRequest":
            failed.append(params["requestId"])

    async def press(_):
        driver._request_paused(event("parent", "/login"))

    page = SimpleNamespace(
        is_closed=lambda: False,
        keyboard=SimpleNamespace(press=press),
        screenshot=AsyncMock(return_value=b"\x89PNG\r\n\x1a\nsynthetic"),
        wait_for_url=AsyncMock(),
        viewport_size={"width": 1280, "height": 720},
        url="https://example.com/account",
    )
    driver._page, driver._cdp = page, SimpleNamespace(send=send)
    work = asyncio.create_task(
        driver.execute(
            BrowserAction(operation="keys", sequence=1, control_epoch=1, keys=("Enter",)),
            scope=scope,
        )
    )
    try:
        await asyncio.wait_for(parent_finished.wait(), 1)
        await asyncio.gather(*tuple(driver._requests))
        done, _ = await asyncio.wait({work}, timeout=0.01)
        assert not done  # successor is deliberately withheld after parent handler completion
        assert not work.done() and not page.screenshot.called
        driver._request_paused(event("child", "/account", "parent"))
        frame = await asyncio.wait_for(work, 1)
        assert frame.url == "https://example.com/account"
        assert [request.scope for request in sent] == [scope, scope]
        page.wait_for_url.assert_awaited_once()
        assert page.wait_for_url.call_args.kwargs["wait_until"] == "domcontentloaded"
        driver._scope = scope.model_copy(update={"sequence": 2, "control_epoch": 2})
        driver._request_paused(event("unrelated", "/account", "unknown-parent"))
        await driver._settle_requests()
        assert failed == ["unrelated"] and len(sent) == 2
    finally:
        await driver.close()
        await asyncio.gather(work, return_exceptions=True)


@pytest.mark.parametrize("operation", ["observe", "click"])
async def test_owner_takeover_interrupts_blocked_model_action_without_replaying(
    monkeypatch, operation
):
    fixture = task_runtime_fixture(monkeypatch)
    fixture.driver.release = asyncio.Event()

    async def blocked(*, control, processing, goal):
        await processing.require()
        fixture.model.entered.set()
        await control.execute(
            BrowserAction(
                operation=operation,
                sequence=control.next_sequence,
                control_epoch=control.control_epoch,
                **({"x": 1, "y": 1} if operation == "click" else {}),
            )
        )

    monkeypatch.setattr(fixture.model, "run", blocked)
    started = await approved_task(fixture)
    await asyncio.wait_for(fixture.driver.entered.wait(), 1)
    task = fixture.runtime._tasks[started.binding.task_id]
    try:
        taking = fixture.runtime.control(
            fixture.owner, task.binding.task_id, "takeover", started.control_epoch
        )
        if operation == "click":
            with pytest.raises(BrowserRefused, match="UNCERTAIN"):
                await asyncio.wait_for(taking, 1)
            assert task.control.outcome_uncertain
        else:
            taken = await asyncio.wait_for(taking, 1)
            assert taken.control_owner == "owner" and taken.phase == "needs_owner"
        assert task.worker.done() and not fixture.driver.release.is_set()
    finally:
        await fixture.runtime.control(
            fixture.owner, task.binding.task_id, "cancel", task.control.control_epoch
        )
    assert fixture.admission._states["epoch"].active == 0


async def test_owner_status_and_stop_do_not_wait_behind_a_browser_input(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    started = await approved_task(fixture)
    task_id = started.binding.task_id
    taken = await fixture.runtime.control(fixture.owner, task_id, "takeover", started.control_epoch)
    fixture.driver.entered.clear()
    fixture.driver.release = asyncio.Event()
    original_close = fixture.driver.close

    async def close():
        fixture.driver.release.set()
        await original_close()

    monkeypatch.setattr(fixture.driver, "close", close)
    pending = asyncio.create_task(
        fixture.runtime.input(
            fixture.owner,
            task_id,
            BrowserAction(
                operation="observe", sequence=taken.next_sequence, control_epoch=taken.control_epoch
            ),
        )
    )
    try:
        await asyncio.wait_for(fixture.driver.entered.wait(), 1)
        status = await asyncio.wait_for(fixture.runtime.read(fixture.owner, task_id), 1)
        assert status.binding.task_id == task_id and not pending.done()
        stopped = await asyncio.wait_for(
            fixture.runtime.control(fixture.owner, task_id, "cancel", taken.control_epoch), 1
        )
        assert stopped.phase == "cancelled" and fixture.admission._states["epoch"].active == 0
        with pytest.raises(BrowserRefused, match="STOPPED"):
            await pending
    finally:
        fixture.driver.release.set()
        await asyncio.gather(pending, return_exceptions=True)
        await fixture.runtime.drain()


@pytest.mark.parametrize("decision", ["approve", "cancel", "expired"])
async def test_owner_disclosure_review_resumes_exact_input_without_restarting_goal(
    monkeypatch, decision
):
    fixture = task_runtime_fixture(monkeypatch)
    started = await approved_task(fixture)
    task_id = started.binding.task_id
    taken = await fixture.runtime.control(fixture.owner, task_id, "takeover", started.control_epoch)
    task = fixture.runtime._tasks[task_id]
    original_execute, original_close = fixture.driver.execute, fixture.driver.close
    dispatched = []

    async def exact_request(action, *, scope=None):
        await task.consent.require(
            task.binding,
            "disclose",
            {
                "destination": "https://example.com/submit",
                "request_commitment": "a" * 64,
                "sequence": action.sequence,
                "control_epoch": action.control_epoch,
            },
        )
        dispatched.append(action.sequence)
        return await original_execute(action)

    async def close():
        if not pending.done():
            pending.cancel()
        await original_close()

    monkeypatch.setattr(fixture.driver, "execute", exact_request)
    monkeypatch.setattr(fixture.driver, "close", close)
    pending = asyncio.create_task(
        fixture.runtime.input(
            fixture.owner,
            task_id,
            BrowserAction(
                operation="observe", sequence=taken.next_sequence, control_epoch=taken.control_epoch
            ),
        )
    )
    try:
        async with asyncio.timeout(1):
            while task.review_waiting is None:
                await asyncio.sleep(0)
        review = (await fixture.runtime.read(fixture.owner, task_id)).review
        assert review.purpose == "disclose" and dispatched == []
        receipt = "synthetic-owner-receipt-" + "x" * 32
        with pytest.raises(BrowserRefused, match="REVIEW_CHANGED"):
            await fixture.runtime.confirm_review(fixture.owner, task_id, "changed-request", receipt)
        assert not pending.done() and dispatched == []
        if decision == "approve":
            await asyncio.wait_for(
                fixture.runtime.confirm_review(
                    fixture.owner,
                    task_id,
                    review.review_id,
                    receipt,
                ),
                1,
            )
            result = await asyncio.wait_for(pending, 1)
            assert result.control_owner == "owner" and result.phase == "needs_owner"
            assert dispatched == [taken.next_sequence]
            assert task.worker.done() and fixture.launcher.calls == 1
        elif decision == "expired":

            async def rotated(*_args):
                return review.model_copy(update={"review_id": "replacement-review"})

            monkeypatch.setattr(fixture.reviews, "refresh_review", rotated)
            assert (
                await fixture.runtime.read(fixture.owner, task_id)
            ).review.review_id == review.review_id
            with pytest.raises(BrowserRefused, match="REVIEW_CHANGED"):
                await fixture.runtime.confirm_review(
                    fixture.owner, task_id, review.review_id, receipt
                )
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert task.closed and task.code == "BROWSER_REVIEW_EXPIRED" and dispatched == []
        else:
            await asyncio.wait_for(
                fixture.runtime.control(
                    fixture.owner,
                    task_id,
                    "cancel",
                    taken.control_epoch,
                ),
                1,
            )
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert dispatched == []
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await fixture.runtime.drain()


async def test_browser_stop_wins_a_delayed_confirmation_without_restarting_work(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    initial = await fixture.runtime.start(fixture.owner, fixture.request)
    task = fixture.runtime._tasks[initial.binding.task_id]
    await task.worker
    pending = await fixture.runtime.read(fixture.owner, initial.binding.task_id)
    entered, release = asyncio.Event(), asyncio.Event()
    confirm = fixture.reviews.confirm_review

    async def delayed(*args):
        await confirm(*args)
        entered.set()
        await release.wait()

    monkeypatch.setattr(fixture.reviews, "confirm_review", delayed)
    confirming = asyncio.create_task(
        fixture.runtime.confirm_review(
            fixture.owner,
            initial.binding.task_id,
            pending.review.review_id,
            "synthetic-owner-receipt-" + "x" * 32,
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await fixture.runtime.control(
            fixture.owner, initial.binding.task_id, "cancel", pending.control_epoch
        )
        release.set()
        with pytest.raises(BrowserRefused, match="REVIEW_CHANGED"):
            await asyncio.wait_for(confirming, 1)
        assert task.closed and task.review is None and fixture.launcher.calls == 0
    finally:
        release.set()
        await asyncio.gather(confirming, return_exceptions=True)
        await fixture.runtime.drain()


@pytest.mark.parametrize("cancel", [False, True])
async def test_accepted_owner_input_keeps_review_reachable_and_deduplicates_delivery(
    monkeypatch, cancel
):
    fixture = task_runtime_fixture(monkeypatch)
    started = await approved_task(fixture)
    task_id = started.binding.task_id
    taken = await fixture.runtime.control(fixture.owner, task_id, "takeover", started.control_epoch)
    task = fixture.runtime._tasks[task_id]
    execute = fixture.driver.execute
    dispatched = []

    async def reviewed(action, *, scope=None):
        await task.consent.require(
            task.binding,
            "disclose",
            {
                "destination": "https://example.com/sign-in",
                "request_commitment": "b" * 64,
                "sequence": action.sequence,
                "control_epoch": action.control_epoch,
            },
        )
        dispatched.append(action.sequence)
        return await execute(action, scope=scope)

    monkeypatch.setattr(fixture.driver, "execute", reviewed)
    action = BrowserAction(
        operation="observe", sequence=taken.next_sequence, control_epoch=taken.control_epoch
    )
    try:
        accepted = await fixture.runtime.submit_input(fixture.owner, task_id, action)
        assert accepted.input_pending and dispatched == []
        worker = task.input_worker
        assert (await fixture.runtime.submit_input(fixture.owner, task_id, action)).input_pending
        assert task.input_worker is worker
        with pytest.raises(BrowserRefused, match="INPUT_PENDING"):
            await fixture.runtime.submit_input(
                fixture.owner,
                task_id,
                action.model_copy(update={"operation": "hover", "x": 1, "y": 1}),
            )
        status = await fixture.runtime.read(fixture.owner, task_id)
        assert status.review.purpose == "disclose" and status.input_pending
        if cancel:
            await fixture.runtime.control(fixture.owner, task_id, "cancel", taken.control_epoch)
            assert worker.done() and dispatched == []
        else:
            await fixture.runtime.confirm_review(
                fixture.owner,
                task_id,
                status.review.review_id,
                "synthetic-owner-receipt-" + "x" * 32,
            )
            await asyncio.wait_for(worker, 1)
            completed = await fixture.runtime.read(fixture.owner, task_id)
            assert not completed.input_pending and dispatched == [action.sequence]
            assert completed.next_sequence == action.sequence + 1
    finally:
        await fixture.runtime.drain()


@pytest.mark.parametrize("request_kind", ["post", "authenticated_get", "path_header_get"])
@pytest.mark.parametrize("takeover", [False, True])
async def test_interactive_request_review_keeps_exact_scope_outside_http_deadline(
    monkeypatch, tmp_path, request_kind, takeover
):
    import time
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import httpcore

    from hushh_mcp.services.pod_browser.contracts import BrowserExecutionScope
    from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
    from hushh_mcp.services.pod_browser.execution_authority import (
        PublicResearchNetworkAuthority,
        PublicResearchPolicy,
    )
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    bound = binding(expires_at=int(time.time()) + 600)
    scope = BrowserExecutionScope(
        sequence=1, control_epoch=2, actor="owner", deadline_at=time.time() + 330
    )
    request = BrowserRequest(
        scope=scope,
        url="https://example.com/synthetic-private-path"
        if request_kind == "path_header_get"
        else "https://example.com/sign-in",
        method="POST" if request_kind == "post" else "GET",
        body=b"synthetic-private-login" if request_kind == "post" else b"",
        headers=(("X-Private", "synthetic-private-header"),)
        if request_kind == "path_header_get"
        else (("Cookie", "synthetic-cookie"),),
    )
    entered, release = asyncio.Event(), asyncio.Event()
    terms = []

    class Consent(Authority):
        async def require(self, value, purpose, actual):
            await self.check_binding(value)
            assert purpose == "disclose"
            terms.append(actual)
            entered.set()
            await release.wait()

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")
    journal = BrowserDispatchJournal(log, key=b"J" * 32, owner_id="owner", pod_id="pod")
    authority = PublicResearchNetworkAuthority(
        bound,
        Consent(),
        journal,
        PublicResearchPolicy(
            page_urls=("https://example.com/",), interactive_origins=("https://example.com",)
        ),
    )
    broker = BrowserNetworkBroker(
        binding=bound, allowed_origins=frozenset({"https://example.com"}), authority=authority
    )
    active_epoch = [scope.control_epoch]

    def current(actual):
        if actual.control_epoch != active_epoch[0]:
            raise BrowserRefused("BROWSER_CONTROL_CHANGED")

    broker.bind_scope_validator(current)
    await broker._pool.aclose()
    sent = AsyncMock(
        return_value=httpcore.Response(
            200, headers=[(b"Content-Type", b"text/plain")], content=b"ok"
        )
    )
    broker._pool = SimpleNamespace(handle_async_request=sent, aclose=AsyncMock())
    timeout = asyncio.timeout
    monkeypatch.setattr(
        asyncio, "timeout", lambda seconds: timeout(0.01 if seconds == 15 else seconds)
    )
    work = asyncio.create_task(broker.fetch(request))
    try:
        await entered.wait()
        await asyncio.sleep(0.03)  # original 15s enclosing approval would expire
        assert not work.done() and not sent.called
        with pytest.raises(BrowserRefused, match="OWNER_APPROVAL_REQUIRED"):
            await broker.check_observation()
        assert "synthetic-private-login" not in str(terms) and "synthetic-cookie" not in str(terms)
        assert "synthetic-private-path" not in str(terms) and "synthetic-private-header" not in str(
            terms
        )
        assert terms[0]["destination"] == "https://example.com"
        assert terms[0]["scope"] == scope.model_dump(mode="json")
        if takeover:
            active_epoch[0] += 1
        release.set()
        if takeover:
            with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
                await work
            assert not sent.called
            return
        assert (await work).body == b"ok"
        assert sent.call_count == 1
        await broker.check_observation()
        assert "synthetic-private-login" not in str(await log.replay())
        with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
            await broker.fetch(request)  # same exact request cannot dispatch twice
        assert sent.call_count == 1
    finally:
        release.set()
        await broker.close()
        await asyncio.gather(work, return_exceptions=True)


def _credential_fixture(policy="autonomous"):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser.credential_contracts import (
        CredentialDescriptor,
        CredentialLease,
        CredentialUseRequest,
    )
    from hushh_mcp.services.pod_browser.credential_use import BrowserCredentialUse
    from tests.helpers.pod_browser import Executor, control, shared_readiness

    auth = Authority()
    entered, release = asyncio.Event(), asyncio.Event()
    descriptor = CredentialDescriptor(
        handle="cred_" + "a" * 32,
        origin="https://example.com",
        record_revision=1,
        policy_generation=1,
        custody_generation=1,
        autonomy_policy=policy,
    )
    leases, approvals = [], []

    class Driver(Executor):
        fills = 0
        clean = True

        async def verify_credential_targets(self, request):
            assert request.origin == "https://example.com"
            return {
                "action_url": "https://example.com/session",
                "encoding": "application/x-www-form-urlencoded",
            }

        async def fill_credentials(self, request, lease, *, scope, check):
            await check()
            assert lease.password == bytearray(b"synthetic-private-password")
            self.fills += 1
            import hashlib

            from hushh_mcp.services.pod_browser.contracts import BrowserRequest, BrowserResponse

            sent = BrowserRequest(
                url=lease.submission.target["action_url"],
                method="POST",
                body=b"synthetic-form",
                headers=(("Content-Type", "application/x-www-form-urlencoded"),),
                scope=scope,
            )
            proof = {
                "kind": "submit",
                "operation_id": request.operation_id,
                "request_id": "synthetic-native-form",
                "action_url": sent.url,
                "body_sha256": hashlib.sha256(sent.body).hexdigest(),
            }
            assert await lease.submission.authorize(sent, proof)
            lease.submission.response(
                sent, proof, BrowserResponse(status=200, headers=(), body=b"ok")
            )
            return {"submitted": True, "cleared": self.clean}

        async def require_clear_secret_inputs(self):
            if not self.clean:
                raise BrowserRefused("BROWSER_SECRET_FIELDS_NOT_CLEARED")

    class Source:
        rows = (descriptor,)

        async def catalog(self, bound, origin):
            await auth.check_binding(bound)
            return self.rows

        @asynccontextmanager
        async def open(self, bound, selected):
            lease = CredentialLease(
                bytearray(b"synthetic-user"),
                bytearray(b"synthetic-private-password"),
                lambda: auth.check_binding(bound),
            )
            leases.append(lease)
            try:
                entered.set()
                await release.wait()
                await lease.recheck()
                yield lease
            finally:
                lease.clear()

    async def require(bound, purpose, terms):
        approvals.append((purpose, terms))
        await auth.check_binding(bound)

    driver, source = Driver(), Source()
    state = control(
        driver=driver,
        auth=auth,
        ready=shared_readiness(
            credential_entry_verified=True,
            credential_cleanup_verified=True,
            credential_isolation_verified=True,
        ),
    )
    port = BrowserCredentialUse(
        state,
        source,
        SimpleNamespace(check_binding=auth.check_binding, require=require),
        allowed_origins=[descriptor.origin],
    )
    state.credentials = port
    request = CredentialUseRequest(
        operation_id="credential_operation",
        handle=descriptor.handle,
        origin=descriptor.origin,
        control_epoch=1,
        targets={
            "username": {"x": 10, "y": 10},
            "password": {"x": 10, "y": 40},
            "submit": {"x": 10, "y": 70},
        },
    )
    return SimpleNamespace(
        auth=auth,
        control=state,
        port=port,
        driver=driver,
        source=source,
        request=request,
        entered=entered,
        release=release,
        leases=leases,
        approvals=approvals,
    )


@pytest.mark.parametrize(
    "termination,pending_stage",
    [
        ("stop", "lease"),
        ("expiry", "lease"),
        ("update_drain", "lease"),
        ("stop", "refusal_cleanup"),
    ],
)
async def test_credential_cancellation_joins_teardown_and_releases_admission(
    monkeypatch, termination, pending_stage
):
    from hushh_mcp.services.pod_browser.credential_use import BrowserCredentialUse
    from tests.helpers.pod_browser import shared_readiness

    sensitive = _credential_fixture()
    fixture = task_runtime_fixture(
        monkeypatch,
        ready=shared_readiness(
            credential_entry_verified=True,
            credential_cleanup_verified=True,
            credential_isolation_verified=True,
        ),
    )
    started = await approved_task(fixture)
    task = fixture.runtime._tasks[started.binding.task_id]
    control = task.control
    for method in ("verify_credential_targets", "fill_credentials", "require_clear_secret_inputs"):
        monkeypatch.setattr(
            fixture.driver, method, getattr(sensitive.driver, method), raising=False
        )
    if pending_stage == "refusal_cleanup":

        async def manual_required(request):
            raise BrowserRefused("BROWSER_CREDENTIAL_MANUAL_REQUIRED")

        monkeypatch.setattr(fixture.driver, "verify_credential_targets", manual_required)
        fixture.driver.entered.clear()
        fixture.driver.release = asyncio.Event()
    control.credentials = BrowserCredentialUse(
        control, sensitive.source, task.consent, allowed_origins=[sensitive.request.origin]
    )
    control.credentials.selection = sensitive.request.model_copy(
        update={"control_epoch": control.control_epoch}
    )
    closing_entered, release_close = asyncio.Event(), asyncio.Event()
    original_close = fixture.driver.close
    worker = shutdown = None

    async def close():
        closing_entered.set()
        await release_close.wait()
        await original_close()

    try:
        await fixture.runtime.use_credential(
            fixture.owner,
            task.binding.task_id,
            handle=sensitive.request.handle,
            operation_id=sensitive.request.operation_id,
            control_epoch=control.control_epoch,
        )
        worker = task.credential_worker
        entered = sensitive.entered if pending_stage == "lease" else fixture.driver.entered
        await asyncio.wait_for(entered.wait(), 1)
        monkeypatch.setattr(fixture.driver, "close", close)
        if termination == "stop":
            shutdown = asyncio.create_task(
                fixture.runtime.control(
                    fixture.owner, task.binding.task_id, "cancel", control.control_epoch
                )
            )
        elif termination == "update_drain":
            shutdown = asyncio.create_task(fixture.runtime.drain())
        else:
            monkeypatch.setattr(
                fixture.runtime._lifecycle, "_clock", lambda: task.binding.expires_at
            )
            shutdown = asyncio.create_task(task.finished.wait())
        await asyncio.wait_for(closing_entered.wait(), 2)
        assert fixture.admission._states["epoch"].active == 1
        assert not task.finished.is_set()
        release_close.set()
        done, _ = await asyncio.wait({shutdown}, timeout=2)
        assert shutdown in done, "credential cancellation must not join its own lifecycle close"
        await shutdown
        assert worker.cancelled()
        assert task.closed and task.finished.is_set()
        assert fixture.admission._states["epoch"].active == 0
        assert fixture.driver.calls.count("close") >= 1
        assert sensitive.driver.fills == 0
        assert bool(sensitive.leases) == (pending_stage == "lease")
        assert all(
            not any(lease.password) and not any(lease.username) for lease in sensitive.leases
        )
    finally:
        sensitive.release.set()
        release_close.set()
        if fixture.driver.release is not None:
            fixture.driver.release.set()
        # A regression leaves the worker joining close while close joins it.
        # A second cancellation breaks only this synthetic task's cycle so a
        # failing negative control cannot retain test workers or admission.
        if worker is not None and not worker.done():
            worker.cancel()
        if worker is not None:
            await asyncio.gather(worker, return_exceptions=True)
        pending = [job for job in (shutdown, task.closing) if job is not None]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await fixture.runtime.drain()


@pytest.mark.parametrize(
    "policy,fault",
    [
        ("autonomous", None),
        ("confirm_before_fill", None),
        ("autonomous", "revoke"),
        ("autonomous", "stop"),
        ("autonomous", "cleanup"),
    ],
)
async def test_private_credential_transaction_fences_observation_rechecks_and_never_replays(
    policy, fault
):
    fixture = _credential_fixture(policy)
    await fixture.control.initialize()
    work = asyncio.create_task(fixture.port.use(fixture.request))
    try:
        await asyncio.wait_for(fixture.entered.wait(), 1)
        assert fixture.control.latest_frame is None and fixture.control.control_owner == "agent"
        with pytest.raises(BrowserRefused, match="MODEL_OBSERVATION_PAUSED"):
            await fixture.control.require_model_observation()
        with pytest.raises(BrowserRefused, match="CREDENTIAL_ENTRY_ACTIVE"):
            await fixture.control.take_control()
        assert [item[0] for item in fixture.approvals] == (
            ["credential_fill"] if policy == "confirm_before_fill" else []
        )
        if fault == "revoke":
            fixture.auth.revoked = True
        elif fault == "stop":
            stopping = asyncio.create_task(fixture.control.stop())
            await asyncio.sleep(0)  # Stop publishes the fence before joining the action lock.
            fixture.release.set()
            await stopping
        elif fault == "cleanup":
            fixture.driver.clean = False
        fixture.release.set()
        if fault:
            with pytest.raises(BrowserRefused):
                await work
            assert fixture.control.latest_frame is None
            assert fixture.driver.fills == (1 if fault == "cleanup" else 0)
        else:
            assert await work == {"state": "submitted", "origin": "https://example.com"}
            assert fixture.driver.fills == 1
            assert await fixture.control.require_model_observation() == 2
            assert fixture.control.latest_frame is not None
            assert [state for _, state in fixture.auth.journal] == ["dispatch", "settled"]
            with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
                await fixture.port.use(fixture.request.model_copy(update={"control_epoch": 2}))
        assert all(not any(lease.password) and not any(lease.username) for lease in fixture.leases)
    finally:
        fixture.release.set()
        await asyncio.gather(work, return_exceptions=True)
        await fixture.control.stop()


async def test_credential_owner_selection_is_a_completed_call_barrier_and_unqualified_execution_stays_closed():
    fixture = _credential_fixture()
    fixture.control.readiness = fixture.control.readiness.model_copy(
        update={"credential_isolation_verified": False}
    )
    with pytest.raises(BrowserRefused, match="EXECUTION_UNQUALIFIED"):
        await fixture.port.catalog(fixture.request.origin)
    fixture.control.readiness = fixture.control.readiness.model_copy(
        update={"credential_isolation_verified": True}
    )
    fixture.control._actions = 60
    with pytest.raises(BrowserRefused, match="CONTINUATION_REQUIRED"):
        await fixture.port.use(fixture.request)
    assert not fixture.leases
    fixture.control._actions = 0
    fixture.source.rows = ()  # vault-only logins are intentionally absent from durable pod catalog
    with pytest.raises(BrowserRefused, match="CREDENTIAL_OWNER_REQUIRED"):
        await fixture.port.use(fixture.request.model_copy(update={"handle": "owner_selection"}))
    with pytest.raises(BrowserRefused, match="MODEL_OBSERVATION_PAUSED"):
        await fixture.control.require_model_observation()
    assert fixture.port.selection.targets == fixture.request.targets and not fixture.leases
    await fixture.control.initialize()
    await fixture.control.take_control()
    await fixture.control.resume_agent()
    assert fixture.port.selection is None and await fixture.control.require_model_observation() == 3


@pytest.mark.parametrize("fault", [None, "replay", "expired", "epoch", "revision", "recipient"])
async def test_vault_only_seal_is_task_bound_current_and_one_use_before_unwrap(fault):
    import time
    from uuid import uuid4

    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    from hushh_mcp.services import pod_sealed_envelope as sealed
    from hushh_mcp.services.pod_browser.credential_transient import PURPOSE, open_transient
    from hushh_mcp.services.website_credentials import CredentialRefused

    fixture = _credential_fixture()
    bound = binding(expires_at=int(time.time()) + 600)
    key = X25519PrivateKey.generate()
    aad = dict(
        purpose=PURPOSE.name,
        ownerId=bound.owner_id,
        credentialId=fixture.request.handle,
        recordRevision=1,
        policyGeneration=1,
        custodyGeneration=1,
        hushhId=bound.pod_id,
        podKeyId="key",
        taskId=bound.task_id,
        incarnation=bound.incarnation,
        controlEpoch=1,
        origin=fixture.request.origin,
        operationId=fixture.request.operation_id,
        expiresAt=int(time.time()) + 50,
        nonce=str(uuid4()),
    )
    selection = {"synthetic": "exact-authoritative-selection"}
    if fault == "expired":
        aad["expiresAt"] = int(time.time()) - 1
    if fault == "epoch":
        aad["controlEpoch"] = 2
    envelope = sealed.seal(
        {"username": "synthetic-user", "password": "synthetic-password", "selection": selection},
        purpose=PURPOSE,
        pod_public_key_raw=sealed.raw_public(key.public_key()),
        aad=aad,
    )
    claims = []

    class Source:
        async def validate_transient(self, value, candidate, selected):
            assert value == bound and selected == selection
            if fault == "revision":
                raise CredentialRefused("CREDENTIAL_REVISION_STALE")

    async def claim():
        if claims:
            raise BrowserRefused("BROWSER_ACTION_REPLAY")
        claims.append(aad["nonce"])

    async def use():
        async with open_transient(
            Source(),
            bound,
            fixture.request,
            envelope,
            selection,
            private_key=X25519PrivateKey.generate() if fault == "recipient" else key,
            claim=claim,
        ) as lease:
            assert lease.password == bytearray(b"synthetic-password")
            await lease.recheck()
            return lease

    if fault not in (None, "replay"):
        with pytest.raises((BrowserRefused, CredentialRefused)):
            await use()
        assert len(claims) == (1 if fault == "recipient" else 0)
    else:
        lease = await use()
        assert not any(lease.password) and not any(lease.username)
        with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
            await use()
        assert len(claims) == 1


async def test_vault_only_full_transaction_uses_existing_task_authority_and_durable_nonce_journal(
    tmp_path,
):
    import time
    from contextlib import asynccontextmanager
    from uuid import uuid4

    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    from hushh_mcp.services import pod_sealed_envelope as sealed
    from hushh_mcp.services.pod_browser.credential_transient import PURPOSE, open_transient
    from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
    from hushh_mcp.services.pod_browser.execution_authority import (
        BrowserExecutionAuthority,
        PublicResearchPolicy,
    )
    from hushh_mcp.services.pod_browser.task_authority import TaskAuthority
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    fixture = _credential_fixture()
    now = time.time()
    fixture.control.binding = bound = binding(expires_at=int(now) + 600)
    fixture.control._wall_clock = lambda: time.time()
    key = X25519PrivateKey.generate()
    aad = {
        "purpose": PURPOSE.name,
        "ownerId": "owner",
        "credentialId": fixture.request.handle,
        "recordRevision": 1,
        "policyGeneration": 1,
        "custodyGeneration": 1,
        "hushhId": "pod",
        "podKeyId": "key",
        "taskId": "task",
        "incarnation": "epoch",
        "controlEpoch": 1,
        "origin": fixture.request.origin,
        "operationId": fixture.request.operation_id,
        "expiresAt": int(now) + 50,
        "nonce": str(uuid4()),
    }
    selection = {"synthetic": "current-exact-export"}
    envelope = sealed.seal(
        {
            "username": "synthetic-user",
            "password": "synthetic-private-password",
            "selection": selection,
        },
        purpose=PURPOSE,
        pod_public_key_raw=sealed.raw_public(key.public_key()),
        aad=aad,
    )
    leases = []

    class Source:
        async def validate_transient(self, value, candidate, selected):
            assert value == bound and selected == selection and candidate == aad
            await fixture.auth.check_binding(value)

        @asynccontextmanager
        async def open_transient(self, value, request, envelope, selected, *, claim):
            assert fixture.control.latest_frame is None
            with pytest.raises(BrowserRefused, match="MODEL_OBSERVATION_PAUSED"):
                await fixture.control.require_model_observation()
            async with open_transient(
                self, value, request, envelope, selected, private_key=key, claim=claim
            ) as lease:
                leases.append(lease)
                yield lease

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")
    policy = PublicResearchPolicy(
        page_urls=(fixture.request.origin + "/login",),
        interactive_origins=(fixture.request.origin,),
    )

    def authority():
        journal = BrowserDispatchJournal(log, key=b"J" * 32, owner_id="owner", pod_id="pod")
        return TaskAuthority(
            bound, fixture.auth, BrowserExecutionAuthority(bound, fixture.auth, journal, policy)
        )

    fixture.control._authority = authority()
    fixture.port.source = Source()
    await fixture.control.initialize()
    try:
        assert await fixture.port.use(
            fixture.request, owner_selected=True, transient=(envelope, selection)
        ) == {"state": "submitted", "origin": fixture.request.origin}
        assert fixture.driver.fills == 1 and all(not any(lease.password) for lease in leases)
        assert await fixture.control.require_model_observation() == 2
        # Reconstructed production adapters must refuse the same opaque nonce;
        # process-local operation sets are not the recovery replay boundary.
        with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
            await authority().consume_credential_nonce(bound, aad["nonce"])
        records = await log.replay()
        assert len(records) == 4 and "synthetic-private-password" not in str(records)
        assert "type" not in fixture.driver.calls
    finally:
        await fixture.control.stop()


@pytest.mark.parametrize("fault", [None, "body", "destination", "epoch", "revoke"])
async def test_authentication_policy_permits_only_exact_native_post_and_linked_read_without_owner(
    tmp_path, fault
):
    import hashlib
    import time
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import httpcore

    from hushh_mcp.services.pod_browser.contracts import BrowserExecutionScope, BrowserRequest
    from hushh_mcp.services.pod_browser.credential_contracts import CredentialDescriptor
    from hushh_mcp.services.pod_browser.credential_network import CredentialSubmission
    from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
    from hushh_mcp.services.pod_browser.execution_authority import (
        PublicResearchNetworkAuthority,
        PublicResearchPolicy,
    )
    from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    fixture = _credential_fixture()
    bound = binding(expires_at=int(time.time()) + 600)
    reviews = []
    review_terms = []

    async def review(value, purpose, terms):
        reviews.append(purpose)
        review_terms.append(terms)
        raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")

    consent = SimpleNamespace(check_binding=fixture.auth.check_binding, require=review)
    journal = BrowserDispatchJournal(
        PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner"),
        key=b"J" * 32,
        owner_id="owner",
        pod_id="pod",
    )
    authority = PublicResearchNetworkAuthority(
        bound,
        consent,
        journal,
        PublicResearchPolicy(
            page_urls=("https://example.com/login",),
            static_prefixes=("https://example.com/assets/",),
            interactive_origins=("https://example.com",),
        ),
    )
    broker = BrowserNetworkBroker(
        binding=bound, allowed_origins=frozenset({"https://example.com"}), authority=authority
    )
    scope = BrowserExecutionScope(
        sequence=1, control_epoch=2, actor="agent", deadline_at=time.time() + 20
    )
    broker.bind_scope_validator(lambda candidate: None)
    descriptor = CredentialDescriptor(
        handle=fixture.request.handle,
        origin=fixture.request.origin,
        record_revision=1,
        autonomy_policy="autonomous",
        policy_generation=1,
        custody_generation=1,
    )
    credential = CredentialSubmission(
        bound,
        descriptor,
        fixture.request,
        scope,
        {
            "action_url": "https://example.com/session",
            "encoding": "application/x-www-form-urlencoded",
        },
        lambda: fixture.auth.check_binding(bound),
    )
    broker.bind_credential_authority(credential)

    class Pool:
        calls = 0

        async def handle_async_request(self, request):
            self.calls += 1
            if request.url.target.endswith(b"/start.js"):
                return httpcore.Response(
                    303, headers=[(b"location", b"/assets/final.js")], content=b""
                )
            if request.url.target.endswith(b"/start.css"):
                return httpcore.Response(
                    303, headers=[(b"location", b"/assets/final.css")], content=b""
                )
            return (
                httpcore.Response(303, headers=[(b"location", b"/account")], content=b"")
                if self.calls == 1
                else httpcore.Response(200, content=b"safe")
            )

        async def aclose(self):
            pass

    await broker._pool.aclose()
    pool = broker._pool = Pool()
    request = BrowserRequest(
        url="https://example.com/session",
        method="POST",
        body=b"exact-native-form",
        headers=(("Content-Type", "application/x-www-form-urlencoded"),),
        scope=scope,
    )
    proof = {
        "kind": "submit",
        "operation_id": fixture.request.operation_id,
        "request_id": "native-1",
        "action_url": request.url,
        "body_sha256": hashlib.sha256(request.body).hexdigest(),
    }
    if fault == "body":
        request = request.model_copy(update={"body": b"another-effect"})
    elif fault == "destination":
        request = request.model_copy(update={"url": "https://example.com/payment"})
    elif fault == "epoch":
        request = request.model_copy(
            update={"scope": scope.model_copy(update={"control_epoch": 3})}
        )
    elif fault == "revoke":
        fixture.auth.revoked = True
    driver = None
    try:
        if fault:
            with pytest.raises(BrowserRefused):
                await broker.fetch(request, credential_proof=proof)
            assert pool.calls == 0 and not reviews
        else:
            driver = PlaywrightExecutor(network=broker, chromium_sandbox=True)
            driver._main_frame_id = "main"
            driver._credential_operation = fixture.request.operation_id
            driver._credential_targets = SimpleNamespace(
                submitting=True,
                navigation_cleanup=SimpleNamespace(
                    require_receipt=AsyncMock(),
                    authentication={"action_url": request.url, "body_sha256": proof["body_sha256"]},
                ),
                original_cleared=False,
            )
            delivered = []

            async def send(method, params):
                delivered.append((method, params))

            driver._cdp = SimpleNamespace(send=send)

            async def intercepted(identifier, value, kind="Document", parent=None, frame="main"):
                raw = {"url": value.url, "method": value.method, "headers": dict(value.headers)}
                if value.body:
                    raw.update(hasPostData=True, postData=value.body.decode())
                await driver._paused_request(
                    {
                        "requestId": identifier,
                        "request": raw,
                        "resourceType": kind,
                        "frameId": frame,
                        **({"redirectedRequestId": parent} if parent else {}),
                    },
                    scope=value.scope,
                )
                return delivered[-1]

            method, response = await intercepted("native-1", request)
            assert method == "Fetch.fulfillRequest" and response["responseCode"] == 303
            assert not credential.completed
            redirected = BrowserRequest(
                url="https://example.com/account", method="GET", scope=scope
            )
            with pytest.raises(BrowserRefused, match="CREDENTIAL_REQUEST_REFUSED"):
                await broker.fetch(
                    redirected,
                    credential_proof={
                        "kind": "redirect",
                        "operation_id": fixture.request.operation_id,
                        "request_id": "forged-read",
                        "parent_request_id": "unrelated-parent",
                    },
                )

            method, response = await intercepted("native-2", redirected, parent="native-1")
            assert method == "Fetch.fulfillRequest" and response["responseCode"] == 200
            assert credential.completed and pool.calls == 2 and not reviews
            for kind, extension in (("Script", "js"), ("Stylesheet", "css")):
                original = redirected.model_copy(
                    update={"url": f"https://example.com/assets/start.{extension}"}
                )
                final = redirected.model_copy(
                    update={"url": f"https://example.com/assets/final.{extension}"}
                )
                assert (await intercepted(f"{kind}-1", original, kind))[0] == "Fetch.fulfillRequest"
                assert (await intercepted(f"{kind}-2", final, kind, parent=f"{kind}-1"))[
                    0
                ] == "Fetch.fulfillRequest"
            ordinary_document = redirected.model_copy(
                update={"url": "https://example.com/assets/ordinary"}
            )
            assert (await intercepted("ordinary-document", ordinary_document, parent="Script-1"))[
                0
            ] == "Fetch.fulfillRequest"
            assert (
                await intercepted(
                    "foreign-frame", ordinary_document, parent="native-1", frame="child"
                )
            )[0] == "Fetch.fulfillRequest"
            assert credential.completed and pool.calls == 8 and not reviews
            with pytest.raises(BrowserRefused, match="ACTION_REPLAY"):
                await broker.fetch(request, credential_proof=proof)
            for identifier, value in (
                (
                    "unrelated-write",
                    request.model_copy(update={"url": "https://example.com/payment"}),
                ),
                (
                    "same-url-mismatch",
                    request.model_copy(update={"body": b"mismatched-native-form"}),
                ),
            ):
                assert (await intercepted(identifier, value))[0] == "Fetch.failRequest"
            assert reviews == ["disclose", "disclose"] and pool.calls == 8
            assert "exact-native-form" not in str(review_terms)
            assert "mismatched-native-form" not in str(review_terms)
    finally:
        if driver is not None:
            await driver.close()
        await broker.close()
