"""No provider credentials or live network required for the egress boundary."""

import asyncio
import socket
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpcore
import httpx
import pytest

from hushh_mcp.services.mcp_public_http import (
    MAX_MCP_WIRE_RESPONSE_BYTES,
    McpResponseLimitError,
    PublicMcpTransport,
    PublicNetworkBackend,
    UnsafeMcpEndpoint,
    create_bounded_mcp_http_client,
    create_public_mcp_http_client,
    validate_mcp_endpoint,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunks,encoding,accepted",
    [
        ([b"1234", b"5678"], None, True),
        ([b"1234", b"56789"], None, False),
        ([b"tiny"], "gzip", False),
    ],
)
async def test_oauth_response_limit_precedes_sdk_buffering(chunks, encoding, accepted):
    transport = PublicMcpTransport(max_response_bytes=8)
    await transport.aclose()
    transport._pool = AsyncMock()

    class Body(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            for chunk in chunks:
                yield chunk

        async def aclose(self):
            self.closed = True

    body = Body()
    transport._pool.handle_async_request.return_value = httpcore.Response(
        200,
        headers=[] if encoding is None else [(b"content-encoding", encoding.encode())],
        content=body,
    )
    async with httpx.AsyncClient(transport=transport) as client:
        if accepted:
            response = await client.get("https://mcp.example.com/metadata")
            assert response.content == b"12345678"
        else:
            with pytest.raises(McpResponseLimitError):
                await client.get("https://mcp.example.com/metadata")
    assert body.closed
    sent = transport._pool.handle_async_request.await_args.args[0]
    assert dict(sent.headers)[b"accept-encoding"] == b"identity"


@pytest.mark.asyncio
async def test_mcp_factory_bounds_provider_bytes_before_sdk_parsing():
    async with create_bounded_mcp_http_client() as client:
        assert client._transport._max_response_bytes == MAX_MCP_WIRE_RESPONSE_BYTES
        assert client.follow_redirects is False


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/mcp",
        "https://localhost/mcp",
        "https://127.0.0.1/mcp",
        "https://169.254.169.254/",
        "https://[::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[2002:7f00:1::]/",
        "https://[ff02::1]/",
        "https://user:secret@example.com/",
        "https://example.com/?token=secret",
        "https://example.com/#fragment",
        "https://example.com:8443/",
        "https://example.com\\@localhost/",
        "https://example.com/\n",
        "https://metadata.internal/",
        "https://host.local/",
    ],
)
def test_rejects_unsafe_or_credential_bearing_endpoints(url):
    with pytest.raises(UnsafeMcpEndpoint) as error:
        validate_mcp_endpoint(url)
    assert url not in str(error.value)


def test_public_https_endpoint():
    validate_mcp_endpoint("https://mcp.example.com/api/mcp")


def dns_answers(*ips):
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443)) for ip in ips]


@pytest.mark.asyncio
@pytest.mark.parametrize("ips", [[], ["10.0.0.1"], ["8.8.8.8", "127.0.0.1"], ["100.64.0.1"]])
async def test_dns_rejects_whole_mixed_or_private_answer_without_socket(monkeypatch, ips):
    backend = PublicNetworkBackend()
    backend._backend = AsyncMock()
    monkeypatch.setattr(
        asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=dns_answers(*ips))
    )
    with pytest.raises(UnsafeMcpEndpoint):
        await backend.connect_tcp("mcp.example.com", 443, timeout=1)
    backend._backend.connect_tcp.assert_not_called()


@pytest.mark.asyncio
async def test_connect_pins_numeric_ip_and_rechecks_next_connection(monkeypatch):
    backend = PublicNetworkBackend()
    backend._backend = AsyncMock()
    resolver = AsyncMock(side_effect=[dns_answers("8.8.8.8"), dns_answers("127.0.0.1")])
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver)
    await backend.connect_tcp("mcp.example.com", 443, timeout=1)
    backend._backend.connect_tcp.assert_awaited_once_with(
        "8.8.8.8", 443, timeout=1, socket_options=None
    )
    with pytest.raises(UnsafeMcpEndpoint):
        await backend.connect_tcp("mcp.example.com", 443, timeout=1)
    assert backend._backend.connect_tcp.await_count == 1


@pytest.mark.asyncio
async def test_tls_uses_original_hostname_and_redirect_is_not_followed(monkeypatch):
    tls_names = []
    tcp_hosts = []

    class Stream(httpcore.AsyncMockStream):
        async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            tls_names.append(server_hostname)
            return self

    async def connect(self, host, port, **kwargs):
        tcp_hosts.append(host)
        return Stream(
            [b"HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/\r\nContent-Length: 0\r\n\r\n"]
        )

    monkeypatch.setattr(
        asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=dns_answers("8.8.8.8"))
    )
    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:8888")
    async with create_public_mcp_http_client() as client:
        response = await client.get("https://mcp.example.com/mcp")
    assert response.status_code == 302
    assert tcp_hosts == ["8.8.8.8"]
    assert tls_names == ["mcp.example.com"]


@pytest.mark.asyncio
async def test_transport_preserves_url_and_drops_tls_override():
    transport = PublicMcpTransport()
    await transport.aclose()
    transport._pool = AsyncMock()

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"ok"

    transport._pool.handle_async_request.return_value = httpcore.Response(200, content=Body())
    request = httpx.Request(
        "GET", "https://mcp.example.com/mcp", extensions={"sni_hostname": "localhost"}
    )
    response = await transport.handle_async_request(request)
    sent = transport._pool.handle_async_request.await_args.args[0]
    assert sent.url.host == b"mcp.example.com"
    assert "sni_hostname" not in sent.extensions
    await response.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["list", "call"])
async def test_discovery_and_invocation_share_guarded_factory(monkeypatch, operation):
    from hushh_mcp.services import external_mcp_client

    factories = []
    session = AsyncMock()
    session.list_tools.return_value = SimpleNamespace(tools=[], nextCursor=None)
    session.call_tool.return_value = SimpleNamespace(isError=False, structuredContent={"ok": True})

    @asynccontextmanager
    async def transport(endpoint, **kwargs):
        factories.append(kwargs["httpx_client_factory"])
        yield None, None, None

    @asynccontextmanager
    async def client_session(*args):
        yield session

    monkeypatch.setattr("mcp.client.streamable_http.streamablehttp_client", transport)
    monkeypatch.setattr("mcp.client.session.ClientSession", client_session)
    if operation == "list":
        await external_mcp_client.list_tools(endpoint="https://mcp.example.com/mcp")
    else:
        await external_mcp_client.call_tool("read", {}, endpoint="https://mcp.example.com/mcp")
    assert factories == [create_bounded_mcp_http_client]


@pytest.mark.asyncio
async def test_dns_timeout_and_unix_socket_fail_closed(monkeypatch, tmp_path):
    backend = PublicNetworkBackend()
    backend._backend = AsyncMock()

    async def slow_dns(*args, **kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", slow_dns)
    with pytest.raises(TimeoutError):
        await backend.connect_tcp("mcp.example.com", 443, timeout=0.001)
    with pytest.raises(UnsafeMcpEndpoint):
        await backend.connect_unix_socket(str(tmp_path / "mcp.sock"))
    backend._backend.connect_tcp.assert_not_called()
