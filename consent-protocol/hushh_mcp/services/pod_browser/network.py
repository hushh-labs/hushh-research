"""Task-scoped HTTPS broker. The sandbox itself must have NO direct egress.

Every redirect and subresource is a new authorized request. Playwright routing
alone is not containment; this broker uses the existing numeric-IP-pinned socket
backend and requires independent cloud-level isolation acceptance.
"""

from __future__ import annotations

import asyncio
from typing import Protocol
from urllib.parse import urlsplit

import httpcore

from hushh_mcp.services.mcp_public_http import PublicNetworkBackend, validate_mcp_endpoint

from .contracts import (
    BrowserBinding,
    BrowserNetworkPermit,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
)


class BrowserNetworkAuthorityPort(Protocol):
    async def check_binding(self, binding: BrowserBinding) -> None: ...

    async def check_no_pending_dispatch(self, binding: BrowserBinding) -> None:
        """Read this task's network dispatch receipts in the existing ledger."""
        ...

    async def authorize_request(
        self, binding: BrowserBinding, request: BrowserRequest, commitment: str
    ) -> BrowserNetworkPermit: ...

    async def journal_dispatch(
        self, binding: BrowserBinding, request: BrowserRequest, commitment: str
    ) -> None:
        """Atomically refuse unresolved prior effects and record exact intent."""
        ...

    async def settle_dispatch(
        self, binding: BrowserBinding, request: BrowserRequest, commitment: str, *, uncertain: bool
    ) -> None: ...


def public_origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if len(url) > 4096 or any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url:
            raise ValueError()
        if parsed.fragment or not parsed.hostname:
            raise ValueError()
        # Reuse the authored HTTPS host validation while allowing browser paths
        # and queries. DNS is revalidated at the actual TCP connect, not here.
        origin = f"https://{parsed.netloc}"
        if parsed.scheme != "https":
            raise ValueError()
        validate_mcp_endpoint(origin)
        return f"https://{parsed.hostname.lower()}"
    except ValueError:
        raise BrowserRefused("BROWSER_DESTINATION_REFUSED") from None


class BrowserNetworkBroker:
    def __init__(
        self,
        *,
        binding: BrowserBinding,
        allowed_origins: frozenset[str],
        authority: BrowserNetworkAuthorityPort,
    ) -> None:
        if not allowed_origins or len(allowed_origins) > 20:
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        if any(public_origin(origin) != origin for origin in allowed_origins):
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        self._binding = binding
        self._origins = allowed_origins
        self._authority = authority
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpcore.default_ssl_context(),
            network_backend=PublicNetworkBackend(),
            max_connections=4,
            max_keepalive_connections=0,
            retries=0,
        )
        self._closed = False
        self._uncertain = False
        self._pending_effects = 0
        self._inflight: set[asyncio.Task] = set()

    async def check_observation(self) -> None:
        """Trusted host check; a worker screenshot is not a dispatch receipt."""
        if self._closed:
            raise BrowserRefused("BROWSER_STOPPED")
        if self._uncertain or self._pending_effects:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        await self._authority.check_binding(self._binding)
        await self._authority.check_no_pending_dispatch(self._binding)
        if self._closed or self._uncertain or self._pending_effects:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")

    def _validate(self, request: BrowserRequest) -> None:
        if self._closed:
            raise BrowserRefused("BROWSER_STOPPED")
        if self._uncertain:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        if public_origin(request.url) not in self._origins:
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        if request.method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            raise BrowserRefused("BROWSER_METHOD_REFUSED")
        if len(request.body) > 65536 or len(request.headers) > 64:
            raise BrowserRefused("BROWSER_REQUEST_TOO_LARGE")
        size = 0
        seen = set()
        for name, value in request.headers:
            if (
                not name
                or any(
                    c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
                    for c in name
                )
                or any(ord(c) < 32 or ord(c) == 127 for c in value)
                or name.lower()
                in {
                    "host",
                    "connection",
                    "upgrade",
                    "proxy-authorization",
                    "proxy-connection",
                    "transfer-encoding",
                    "content-length",
                    "accept-encoding",
                }
                or name.lower() in seen
            ):
                raise BrowserRefused("BROWSER_HEADERS_REFUSED")
            seen.add(name.lower())
            size += len(name) + len(value)
        if size > 16384:
            raise BrowserRefused("BROWSER_REQUEST_TOO_LARGE")

    @staticmethod
    async def _read_response(response: httpcore.Response) -> BrowserResponse:
        # Avoid decompression bombs. Large downloads need the separate Files
        # streaming boundary, never this bounded frame bridge.
        headers = tuple(
            (name.decode("ascii"), value.decode("latin1")) for name, value in response.headers
        )
        if any(
            name.lower() == "content-encoding" and value.lower() != "identity"
            for name, value in headers
        ):
            raise BrowserRefused("BROWSER_RESPONSE_ENCODING_REFUSED")
        parts: list[bytes] = []
        size = 0
        async for chunk in response.aiter_stream():
            size += len(chunk)
            if size > 4 * 1024 * 1024:
                raise BrowserRefused("BROWSER_RESPONSE_TOO_LARGE")
            parts.append(chunk)
        return BrowserResponse(status=response.status, headers=headers, body=b"".join(parts))

    async def fetch(self, request: BrowserRequest) -> BrowserResponse:
        self._validate(request)
        current = asyncio.current_task()
        if current is None:
            raise BrowserRefused("BROWSER_EXECUTION_CONTEXT_REQUIRED")
        self._inflight.add(current)
        dispatched = False
        commitment = request.commitment()
        try:
            async with asyncio.timeout(15):
                await self._authority.check_binding(self._binding)
                await self._authority.check_no_pending_dispatch(self._binding)
                permit = await self._authority.authorize_request(self._binding, request, commitment)
                if not isinstance(permit, BrowserNetworkPermit):
                    raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")
                self._validate(request)
                await self._authority.check_binding(self._binding)
                await self._authority.check_no_pending_dispatch(self._binding)
                if permit.effect_receipt_required:
                    await self._authority.journal_dispatch(self._binding, request, commitment)
                    dispatched = True
                    self._pending_effects += 1
                await self._authority.check_binding(self._binding)
                response = await self._pool.handle_async_request(
                    httpcore.Request(
                        method=request.method,
                        url=request.url,
                        headers=[*request.headers, ("Accept-Encoding", "identity")],
                        content=request.body,
                        extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
                    )
                )
                try:
                    result = await self._read_response(response)
                    # Revocation/expiry is checked again before returning private
                    # contents to a browser that might have been cancelled.
                    await self._authority.check_binding(self._binding)
                    if dispatched:
                        await self._authority.settle_dispatch(
                            self._binding,
                            request,
                            commitment,
                            uncertain=False,
                        )
                    return result
                finally:
                    await response.aclose()
        except BaseException as exc:
            if dispatched:
                self._uncertain = True
                try:
                    async with asyncio.timeout(5):
                        await self._authority.settle_dispatch(
                            self._binding,
                            request,
                            commitment,
                            uncertain=True,
                        )
                except Exception:
                    # Retain the pending ledger intent and local fence when
                    # acknowledgement storage is unavailable.
                    pass
                if not isinstance(exc, asyncio.CancelledError):
                    raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None
            if isinstance(exc, (BrowserRefused, asyncio.CancelledError)):
                raise
            raise BrowserRefused("BROWSER_NETWORK_UNAVAILABLE") from None
        finally:
            if dispatched:
                self._pending_effects -= 1
            self._inflight.discard(current)

    async def close(self) -> None:
        self._closed = True
        current = asyncio.current_task()
        pending = [task for task in self._inflight if task is not current]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self._pool.aclose()
