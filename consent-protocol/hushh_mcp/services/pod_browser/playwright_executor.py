"""Sandbox-only Chromium executor. It is never a pod-side fallback.

The component image contains this package only. All network goes through the
broker port; Cloud Run sandbox deny-egress (or verified Azure policy) is the
independent backstop. Installing Playwright on the core pod does not enable it.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from playwright.async_api import Browser, BrowserContext, Page, Playwright

from .contracts import BrowserAction, BrowserFrame, BrowserRefused, BrowserRequest, BrowserResponse


class BrowserFetchPort(Protocol):
    async def fetch(self, request: BrowserRequest) -> BrowserResponse: ...


class SandboxedPlaywrightExecutor:
    def __init__(self, *, network: BrowserFetchPort, sandbox_verified: bool) -> None:
        if not sandbox_verified:
            raise BrowserRefused("BROWSER_ISOLATION_NOT_READY")
        self._network = network
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self._uncertain = False
        self._closed = False

    async def _route(self, route) -> None:
        request = route.request
        try:
            headers = tuple(
                (name, value)
                for name, value in (await request.all_headers()).items()
                if name.lower()
                not in {
                    "host",
                    "connection",
                    "content-length",
                    "accept-encoding",
                }
            )
            response = await self._network.fetch(
                BrowserRequest(
                    url=request.url,
                    method=request.method,
                    headers=headers,
                    body=request.post_data_buffer or b"",
                )
            )
            await route.fulfill(
                status=response.status, headers=dict(response.headers), body=response.body
            )
        except Exception as exc:
            if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN":
                self._uncertain = True
            # Never route.continue_(), route.fetch() or fall back to a direct
            # connection. Do not log URLs, page contents or credential headers.
            await route.abort("blockedbyclient")

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
                chromium_sandbox=True,
                args=["--disable-quic", "--disable-background-networking"],
            )
            if self._closed:
                raise BrowserRefused("BROWSER_STOPPED")
            self._context = await self._browser.new_context(
                viewport={"width": 1280, "height": 720},
                service_workers="block",
                accept_downloads=False,
            )
            await self._context.route("**/*", self._route)
            await self._context.route_web_socket("**/*", lambda ws: ws.close())
            self._page = await self._context.new_page()
            self._context.on("page", lambda page: page.close())
            self._page.set_default_timeout(10000)
            self._page.set_default_navigation_timeout(15000)
        except BaseException as exc:
            await self.close()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise BrowserRefused("BROWSER_STARTUP_FAILED") from None

    async def execute(self, action: BrowserAction) -> BrowserFrame:
        page = self._page
        if page is None or page.is_closed():
            raise BrowserRefused("BROWSER_NOT_INITIALIZED")
        if self._uncertain:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        try:
            match action.operation:
                case "navigate":
                    await page.goto(action.url, wait_until="domcontentloaded")
                case "click":
                    await page.mouse.click(action.x, action.y)
                case "hover":
                    await page.mouse.move(action.x, action.y)
                case "type":
                    await page.mouse.click(action.x, action.y)
                    if action.clear_before_typing:
                        await page.keyboard.press("ControlOrMeta+A")
                        await page.keyboard.press("Backspace")
                    await page.keyboard.insert_text(action.text)
                    if action.press_enter:
                        await page.keyboard.press("Enter")
                case "scroll":
                    if action.magnitude is None or action.direction is None:
                        raise BrowserRefused("BROWSER_ACTION_INVALID")
                    if action.x is not None:
                        await page.mouse.move(action.x, action.y)
                    x, y = {
                        "up": (0, -action.magnitude),
                        "down": (0, action.magnitude),
                        "left": (-action.magnitude, 0),
                        "right": (action.magnitude, 0),
                    }[action.direction]
                    await page.mouse.wheel(x, y)
                case "back":
                    await page.go_back(wait_until="domcontentloaded")
                case "forward":
                    await page.go_forward(wait_until="domcontentloaded")
                case "keys":
                    await page.keyboard.press("+".join(action.keys))
                case "drag":
                    await page.mouse.move(action.x, action.y)
                    await page.mouse.down()
                    try:
                        await page.mouse.move(action.destination_x, action.destination_y, steps=5)
                    finally:
                        await page.mouse.up()
                case "observe":
                    pass
            png = await page.screenshot(type="png", timeout=10000)
            if self._uncertain:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
            return BrowserFrame(
                sequence=action.sequence,
                width=1280,
                height=720,
                url=page.url,
                png=png,
            )
        except BrowserRefused:
            raise
        except Exception:
            if self._uncertain:
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None
            raise BrowserRefused("BROWSER_ACTION_FAILED") from None

    async def close(self) -> None:
        self._closed = True
        browser, playwright = self._browser, self._playwright
        self._browser = self._context = self._page = self._playwright = None
        try:
            if browser is not None:
                await browser.close()
        finally:
            if playwright is not None:
                await playwright.stop()
