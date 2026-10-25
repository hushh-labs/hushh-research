"""Bounded Chromium operations in the qualified owner runtime.

Request interception enforces normal application policy. In the shared-owner
configuration it is not containment against a compromised browser process.
"""

from __future__ import annotations

import asyncio
import base64
from typing import TYPE_CHECKING, Protocol, TypeVar, cast

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
from .public_profile import CHROMIUM_LANGUAGES, LANGUAGE, USER_AGENT
from .session_state import RememberedState

T = TypeVar("T")


def _argument(value: T | None) -> T:
    if value is None:
        raise BrowserRefused("BROWSER_ACTION_INVALID")
    return value


class BrowserFetchPort(Protocol):
    async def fetch(self, request: BrowserRequest) -> BrowserResponse: ...


def fulfill_headers(headers: tuple[tuple[str, str], ...]) -> dict[str, str]:
    """Pinned Chromium splits newline-delimited Set-Cookie into separate headers.

    Never comma-join cookies (Expires contains commas). Original header values
    cannot contain CR/LF. Ambiguous singleton headers are refused.
    """
    result: dict[str, str] = {}
    for name, value in headers:
        name = name.lower()
        if not name or any(c in name + value for c in "\r\n"):
            raise BrowserRefused("BROWSER_RESPONSE_HEADERS_REFUSED")
        if name in result:
            if name in {"location", "content-length", "content-type"}:
                raise BrowserRefused("BROWSER_RESPONSE_HEADERS_REFUSED")
            result[name] += ("\n" if name == "set-cookie" else ", ") + value
        else:
            result[name] = value
    return result


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
        self._redirects: dict[
            str, tuple[BrowserExecutionScope | None, asyncio.Future[None], str | None]
        ] = {}
        self._document_target: str | None = None
        self._navigation_failed = False

    def _request_paused(self, event: dict) -> None:
        # Capture synchronously at delivery. Never consult a later input's
        # identity after awaiting. Exact request commitments still need review;
        # this is an execution bound, not proof of JavaScript causality.
        predecessor = event.get("redirectedRequestId")
        pending = self._redirects.pop(predecessor, None) if predecessor else None
        # A late redirect belongs to its original action, including after
        # takeover. Never borrow the next input's currently active scope.
        scope = pending[0] if pending else None if predecessor else self._scope
        task = asyncio.create_task(self._paused_request(event, scope=scope))
        self._requests.add(task)
        task.add_done_callback(self._requests.discard)
        if pending and not pending[1].done():
            pending[1].set_result(None)

    def _network_finished(self, event: dict, *, failed: bool = False) -> None:
        for identifier, (_, successor, network_id) in tuple(self._redirects.items()):
            if network_id is not None and network_id == event.get("requestId"):
                self._redirects.pop(identifier)
                self._navigation_failed |= failed
                if not successor.done():
                    successor.set_result(None)

    async def _settle_requests(self) -> None:
        while self._requests or self._redirects:
            await asyncio.gather(
                *tuple(self._requests), *(entry[1] for entry in self._redirects.values())
            )
        if self._navigation_failed:
            raise BrowserRefused("BROWSER_ACTION_FAILED")

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
            if event.get("redirectedRequestId") and scope is None:
                raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")
            body = b""
            if request.get("hasPostData"):
                entries = request.get("postDataEntries")
                if entries and all("bytes" in entry for entry in entries):
                    body = b"".join(
                        base64.b64decode(entry["bytes"], validate=True) for entry in entries
                    )
                elif "postData" in request:
                    body = request["postData"].encode()
                else:
                    raise BrowserRefused("BROWSER_REQUEST_BODY_UNAVAILABLE")
            response = await self._network.fetch(
                BrowserRequest(
                    scope=scope,
                    url=request["url"],
                    method=request["method"],
                    body=body,
                    headers=tuple(
                        (name, str(value))
                        for name, value in request["headers"].items()
                        if name.lower()
                        not in {"host", "connection", "content-length", "accept-encoding"}
                    ),
                )
            )
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
            if response.status in {301, 302, 303, 307, 308} and any(
                name.lower() == "location" for name, _ in response.headers
            ):
                if len(self._redirects) >= 64 or request_id in self._redirects:
                    raise BrowserRefused("BROWSER_REDIRECT_LIMIT")
                # Register before fulfillment: Chromium may deliver the next
                # paused request after this handler has returned. Keep the host
                # action scope alive until that exact chain has settled.
                self._redirects[request_id] = (
                    scope,
                    asyncio.get_running_loop().create_future(),
                    event.get("networkId"),
                )
            elif (
                event.get("resourceType") == "Document"
                and event.get("frameId") == self._main_frame_id
            ):
                self._document_target = request["url"]
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
            pending = self._redirects.pop(request_id, None)
            if pending and not pending[1].done():
                pending[1].set_result(None)
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
            self._document_target = None
            self._navigation_failed = False
            timeout_ms = scope.remaining() * 1000 if scope is not None else 15000
            match action.operation:
                case "navigate":
                    await self._navigate_with_download(page, action, timeout_ms)
                case "click":
                    await page.mouse.click(_argument(action.x), _argument(action.y))
                case "hover":
                    await page.mouse.move(_argument(action.x), _argument(action.y))
                case "type":
                    if not action.focus_existing:
                        await page.mouse.click(_argument(action.x), _argument(action.y))
                    if action.clear_before_typing:
                        await page.keyboard.press("ControlOrMeta+A")
                        await page.keyboard.press("Backspace")
                    await page.keyboard.insert_text(_argument(action.text))
                    if action.press_enter:
                        await page.keyboard.press("Enter")
                case "scroll":
                    if action.magnitude is None or action.direction is None:
                        raise BrowserRefused("BROWSER_ACTION_INVALID")
                    if action.x is not None:
                        await page.mouse.move(action.x, _argument(action.y))
                    x, y = {
                        "up": (0, -action.magnitude),
                        "down": (0, action.magnitude),
                        "left": (-action.magnitude, 0),
                        "right": (action.magnitude, 0),
                    }[action.direction]
                    await page.mouse.wheel(x, y)
                case "back":
                    await page.go_back(wait_until="domcontentloaded", timeout=timeout_ms)
                case "forward":
                    await page.go_forward(wait_until="domcontentloaded", timeout=timeout_ms)
                case "keys":
                    await page.keyboard.press("+".join(action.keys))
                case "drag":
                    await page.mouse.move(_argument(action.x), _argument(action.y))
                    await page.mouse.down()
                    try:
                        await page.mouse.move(
                            _argument(action.destination_x),
                            _argument(action.destination_y),
                            steps=5,
                        )
                    finally:
                        await page.mouse.up()
                case "observe":
                    pass
                case "resize":
                    await page.set_viewport_size(
                        {"width": _argument(action.width), "height": _argument(action.height)}
                    )
            await self._settle_requests()
            if self._document_target is not None:
                target = self._document_target
                await page.wait_for_url(
                    lambda url: str(url) == target,
                    wait_until="domcontentloaded",
                    timeout=scope.remaining() * 1000 if scope is not None else timeout_ms,
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
        for _, successor, _ in self._redirects.values():
            successor.cancel()
        self._redirects.clear()
        self._document_target = None
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
