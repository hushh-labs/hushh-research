"""Chromium interception framing and bounded redirect joins; no network authority."""

from __future__ import annotations

import asyncio
import base64
from typing import TYPE_CHECKING

from .contracts import BrowserExecutionScope, BrowserRefused, BrowserRequest, BrowserResponse

if TYPE_CHECKING:
    from playwright.async_api import Page


def request_from_event(event: dict, scope: BrowserExecutionScope | None) -> BrowserRequest:
    if event.get("redirectedRequestId") and scope is None:
        raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")
    request, body = event["request"], b""
    if request.get("hasPostData"):
        entries = request.get("postDataEntries")
        if entries and all("bytes" in entry for entry in entries):
            body = b"".join(base64.b64decode(entry["bytes"], validate=True) for entry in entries)
        elif "postData" in request:
            body = request["postData"].encode()
        else:
            raise BrowserRefused("BROWSER_REQUEST_BODY_UNAVAILABLE")
    return BrowserRequest(
        scope=scope,
        url=request["url"],
        method=request["method"],
        body=body,
        headers=tuple(
            (name, str(value))
            for name, value in request["headers"].items()
            if name.lower() not in {"host", "connection", "content-length", "accept-encoding"}
        ),
    )


def fulfill_headers(headers: tuple[tuple[str, str], ...]) -> dict[str, str]:
    """Preserve separate cookies; refuse CR/LF and ambiguous singleton headers."""
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


class BrowserRedirects:
    def __init__(self) -> None:
        self._entries: dict[
            str, tuple[BrowserExecutionScope | None, asyncio.Future[None], str | None]
        ] = {}
        self._document_target: str | None = None
        self._failed = False

    def capture(self, event: dict, current: BrowserExecutionScope | None):
        predecessor = event.get("redirectedRequestId")
        pending = self._entries.pop(predecessor, None) if predecessor else None
        # Explicit Chromium linkage only. A late request cannot borrow the next input.
        return (pending[0], pending[1]) if pending else (None if predecessor else current, None)

    def prepare(
        self,
        event: dict,
        response: BrowserResponse,
        scope: BrowserExecutionScope | None,
        main_frame_id: str | None,
    ) -> None:
        identifier = event["requestId"]
        if response.status in {301, 302, 303, 307, 308} and any(
            name.lower() == "location" for name, _ in response.headers
        ):
            if len(self._entries) >= 64 or identifier in self._entries:
                raise BrowserRefused("BROWSER_REDIRECT_LIMIT")
            # Register before fulfillment, not after the next event arrives.
            self._entries[identifier] = (
                scope,
                asyncio.get_running_loop().create_future(),
                event.get("networkId"),
            )
        elif event.get("resourceType") == "Document" and event.get("frameId") == main_frame_id:
            self._document_target = event["request"]["url"]

    def discard(self, identifier: str) -> None:
        pending = self._entries.pop(identifier, None)
        if pending and not pending[1].done():
            pending[1].set_result(None)

    def finished(self, event: dict, *, failed: bool = False) -> None:
        for identifier, (_, _, network_id) in tuple(self._entries.items()):
            if network_id is not None and network_id == event.get("requestId"):
                self._failed |= failed
                self.discard(identifier)

    async def settle(self, requests: set[asyncio.Task]) -> None:
        while requests or self._entries:
            await asyncio.gather(*tuple(requests), *(entry[1] for entry in self._entries.values()))
        if self._failed:
            raise BrowserRefused("BROWSER_ACTION_FAILED")

    def begin_action(self) -> None:
        self._document_target, self._failed = None, False

    async def wait_for_document(self, page: Page, timeout_ms: float) -> None:
        target = self._document_target
        if target is not None:
            await page.wait_for_url(
                lambda url: str(url) == target, wait_until="domcontentloaded", timeout=timeout_ms
            )

    def close(self) -> None:
        for _, successor, _ in self._entries.values():
            successor.cancel()
        self._entries.clear()
        self.begin_action()
