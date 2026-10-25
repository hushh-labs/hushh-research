"""Bounded Chromium operations in the qualified owner runtime.

Request interception enforces normal application policy. In the shared-owner
configuration it is not containment against a compromised browser process.
"""

from __future__ import annotations

import asyncio
import base64
from typing import TYPE_CHECKING, Protocol, cast

if TYPE_CHECKING:
    from playwright.async_api import (
        Browser,
        BrowserContext,
        CDPSession,
        Page,
        Playwright,
        StorageState,
    )

from .contracts import (
    BrowserAction,
    BrowserExecutionScope,
    BrowserFrame,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
)
from .playwright_actions import _argument, perform_action
from .playwright_interception import BrowserRedirects, request_from_event
from .playwright_interception import fulfill_headers as fulfill_headers
from .public_profile import CHROMIUM_LANGUAGES, LANGUAGE, USER_AGENT
from .session_state import RememberedState


class BrowserFetchPort(Protocol):
    async def fetch(self, request: BrowserRequest) -> BrowserResponse: ...


class PlaywrightExecutor:
    def __init__(self, *, network: BrowserFetchPort, chromium_sandbox: bool) -> None:
        if type(chromium_sandbox) is not bool:
            raise BrowserRefused("BROWSER_EXECUTION_MODE_INVALID")
        self._chromium_sandbox = chromium_sandbox
        self._network = network
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self._uncertain = False
        self._closed = False
        self._cdp: CDPSession | None = None
        self._scope: BrowserExecutionScope | None = None
        self._requests: set[asyncio.Task] = set()
        self._navigation_target: tuple[int, str] | None = None
        self._captured_navigation: tuple[int, str] | None = None
        self._main_frame_id: str | None = None
        self._redirects = BrowserRedirects()

    def _request_paused(self, event: dict) -> None:
        # Capture synchronously at delivery. Never consult a later input's
        # identity after awaiting. Exact request commitments still need review;
        # this is an execution bound, not proof of JavaScript causality.
        scope, successor = self._redirects.capture(event, self._scope)
        task = asyncio.create_task(self._paused_request(event, scope=scope))
        self._requests.add(task)
        task.add_done_callback(self._requests.discard)
        if successor is not None and not successor.done():
            successor.set_result(None)

    def _network_finished(self, event: dict, *, failed: bool = False) -> None:
        self._redirects.finished(event, failed=failed)

    async def _settle_requests(self) -> None:
        await self._redirects.settle(self._requests)

    async def _paused_request(
        self, event: dict, *, scope: BrowserExecutionScope | None = None
    ) -> None:
        """Chromium Fetch intercepts every redirect hop; Playwright route does not.

        This internal executor port exposes no CDP commands to the agent. The
        shared owner container does not provide independent Browser isolation.
        """
        request_id = event["requestId"]
        request = event["request"]
        cdp = self._cdp
        if cdp is None or self._closed:
            return
        try:
            response = await self._network.fetch(request_from_event(event, scope))
            # Validate original headers, then preserve the multimap in CDP.
            if (
                response.download_id is not None
                and self._navigation_target is not None
                and event.get("resourceType") == "Document"
                and event.get("frameId") == self._main_frame_id
                and request["url"] == self._navigation_target[1]
                and (scope is None or scope.sequence == self._navigation_target[0])
            ):
                self._captured_navigation = self._navigation_target
            fulfill_headers(response.headers)
            self._redirects.prepare(event, response, scope, self._main_frame_id)
            headers = response.headers + (
                (
                    "content-security-policy",
                    "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'",
                ),
            )
            # Separate CDP targets are not yet qualified. Do not let a document
            # create unbrokered frame/worker targets during normal execution.
            # Existing site CSP remains conjunctive.
            await cdp.send(
                "Fetch.fulfillRequest",
                {
                    "requestId": request_id,
                    "responseCode": response.status,
                    "responseHeaders": [{"name": name, "value": value} for name, value in headers],
                    "body": base64.b64encode(response.body).decode(),
                },
            )
        except Exception as exc:
            self._redirects.discard(request_id)
            if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN":
                self._uncertain = True
            if self._cdp is not None:
                try:
                    await self._cdp.send(
                        "Fetch.failRequest",
                        {"requestId": request_id, "errorReason": "BlockedByClient"},
                    )
                except Exception:
                    pass  # closure cannot justify retry or expose a private error

    async def initialize(self) -> None:
        if self._closed:
            raise BrowserRefused("BROWSER_STOPPED")
        if self._browser is not None:
            return
        from playwright.async_api import async_playwright

        try:
            self._playwright = await async_playwright().start()
            if self._closed:
                raise BrowserRefused("BROWSER_STOPPED")
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                chromium_sandbox=self._chromium_sandbox,
                args=[
                    "--disable-quic",
                    "--disable-background-networking",
                    "--disk-cache-size=33554432",
                    "--media-cache-size=16777216",
                ],
            )
            if self._closed:
                raise BrowserRefused("BROWSER_STOPPED")
            self._context = await self._browser.new_context(
                viewport={"width": 1280, "height": 720},
                service_workers="block",
                accept_downloads=False,
                user_agent=USER_AGENT,
                locale="en-US",
                extra_http_headers={"Accept-Language": LANGUAGE},
            )
            await self._context.route_web_socket("**/*", lambda ws: ws.close())
            self._page = await self._context.new_page()
            self._cdp = await self._context.new_cdp_session(self._page)
            # Playwright also installs default UA metadata. Replace it before
            # any page request: public research uses a fixed, non-private
            # profile, not the host's client hints or locale. Chromium adds the
            # language weights; sending the weighted wire value doubles them.
            await self._cdp.send(
                "Emulation.setUserAgentOverride",
                {"userAgent": USER_AGENT, "acceptLanguage": CHROMIUM_LANGUAGES},
            )
            tree = await self._cdp.send("Page.getFrameTree")
            self._main_frame_id = tree["frameTree"]["frame"]["id"]
            self._cdp.on("Fetch.requestPaused", self._request_paused)
            self._cdp.on("Network.loadingFinished", self._network_finished)
            self._cdp.on(
                "Network.loadingFailed", lambda event: self._network_finished(event, failed=True)
            )
            await self._cdp.send("Network.enable")
            await self._cdp.send(
                "Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}
            )
            self._context.on("page", lambda page: page.close())
            self._page.set_default_timeout(10000)
            self._page.set_default_navigation_timeout(15000)
        except BaseException as exc:
            await self.close()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise BrowserRefused("BROWSER_STARTUP_FAILED") from None

    async def _navigate_with_download(
        self, page: Page, action: BrowserAction, timeout_ms: float
    ) -> None:
        self._navigation_target = (action.sequence, _argument(action.url))
        self._captured_navigation = None
        try:
            await page.goto(
                _argument(action.url), wait_until="domcontentloaded", timeout=timeout_ms
            )
        except Exception as exc:
            # Chromium aborts a navigation acknowledged as a captured
            # attachment. No other aborted navigation becomes success.
            if self._captured_navigation != self._navigation_target or "ERR_ABORTED" not in str(
                exc
            ):
                raise
        finally:
            self._navigation_target = self._captured_navigation = None

    async def execute(
        self, action: BrowserAction, *, scope: BrowserExecutionScope | None = None
    ) -> BrowserFrame:
        self._scope = None
        page = self._page
        if page is None or page.is_closed():
            raise BrowserRefused("BROWSER_NOT_INITIALIZED")
        if self._uncertain:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        try:
            self._scope = scope
            self._redirects.begin_action()
            timeout_ms = scope.remaining() * 1000 if scope is not None else 15000
            await perform_action(page, action, timeout_ms, self._navigate_with_download)
            await self._settle_requests()
            await self._redirects.wait_for_document(
                page, scope.remaining() * 1000 if scope is not None else timeout_ms
            )
            await self._settle_requests()
            png = await page.screenshot(
                type="png", timeout=scope.remaining() * 1000 if scope is not None else 10000
            )
            await self._settle_requests()
            if self._uncertain:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
            return BrowserFrame(
                sequence=action.sequence,
                width=_argument(page.viewport_size)["width"],
                height=_argument(page.viewport_size)["height"],
                url=page.url,
                png=png,
            )
        except asyncio.CancelledError:
            # A cancelled chain cannot be reused with cancelled successor
            # futures or acquire authority from another action.
            await self.close()
            raise
        except BrowserRefused:
            raise
        except Exception:
            if self._uncertain:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None
            raise BrowserRefused("BROWSER_ACTION_FAILED") from None
        finally:
            self._scope = None

    async def close(self) -> None:
        self._closed = True
        pending = tuple(task for task in self._requests if task is not asyncio.current_task())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._requests.clear()
        self._redirects.close()
        self._scope = None
        browser, playwright = self._browser, self._playwright
        self._cdp = None
        self._browser = self._context = self._page = self._playwright = None
        try:
            if browser is not None:
                await browser.close()
        finally:
            if playwright is not None:
                await playwright.stop()

    async def export_session(self, approved_origins: frozenset[str]) -> RememberedState:
        import time

        from .session_state import persistent_state

        if self._context is None or self._closed:
            raise BrowserRefused("BROWSER_NOT_INITIALIZED")
        # No path, IndexedDB, profile, passkey or cache export.
        return persistent_state(
            dict(await self._context.storage_state()), approved_origins, now=time.time()
        )

    async def import_session(
        self, state: RememberedState, approved_origins: frozenset[str]
    ) -> None:
        if self._context is None or self._closed:
            raise BrowserRefused("BROWSER_NOT_INITIALIZED")
        if not isinstance(state, RememberedState):
            raise BrowserRefused("BROWSER_SESSION_STATE_REFUSED")
        state = state.for_origins(approved_origins)
        # Existing page may contain another account's storage: never merge state.
        # set_storage_state replaces the supported state on pinned Playwright.
        await self._context.set_storage_state(
            storage_state=cast("StorageState", state.model_dump(mode="json"))
        )
