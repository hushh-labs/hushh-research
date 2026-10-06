"""Synthetic ports for the browser's owner and transport boundary tests."""

import asyncio
from dataclasses import dataclass, field

from hushh_mcp.services.pod_browser.contracts import (
    BrowserBinding,
    BrowserFrame,
    BrowserNetworkPermit,
    BrowserReadiness,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.control import BrowserControl


def binding(**changes):
    return BrowserBinding(
        **dict(
            owner_id="owner",
            pod_id="pod",
            incarnation="epoch",
            task_id="task",
            environment="development",
            expires_at=2000,
            **changes,
        )
    )


def readiness(**changes):
    return BrowserReadiness(
        **{
            "cloud": "gcp",
            "component_digest": "sha256:" + "a" * 64,
            "isolated": True,
            "direct_egress_denied": True,
            "broker_bridge_verified": True,
            "ephemeral_bridge_verified": True,
            "private_access_denied": True,
            "model_transport_verified": True,
            "model_name": "gemini-3.7-flash",
            "model_transport": "google.adk.models.google_llm.Gemini",
            **changes,
        }
    )


@dataclass
class Authority:
    revoked: bool = False
    approved: bool = False
    journal: list = field(default_factory=list)

    async def check_binding(self, value):
        if self.revoked or value.owner_id != "owner" or value.incarnation != "epoch":
            raise BrowserRefused("BROWSER_BINDING_REFUSED")

    async def check_no_pending_dispatch(self, value):
        await self.check_binding(value)

    async def authorize_action(self, value, action):
        await self.check_binding(value)
        if action.operation == "type" and not self.approved:
            raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")

    async def journal_dispatch(self, value, action):
        self.journal.append((action.sequence, "dispatch"))

    async def settle_dispatch(self, value, action, *, uncertain):
        self.journal.append((action.sequence, "uncertain" if uncertain else "settled"))

    async def authorize_request(self, value, request, commitment):
        await self.check_binding(value)
        if not self.approved:
            raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")
        return BrowserNetworkPermit(effect_receipt_required=False)


@dataclass
class Executor:
    calls: list = field(default_factory=list)
    fail: bool = False
    entered: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event | None = None

    async def initialize(self):
        self.calls.append("initialize")

    async def execute(self, action):
        self.calls.append(action.operation)
        self.entered.set()
        if self.release:
            await self.release.wait()
        if self.fail:
            raise BrowserRefused("BROWSER_TRANSPORT_UNAVAILABLE")
        return BrowserFrame(
            sequence=action.sequence,
            width=1280,
            height=720,
            png=b"\x89PNG\r\n\x1a\nfixture",
            url="https://example.com/",
        )

    async def close(self):
        self.calls.append("close")


def control(*, ready=None, auth=None, driver=None, bound=None, clock=lambda: 1000):
    return BrowserControl(
        binding=bound or binding(),
        readiness=ready or readiness(),
        executor=driver or Executor(),
        authority=auth or Authority(),
        wall_clock=clock,
        clock=clock,
    )
