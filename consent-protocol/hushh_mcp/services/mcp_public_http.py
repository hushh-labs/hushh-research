"""Public HTTPS-only MCP transport, with DNS enforcement at socket creation.

The original hostname stays in HTTP/TLS; only TCP uses the vetted numeric IP.
No redirects, environment proxies, Unix sockets, or automatic connection retries.
This boundary does not classify tools or confer permission to invoke them.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import AsyncIterator, Iterable

import httpcore
import httpx

from hushh_mcp.services.public_endpoint_policy import (
    UnsafeMcpEndpoint as UnsafeMcpEndpoint,
)
from hushh_mcp.services.public_endpoint_policy import (
    _public_address,
)
from hushh_mcp.services.public_endpoint_policy import (
    validate_mcp_endpoint as validate_mcp_endpoint,
)


class PublicNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(self) -> None:
        self._backend = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if port != 443 or local_address is not None:
            raise UnsafeMcpEndpoint()
        # Cover DNS and TCP with one connect deadline, not two full timeouts.
        async with asyncio.timeout(timeout):
            answers = await asyncio.get_running_loop().getaddrinfo(
                host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
            )
            addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
            if not addresses or not all(_public_address(ip) for ip in addresses):
                raise UnsafeMcpEndpoint()
            # Pass a numeric address, never resolve the untrusted host a second time.
            return await self._backend.connect_tcp(
                addresses[0], port, timeout=timeout, socket_options=socket_options
            )

    async def connect_unix_socket(self, *args, **kwargs) -> httpcore.AsyncNetworkStream:
        raise UnsafeMcpEndpoint()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class McpResponseLimitError(ValueError):
    def __init__(self) -> None:
        super().__init__("Connector response exceeded its transport limits.")


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream, max_bytes: int | None = None) -> None:
        self._stream = stream
        self._max_bytes = max_bytes

    async def __aiter__(self) -> AsyncIterator[bytes]:
        size = 0
        async for chunk in self._stream:
            size += len(chunk)
            if self._max_bytes is not None and size > self._max_bytes:
                await self.aclose()
                raise McpResponseLimitError()
            yield chunk

    async def aclose(self) -> None:
        await self._stream.aclose()


class PublicMcpTransport(httpx.AsyncBaseTransport):
    def __init__(self, *, max_response_bytes: int | None = None) -> None:
        if max_response_bytes is not None and (
            type(max_response_bytes) is not int or max_response_bytes <= 0
        ):
            raise ValueError("Invalid connector response limit.")
        self._max_response_bytes = max_response_bytes
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpcore.default_ssl_context(),
            network_backend=PublicNetworkBackend(),
            max_connections=4,
            max_keepalive_connections=2,
            retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        validate_mcp_endpoint(str(request.url))
        headers = request.headers.raw
        if self._max_response_bytes is not None:
            # OAuth metadata/token responses must not expand after this bound.
            headers = [(key, value) for key, value in headers if key.lower() != b"accept-encoding"]
            headers.append((b"accept-encoding", b"identity"))
        # Do not admit caller-controlled TLS names or routing extensions.
        response = await self._pool.handle_async_request(
            httpcore.Request(
                method=request.method,
                url=httpcore.URL(
                    scheme=request.url.raw_scheme,
                    host=request.url.raw_host,
                    port=request.url.port,
                    target=request.url.raw_path,
                ),
                headers=headers,
                content=request.stream,
                extensions={"timeout": request.extensions.get("timeout", {})},
            )
        )
        if (
            self._max_response_bytes is not None
            and httpx.Headers(response.headers).get("content-encoding", "identity").strip().lower()
            != "identity"
        ):
            await response.aclose()
            raise McpResponseLimitError()
        return httpx.Response(
            status_code=response.status,
            headers=response.headers,
            stream=_ResponseStream(response.stream, self._max_response_bytes),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()


def create_public_mcp_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
    *,
    max_response_bytes: int | None = None,
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout or httpx.Timeout(20),
        auth=auth,
        transport=PublicMcpTransport(max_response_bytes=max_response_bytes),
        follow_redirects=False,
        trust_env=False,
    )


MAX_MCP_WIRE_RESPONSE_BYTES = 4 * 1024 * 1024


def create_bounded_mcp_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """Use the same public-only transport, but bound bytes before MCP SDK parsing."""
    return create_public_mcp_http_client(
        headers=headers,
        timeout=timeout,
        auth=auth,
        max_response_bytes=MAX_MCP_WIRE_RESPONSE_BYTES,
    )
