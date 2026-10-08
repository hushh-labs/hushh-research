#!/usr/bin/env python3
"""Synthetic real-Chromium session fixture. Does not qualify cloud isolation.

Run locally with pinned Playwright 1.63.0 and its Chromium installed. All HTTPS
responses are fabricated in memory; no real website, owner or credential is used.
Only pass/fail metadata is emitted. No screenshot, state or trace is saved.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import time
import types
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
# Mirror the browser-only image's namespace packages. Importing the core pod's
# package initializer would hydrate unrelated private environment configuration.
for name in ("hushh_mcp", "hushh_mcp.services"):
    namespace = types.ModuleType(name)
    namespace.__path__ = [str(root.joinpath(*name.split(".")))]
    sys.modules[name] = namespace

contracts = importlib.import_module("hushh_mcp.services.pod_browser.contracts")
BrowserAction, BrowserRefused, BrowserResponse = (
    contracts.BrowserAction,
    contracts.BrowserRefused,
    contracts.BrowserResponse,
)
public_origin = importlib.import_module("hushh_mcp.services.pod_browser.origin").public_origin
SandboxedPlaywrightExecutor = importlib.import_module(
    "hushh_mcp.services.pod_browser.playwright_executor"
).SandboxedPlaywrightExecutor

ORIGINS = frozenset({"https://example.com", "https://login.example.com"})


class FixtureBroker:
    def __init__(self):
        self.refused = 0
        self.requests: list[str] = []

    async def fetch(self, request):
        self.requests.append(request.url)
        if public_origin(request.url) not in ORIGINS:
            self.refused += 1
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        if request.url == "https://example.com/start":
            return BrowserResponse(
                status=302,
                headers=(
                    ("location", "https://login.example.com/form"),
                    (
                        "set-cookie",
                        "a=fixture-one; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600",
                    ),
                    (
                        "set-cookie",
                        "b=fixture-two; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200",
                    ),
                ),
                body=b"",
            )
        if request.url == "https://example.com/embed":
            body = (
                b'<script>window.blocked=false; addEventListener("securitypolicyviolation",'
                b'e=>{if(e.effectiveDirective==="frame-src")window.blocked=true})</script>'
                b'<iframe src="https://login.example.com/embedded"></iframe>'
            )
        else:
            body = b'<label>Password<input type="password"></label><p>Controlled login</p><script>localStorage.setItem("setting","fixture")</script>'
        return BrowserResponse(status=200, headers=(("content-type", "text/html"),), body=body)


async def run():
    broker = FixtureBroker()
    executor = SandboxedPlaywrightExecutor(network=broker, sandbox_verified=True)
    try:
        await executor.initialize()
        await executor.execute(
            BrowserAction(
                operation="navigate", sequence=1, control_epoch=1, url="https://example.com/start"
            )
        )
        assert executor._page.url == "https://login.example.com/form"
        await executor._page.get_by_label("Password").fill("synthetic-manual-login")
        state = await executor.export_session(ORIGINS)
        assert {cookie.name for cookie in state.cookies} == {"a", "b"}
        assert all(cookie.secure and cookie.httpOnly for cookie in state.cookies)
        assert {cookie.sameSite for cookie in state.cookies} == {"Strict", "Lax"}
        assert all(cookie.expires > time.time() for cookie in state.cookies)
        # Multiple response cookies survive redirect, including their own scope.
        assert all(cookie.domain == "example.com" for cookie in state.cookies)
        await executor._context.add_cookies(
            [{"name": "session-only", "value": "fixture", "url": "https://example.com"}]
        )
        retained = await executor.export_session(ORIGINS)
        assert "session-only" not in {cookie.name for cookie in retained.cookies}
        await executor._context.clear_cookies()
        await executor.import_session(state, ORIGINS)
        assert {cookie["name"] for cookie in await executor._context.cookies()} == {"a", "b"}
        await executor._page.goto("https://login.example.com/form")
        assert await executor._page.evaluate('localStorage.getItem("setting")') == "fixture"
        # An admitted secondary origin must not enter a model screenshot through
        # a child frame. Current pilot CSP intentionally refuses all frames.
        await executor._page.goto("https://example.com/embed")
        await executor._page.wait_for_function("window.blocked===true")
        assert "https://login.example.com/embedded" not in broker.requests
        # Never let a redirect/subresource expand the approved recipient set.
        try:
            await executor._page.goto("https://unapproved.example.com/")
        except Exception:
            pass
        assert broker.refused >= 1
    finally:
        await executor.close()
    return {
        "controlled_chromium": "passed",
        "cookie_redirect_restore": "passed",
        "unapproved_recipient": "refused",
        "embedded_frame": "refused",
        "cloud_isolation": "unverified",
    }


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(run())))
    except Exception:
        print(json.dumps({"controlled_chromium": "failed"}))
        raise SystemExit(1) from None
