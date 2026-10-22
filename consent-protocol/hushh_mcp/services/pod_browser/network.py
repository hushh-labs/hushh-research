"""Task-scoped HTTPS broker for normal owner-authorized Browser operation.

Every redirect and subresource is a new authorized request. Playwright routing
alone is not containment; this broker uses the existing numeric-IP-pinned socket
backend. One and Browser share the owner compromise boundary. These application
checks cannot contain a compromised process in that container.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Protocol

import httpcore

from hushh_mcp.services.mcp_public_http import PublicNetworkBackend

from .contracts import (
    BrowserBinding,
    BrowserExecutionScope,
    BrowserNetworkPermit,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
)
from .downloads import BrowserDownloads
from .origin import public_origin as public_origin


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
        self._pending_reviews = 0
        self._inflight: set[asyncio.Task] = set()
        self._scope_check: Callable[[BrowserExecutionScope], None] | None = None
        self.downloads = BrowserDownloads()

    def bind_scope_validator(self, check: Callable[[BrowserExecutionScope], None]) -> None:
        if self._scope_check is not None:
            raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")
        self._scope_check = check

    async def check_observation(self) -> None:
        """Trusted host check; a worker screenshot is not a dispatch receipt."""
        if self._closed:
            raise BrowserRefused("BROWSER_STOPPED")
        if self._uncertain or self._pending_effects:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        if self._pending_reviews:
            raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")
        await self._authority.check_binding(self._binding)
        await self._authority.check_no_pending_dispatch(self._binding)
        if self._closed or self._uncertain or self._pending_effects:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")

    def _validate(self, request: BrowserRequest) -> None:
        if self._closed:
            raise BrowserRefused("BROWSER_STOPPED")
        if self._uncertain:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
        if request.scope is not None:
            if self._scope_check is None:
                raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")
            self._scope_check(request.scope)
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
        commitment = request.commitment()
        try:
            budget = request.scope.remaining() if request.scope else 15
            async with asyncio.timeout(budget):
                await self._authority.check_binding(self._binding)
                await self._authority.check_no_pending_dispatch(self._binding)
                self._pending_reviews += 1
                try:
                    permit = await self._authority.authorize_request(
                        self._binding, request, commitment
                    )
                finally:
                    self._pending_reviews -= 1
                if not isinstance(permit, BrowserNetworkPermit):
                    raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")
                # Human review uses the original action budget. HTTP itself
                # retains its independent fifteen-second execution deadline.
                async with asyncio.timeout(15):
                    return await self._dispatch(request, commitment, permit)
        except BaseException as exc:
            if isinstance(exc, (BrowserRefused, asyncio.CancelledError)):
                raise
            raise BrowserRefused("BROWSER_NETWORK_UNAVAILABLE") from None
        finally:
            self._inflight.discard(current)

    async def _dispatch(self, request, commitment, permit) -> BrowserResponse:
        dispatched = False
        try:
            self._validate(request)
            await self._authority.check_binding(self._binding)
            await self._authority.check_no_pending_dispatch(self._binding)
            if permit.effect_receipt_required:
                await self._authority.journal_dispatch(self._binding, request, commitment)
                dispatched = True
                self._pending_effects += 1
            await self._authority.check_binding(self._binding)
            # Takeover/Stop can win any awaited review or ledger operation.
            # Check live authority after the last await, immediately before IO.
            self._validate(request)
            response = await self._pool.handle_async_request(
                httpcore.Request(
                    method=request.method,
                    url=request.url,
                    # Raw httpcore requests do not add HTTP/1.1 framing.
                    # Derive it here; worker-supplied routing/framing headers
                    # remain forbidden by _validate.
                    headers=[
                        *request.headers,
                        ("Host", httpcore.URL(request.url).host),
                        ("Content-Length", str(len(request.body))),
                        ("Accept-Encoding", "identity"),
                    ],
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
                return self.downloads.capture(result)
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

    async def close(self) -> None:
        self._closed = True
        self.downloads.clear()
        current = asyncio.current_task()
        pending = [task for task in self._inflight if task is not current]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self._pool.aclose()
