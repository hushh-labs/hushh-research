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
