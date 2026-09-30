"""Discovery-only probe of an MCP server a person asked One to add.

It speaks MCP `initialize` then `tools/list` over streamable HTTP and works out
what connecting needs: nothing, an access key, or OAuth sign-in. It classifies
OAuth with the same rules the existing sign-in flow enforces (RFC 9728
protected-resource metadata, an issuer that matches its own metadata, S256
PKCE), so "sign in" is offered only when sign-in can actually succeed.

Boundaries:
- Egress goes only through the public MCP transport: https on port 443, DNS
  checked at socket creation, no redirects, no environment proxies, bounded
  bytes. Every URL, including server-advertised metadata URLs, is re-checked.
- No credential is ever sent and no tool is ever called.
- Every server string is untrusted display text. The server's free-form
  `instructions` are dropped entirely; names and descriptions are stripped of
  control and direction-changing characters and capped.
- Legacy HTTP+SSE is detected, not spoken: its session endpoint carries a
  query string, which the public transport refuses by design. When a `/sse`
  address fails, the same origin's `/mcp` is probed and offered only if it
  verifiably answers as MCP.

Raw JSON-RPC is used here instead of the SDK session because the probe must
see the HTTP status and `WWW-Authenticate` header the SDK hides. Connecting is
still verified by the governed SDK toolset, never by this probe.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import ssl
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from hushh_mcp.services.mcp_public_http import (
    McpResponseLimitError,
    UnsafeMcpEndpoint,
    create_public_mcp_http_client,
    validate_mcp_endpoint,
)

ProbeStatus = Literal["ready", "auth_required", "failed"]
AuthKind = Literal["none", "api_key", "oauth"]
SignIn = Literal["ready", "client_id_needed", "unsupported"]
FailureReason = Literal[
    "blocked_address",
    "unreachable",
    "tls_error",
    "timeout",
    "redirect",
    "not_mcp",
    "legacy_sse",
    "too_large",
]
ClientFactory = Callable[[int], httpx.AsyncClient]

PROTOCOL_VERSION = "2025-06-18"
_DEADLINE_SECONDS = 20.0
_REQUEST_TIMEOUT = httpx.Timeout(8.0)
_MAX_MCP_BYTES = 1_000_000
_MAX_METADATA_BYTES = 64_000
_MAX_TOOL_PAGES = 5
_MAX_TOOLS_SHOWN = 100
_NAME_LIMIT = 80
_TOOL_NAME_LIMIT = 64
_DESCRIPTION_LIMIT = 240
_KNOWN_CAPABILITIES = ("tools", "resources", "prompts", "logging", "completions")
# C0/C1 controls, zero-width and bidirectional overrides can hide or reorder
# text in a card; none of them carry meaning a person needs to read.
_UNSAFE_TEXT = re.compile(
    "[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
)
_RESOURCE_METADATA = re.compile(r'resource_metadata\s*=\s*"([^"]{1,2048})"', re.I)

FAILURE_TEXT: dict[str, tuple[str, str]] = {
    "blocked_address": (
        "That address isn't a public HTTPS server, so One won't contact it.",
        "Use the server's public https:// address with no username, password or query in it.",
    ),
    "unreachable": (
        "One couldn't reach that server.",
        "Check the address is right and that the server is online, then ask again.",
    ),
    "tls_error": (
        "The server's security certificate couldn't be verified.",
        "Ask the server's owner to fix its HTTPS certificate, or use a different address.",
    ),
    "timeout": (
        "The server took too long to answer.",
        "Try again in a minute. If it keeps happening, the server may be down.",
    ),
    "redirect": (
        "That address points somewhere else, and One doesn't follow redirects.",
        "Use the final MCP address from the server's documentation.",
    ),
    "not_mcp": (
        "Something answered at that address, but it isn't an MCP server.",
        "Check the server's documentation for its MCP address. It often ends in /mcp.",
    ),
    "legacy_sse": (
        "This server only offers the older SSE connection, which One doesn't use.",
        "Ask the provider for its current MCP address. It usually ends in /mcp.",
    ),
    "too_large": (
        "The server sent back more than One will read during a check.",
        "Contact the server's owner, or try a smaller server.",
    ),
}


class _ProbeFailure(Exception):
    def __init__(self, reason: FailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


class _AuthRequired(Exception):
    def __init__(self, www_authenticate: str) -> None:
        super().__init__("auth required")
        self.www_authenticate = www_authenticate


@dataclass(frozen=True)
class ProbedTool:
    name: str
    description: str
    access: Literal["read", "write"]

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "description": self.description, "access": self.access}


@dataclass(frozen=True)
class AuthNeed:
    kind: AuthKind
    sign_in: SignIn | None = None
    issuer_host: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"kind": self.kind}
        if self.kind == "oauth":
            value["signIn"] = self.sign_in
            if self.issuer_host:
                value["issuerHost"] = self.issuer_host
        return value


@dataclass(frozen=True)
class ProbeResult:
    status: ProbeStatus
    endpoint: str
    requested_endpoint: str
    server_name: str | None = None
    server_version: str | None = None
    capabilities: tuple[str, ...] = ()
    tools: tuple[ProbedTool, ...] = ()
    tool_count: int = 0
    auth: AuthNeed = field(default_factory=lambda: AuthNeed("none"))
    failure: FailureReason | None = None

    def to_dict(self) -> dict[str, Any]:
        host = urlsplit(self.endpoint).hostname or ""
        value: dict[str, Any] = {
            "status": self.status,
            "endpoint": self.endpoint,
            "host": host,
            "transport": "streamable_http",
            "server": (
                {
                    "name": self.server_name,
                    **({"version": self.server_version} if self.server_version else {}),
                }
                if self.server_name
                else None
            ),
            "capabilities": list(self.capabilities),
            "tools": [tool.to_dict() for tool in self.tools],
            "toolCount": self.tool_count,
            "toolsTruncated": self.tool_count > len(self.tools),
            "auth": self.auth.to_dict(),
        }
        if self.endpoint != self.requested_endpoint:
            value["requestedEndpoint"] = self.requested_endpoint
        if self.failure is not None:
            message, next_step = FAILURE_TEXT[self.failure]
            value["failure"] = {"reason": self.failure, "message": message, "nextStep": next_step}
        return value


def display_text(value: Any, limit: int) -> str:
    """Untrusted server text as one bounded plain-text line, never markup."""
    if not isinstance(value, str):
        return ""
    text = " ".join(_UNSAFE_TEXT.sub(" ", value).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _default_client(max_bytes: int) -> httpx.AsyncClient:
    client: httpx.AsyncClient = create_public_mcp_http_client(
        timeout=_REQUEST_TIMEOUT, max_response_bytes=max_bytes
    )
    return client


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def _is_event_stream(response: httpx.Response) -> bool:
    content_type = str(response.headers.get("content-type", ""))
    return content_type.split(";")[0].strip().lower() == "text/event-stream"


async def _sse_messages(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, str]]:
    event, data = "message", list[str]()
    async for line in lines:
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        yield event, "\n".join(data)


def _classify_status(response: httpx.Response) -> None:
    if response.status_code in (401, 403):
        raise _AuthRequired(response.headers.get("www-authenticate", ""))
    if 300 <= response.status_code < 400:
        raise _ProbeFailure("redirect")


async def _rpc(
    client: httpx.AsyncClient,
    url: str,
    message: dict[str, Any],
    headers: dict[str, str],
) -> tuple[dict[str, Any] | None, httpx.Headers]:
    """POST one JSON-RPC message; read only until its own response arrives."""
    request_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **headers,
    }
    async with client.stream("POST", url, json=message, headers=request_headers) as response:
        _classify_status(response)
        if "id" not in message:
            return None, response.headers
        if response.status_code != 200:
            raise _ProbeFailure("not_mcp")
        if _is_event_stream(response):
            async for _event, data in _sse_messages(response.aiter_lines()):
                reply = _json_object(data)
                if reply is not None and reply.get("id") == message["id"]:
                    return reply, response.headers
            raise _ProbeFailure("not_mcp")
        body = await response.aread()
        reply = _json_object(body)
        if reply is None or reply.get("id") != message["id"]:
            raise _ProbeFailure("not_mcp")
        return reply, response.headers


def _json_object(raw: str | bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _tool_access(raw: dict[str, Any]) -> Literal["read", "write"]:
    # Same fail-closed rule as governed review: only an explicit, uncontradicted
    # read-only claim counts as a read. Missing or loose hints mean "may change".
    annotations = raw.get("annotations")
    if (
        isinstance(annotations, dict)
        and annotations.get("readOnlyHint") is True
        and annotations.get("destructiveHint") is not True
    ):
        return "read"
    return "write"


async def _speak_mcp(
    client: httpx.AsyncClient, url: str
) -> tuple[dict[str, Any], list[ProbedTool], int]:
    reply, headers = await _rpc(
        client,
        url,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Hussh One", "version": "1"},
            },
        },
        {},
    )
    result = reply.get("result") if reply else None
    if not isinstance(result, dict) or not isinstance(result.get("serverInfo"), dict):
        raise _ProbeFailure("not_mcp")
    negotiated = result.get("protocolVersion")
    session_headers = {
        "MCP-Protocol-Version": negotiated
        if isinstance(negotiated, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", negotiated)
        else PROTOCOL_VERSION
    }
    session_id = headers.get("mcp-session-id")
    if session_id and re.fullmatch(r"[\x21-\x7e]{1,256}", session_id):
        session_headers["Mcp-Session-Id"] = session_id
    await _rpc(
        client, url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session_headers
    )
    raw_capabilities = result.get("capabilities")
    capabilities: dict[str, Any] = raw_capabilities if isinstance(raw_capabilities, dict) else {}
    tools: list[ProbedTool] = []
    count = 0
    if "tools" in capabilities:
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for page in range(_MAX_TOOL_PAGES):
            params = {"cursor": cursor} if cursor else {}
            reply, _ = await _rpc(
                client,
                url,
                {"jsonrpc": "2.0", "id": 2 + page, "method": "tools/list", "params": params},
                session_headers,
            )
            listed = reply.get("result") if reply else None
            if not isinstance(listed, dict) or not isinstance(listed.get("tools"), list):
                raise _ProbeFailure("not_mcp")
            for raw in listed["tools"]:
                name = (
                    display_text(raw.get("name"), _TOOL_NAME_LIMIT) if isinstance(raw, dict) else ""
                )
                if not name:
                    continue
                count += 1
                if len(tools) < _MAX_TOOLS_SHOWN:
                    tools.append(
                        ProbedTool(
                            name=name,
                            description=display_text(raw.get("description"), _DESCRIPTION_LIMIT),
                            access=_tool_access(raw),
                        )
                    )
            cursor = listed.get("nextCursor")
            if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
                break
            seen_cursors.add(cursor)
    if session_id:
        # Best effort only; a server that ignores DELETE keeps a short-lived idle session.
        with contextlib.suppress(Exception):
            await client.request("DELETE", url, headers=session_headers)
    return result, tools, count


async def _answers_legacy_sse(client: httpx.AsyncClient, url: str) -> bool:
    async with client.stream("GET", url, headers={"Accept": "text/event-stream"}) as response:
        _classify_status(response)
        if response.status_code != 200 or not _is_event_stream(response):
            return False
        async for event, _data in _sse_messages(response.aiter_lines()):
            return event == "endpoint"
    return False


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any] | None:
    try:
        validate_mcp_endpoint(url)
        response = await client.get(url, headers={"Accept": "application/json"})
    except (UnsafeMcpEndpoint, httpx.HTTPError, McpResponseLimitError, ssl.SSLError):
        return None
    if response.status_code != 200:
        return None
    return _json_object(response.content)


def _well_known(base: str, suffix: str) -> list[str]:
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    root = _origin(base)
    urls = [f"{root}/.well-known/{suffix}{path}"] if path else []
    urls.append(f"{root}/.well-known/{suffix}")
    return urls


async def _discover_auth(client: httpx.AsyncClient, endpoint: str, challenge: str) -> AuthNeed:
    candidates: list[str] = []
    advertised = _RESOURCE_METADATA.search(challenge or "")
    if advertised:
        candidates.append(urljoin(endpoint, advertised.group(1)))
    candidates.extend(_well_known(endpoint, "oauth-protected-resource"))
    issuer: str | None = None
    for url in dict.fromkeys(candidates):
        document = await _get_json(client, url)
        servers = document.get("authorization_servers") if document else None
        if isinstance(servers, list) and servers and isinstance(servers[0], str):
            issuer = servers[0]
            break
    if issuer is None:
        # No discoverable sign-in: the server wants a key or token in a header.
        return AuthNeed("api_key")
    try:
        validate_mcp_endpoint(issuer)
    except UnsafeMcpEndpoint:
        return AuthNeed("oauth", sign_in="unsupported")
    issuer_host = urlsplit(issuer).hostname
    metadata: dict[str, Any] | None = None
    for url in [
        *_well_known(issuer, "oauth-authorization-server"),
        *_well_known(issuer, "openid-configuration"),
    ]:
        document = await _get_json(client, url)
        # The sign-in flow rejects metadata whose issuer differs from the one
        # the resource advertised; classify with the same rule.
        if document and document.get("issuer") == issuer:
            metadata = document
            break
    if metadata is None or not all(
        isinstance(metadata.get(key), str) for key in ("authorization_endpoint", "token_endpoint")
    ):
        return AuthNeed("oauth", sign_in="unsupported", issuer_host=issuer_host)
    methods = metadata.get("code_challenge_methods_supported")
    if not isinstance(methods, list) or "S256" not in methods:
        return AuthNeed("oauth", sign_in="unsupported", issuer_host=issuer_host)
    if not isinstance(metadata.get("registration_endpoint"), str):
        return AuthNeed("oauth", sign_in="client_id_needed", issuer_host=issuer_host)
    return AuthNeed("oauth", sign_in="ready", issuer_host=issuer_host)


def _failure_reason(error: BaseException) -> FailureReason:
    if isinstance(error, _ProbeFailure):
        return error.reason
    if isinstance(error, UnsafeMcpEndpoint):
        return "blocked_address"
    if isinstance(error, McpResponseLimitError):
        return "too_large"
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        return "timeout"
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLError):
            return "tls_error"
        if isinstance(current, UnsafeMcpEndpoint):
            return "blocked_address"
        current = current.__cause__ or current.__context__
    return "unreachable"


def _sse_sibling(endpoint: str) -> str | None:
    parts = urlsplit(endpoint)
    if not parts.path.rstrip("/").endswith("/sse"):
        return None
    path = parts.path.rstrip("/")[: -len("/sse")] + "/mcp"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


async def _probe_one(
    client: httpx.AsyncClient, client_factory: ClientFactory, endpoint: str, requested: str
) -> ProbeResult:
    try:
        initialize, tools, count = await _speak_mcp(client, endpoint)
    except _AuthRequired as required:
        async with client_factory(_MAX_METADATA_BYTES) as metadata_client:
            auth = await _discover_auth(metadata_client, endpoint, required.www_authenticate)
        return ProbeResult("auth_required", endpoint, requested, auth=auth)
    except _ProbeFailure as failure:
        if failure.reason != "not_mcp":
            raise
        if await _answers_legacy_sse(client, endpoint):
            raise _ProbeFailure("legacy_sse") from None
        raise
    info = initialize["serverInfo"]
    capabilities = initialize.get("capabilities")
    return ProbeResult(
        "ready",
        endpoint,
        requested,
        server_name=display_text(info.get("title") or info.get("name"), _NAME_LIMIT) or None,
        server_version=display_text(info.get("version"), 40) or None,
        capabilities=tuple(
            key
            for key in _KNOWN_CAPABILITIES
            if isinstance(capabilities, dict) and key in capabilities
        ),
        tools=tuple(tools),
        tool_count=count,
    )


async def probe_mcp_server(
    endpoint: str, *, client_factory: ClientFactory = _default_client
) -> ProbeResult:
    """Check an address without connecting it. Never raises for a server fault."""
    requested = endpoint.strip() if isinstance(endpoint, str) else ""
    try:
        validate_mcp_endpoint(requested)
    except UnsafeMcpEndpoint:
        # Echo nothing from a rejected address: it may carry a credential.
        return ProbeResult("failed", "", "", failure="blocked_address")
    try:
        async with asyncio.timeout(_DEADLINE_SECONDS):
            async with client_factory(_MAX_MCP_BYTES) as client:
                try:
                    return await _probe_one(client, client_factory, requested, requested)
                except Exception as error:
                    reason = _failure_reason(error)
                    sibling = _sse_sibling(requested)
                    if sibling is None or reason not in {"not_mcp", "legacy_sse"}:
                        raise
                    try:
                        return await _probe_one(client, client_factory, sibling, requested)
                    except Exception:
                        raise error from None
    except Exception as error:  # noqa: BLE001 - every fault becomes a plain reason
        return ProbeResult("failed", requested, requested, failure=_failure_reason(error))
