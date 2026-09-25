"""Request-only MCP SDK OAuth storage; durable custody belongs to the browser vault.

This implements the SDK port, not OAuth itself. The connection workflow must bind
``is_current`` to its authenticated owner/attempt, deliver ``take_result`` only
to that browser, and close the SDK provider/client on every terminal path.
No model, session history, database or diagnostic payload receives this result.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit

import httpx
from mcp.client.auth.oauth2 import OAuthClientProvider
from mcp.shared.auth import OAuthClientInformationFull, OAuthMetadata, OAuthToken

from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)
from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client, validate_mcp_endpoint


class _SafeOAuthDiagnostic(logging.Filter):
    """Retain SDK event severity, never provider text or credential tracebacks."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = "MCP OAuth protocol event; private details omitted."
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def _protect_sdk_diagnostics() -> None:
    # Permanent for these SDK loggers: removing filters at one flow's teardown
    # could expose another concurrent flow. API exception sanitization is separate.
    for name in ("mcp.client.auth.oauth2", "mcp.client.auth.utils"):
        logger = logging.getLogger(name)
        if not any(isinstance(item, _SafeOAuthDiagnostic) for item in logger.filters):
            logger.addFilter(_SafeOAuthDiagnostic())


@dataclass(frozen=True)
class OAuthVaultResult:
    tokens: OAuthToken = field(repr=False)
    client_info: OAuthClientInformationFull = field(repr=False)
    expires_at: int | None


class EphemeralMcpOAuthStorage:
    """SDK TokenStorage backed by the existing bounded, expiring secret handoff."""

    def __init__(self, *, is_current: Callable[[], bool], ttl_seconds: int = 300):
        if not 1 <= ttl_seconds <= 600:
            raise ValueError("Invalid connector authorization lifetime.")
        _protect_sdk_diagnostics()
        self._is_current = is_current
        self._deadline = time.monotonic() + ttl_seconds
        self._tokens = ""
        self._client = ""
        self._expires_at: int | None = None
        self._closed = False

    def close(self) -> None:
        consume_request_secret(self._tokens)
        consume_request_secret(self._client)
        self._tokens = self._client = ""
        self._expires_at = None
        self._closed = True

    def _check(self) -> None:
        if self._closed or time.monotonic() >= self._deadline or not self._is_current():
            self.close()
            raise ValueError("Connector authorization expired or changed. Please reconnect.")

    def _store(self, value: str, previous: str) -> str:
        self._check()
        if len(value.encode()) > 32_000:
            self.close()
            raise ValueError("Connector authorization response is too large.")
        reference = store_request_secret(
            value, ttl_seconds=max(1, int(self._deadline - time.monotonic()))
        )
        consume_request_secret(previous)
        return reference

    async def get_tokens(self) -> OAuthToken | None:
        self._check()
        value = resolve_request_secret(self._tokens)
        return OAuthToken.model_validate_json(value) if value else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._tokens = self._store(tokens.model_dump_json(), self._tokens)
        self._expires_at = (
            None if tokens.expires_in is None else int(time.time()) + tokens.expires_in
        )

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        self._check()
        value = resolve_request_secret(self._client)
        return OAuthClientInformationFull.model_validate_json(value) if value else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._client = self._store(client_info.model_dump_json(), self._client)

    async def take_result(self) -> OAuthVaultResult:
        """Single delivery; the caller still owns authenticated transport and vault save."""
        try:
            tokens = await self.get_tokens()
            client_info = await self.get_client_info()
            if tokens is None or client_info is None:
                raise ValueError("Connector authorization is incomplete. Please reconnect.")
            return OAuthVaultResult(tokens, client_info, self._expires_at)
        finally:
            self.close()


class McpOAuthConnectError(ValueError):
    def __init__(self):
        super().__init__("Connector authorization could not finish. Please reconnect.")


class McpOAuthCallback:
    """One live SDK callback, never a durable attempt or authentication authority.

    Routes must supply a verified owner and a registered redirect URI. Browser
    session validity remains the caller's guard, checked again before delivery.
    Loss of this in-memory continuation requires a fresh authorization attempt.
    """

    def __init__(self, *, owner_id: str, is_current: Callable[[], bool]):
        if not isinstance(owner_id, str) or not owner_id:
            raise McpOAuthConnectError()
        self._owner_id = owner_id
        self._is_current = is_current
        self._state: str | None = None
        self._issuer: str | None = None
        self._require_issuer = False
        self._future = asyncio.get_running_loop().create_future()

    def bind_redirect(self, url: str, *, issuer: str, require_issuer: bool) -> None:
        if self._state is not None or self._future.done() or not self._is_current():
            raise McpOAuthConnectError()
        values = parse_qs(urlsplit(url).query, keep_blank_values=True)
        states = values.get("state", [])
        if len(states) != 1 or not states[0] or not states[0].isascii() or len(states[0]) > 512:
            raise McpOAuthConnectError()
        validate_mcp_endpoint(issuer)
        self._state = states[0]
        self._issuer = issuer
        self._require_issuer = require_issuer

    def submit(self, *, owner_id: str, code: str, state: str, issuer: str | None) -> None:
        if not self._is_current():
            self.close()
            raise McpOAuthConnectError()
        if (
            owner_id != self._owner_id
            or self._state is None
            or self._future.done()
            or not isinstance(state, str)
            or not state.isascii()
            or not secrets.compare_digest(state, self._state)
            or not isinstance(code, str)
            or not code
            or len(code) > 8192
            or any(ord(char) < 32 or ord(char) == 127 for char in code)
            or (self._require_issuer and issuer is None)
            or (issuer is not None and issuer != self._issuer)
        ):
            raise McpOAuthConnectError()
        self._future.set_result((code, state))

    async def wait(self) -> tuple[str, str]:
        try:
            result = await self._future
            if not self._is_current():
                raise McpOAuthConnectError()
            return result
        finally:
            self.close()

    def close(self) -> None:
        if not self._future.done():
            self._future.cancel()
        # A completed Future retains its result. Replace it after consumption
        # so this holder does not keep an authorization-code copy alive.
        replacement = asyncio.get_running_loop().create_future()
        replacement.cancel()
        self._future = replacement
        self._state = self._issuer = None


class ConnectOnlyMcpOAuthProvider(OAuthClientProvider):
    """SDK OAuth restricted to setup, never an authorization retry around a write.

    The owning connection workflow binds issuer/callback continuity and uses
    the public-only HTTP transport. A pre-registered client is optional; its
    admission does not configure a provider or prove live authentication.
    Fresh authorization only: vault refresh credentials must not enter a provider
    that has not yet established the authorization server/token endpoint.
    """

    def create_http_client(self) -> httpx.AsyncClient:
        """Caller closes the client; no environment proxies or automatic redirects."""
        return create_public_mcp_http_client(auth=self, max_response_bytes=65_536)

    async def use_registered_client(
        self, client_info: OAuthClientInformationFull, *, issuer: str
    ) -> None:
        """Admit an owner-supplied registration, never an operator-owned secret.

        The result is returned to the owner's vault. Issuer binding is supplied
        with the registration, not inferred from an untrusted MCP challenge.
        The SDK still owns PKCE, authorization and token exchange.
        """
        storage = self.context.storage
        method = client_info.token_endpoint_auth_method or "none"
        if (
            self._initialized
            or getattr(self, "_registered_issuer", None) is not None
            or not isinstance(storage, EphemeralMcpOAuthStorage)
            or client_info.redirect_uris != self.context.client_metadata.redirect_uris
            or not isinstance(client_info.client_id, str)
            or not 1 <= len(client_info.client_id) <= 8192
            or method not in {"none", "client_secret_basic", "client_secret_post"}
            or (method == "none" and client_info.client_secret is not None)
            or (
                method != "none"
                and (
                    not isinstance(client_info.client_secret, str)
                    or not 1 <= len(client_info.client_secret) <= 8192
                )
            )
        ):
            raise McpOAuthConnectError()
        validate_mcp_endpoint(issuer)
        await storage.set_client_info(client_info)
        self._registered_issuer = issuer

    def use_callback(
        self, callback: McpOAuthCallback, redirect: Callable[[str], Awaitable[None]]
    ) -> None:
        """Bind the live SDK redirect/state to the owning authenticated workflow."""
        if self._initialized or getattr(self, "_callback", None) is not None:
            raise McpOAuthConnectError()
        self._callback = callback

        async def bound_redirect(url: str) -> None:
            self._check_sdk_metadata()
            callback.bind_redirect(
                url,
                issuer=self._advertised_issuer,
                require_issuer=getattr(self, "_require_callback_issuer", False),
            )
            await redirect(url)

        self.context.redirect_handler = bound_redirect
        self.context.callback_handler = callback.wait

    def close(self) -> None:
        callback = getattr(self, "_callback", None)
        if callback is not None:
            callback.close()
        if isinstance(self.context.storage, EphemeralMcpOAuthStorage):
            self.context.storage.close()
        self.context.clear_tokens()
        self.context.client_info = None
        self.context.oauth_metadata = None
        self.context.protected_resource_metadata = None
        self.context.auth_server_url = None
        self._admitted_metadata = None
        self._admitted_endpoints = {}
        self._advertised_issuer = None
        self._registered_issuer = None

    async def take_result(self) -> OAuthVaultResult:
        """Deliver once, clearing SDK copies as well as the handoff storage."""
        try:
            if not isinstance(self.context.storage, EphemeralMcpOAuthStorage):
                raise McpOAuthConnectError()
            return await self.context.storage.take_result()
        finally:
            self.close()

    def _check_sdk_metadata(self) -> None:
        admitted = getattr(self, "_admitted_metadata", None)
        if admitted is None or self.context.oauth_metadata != admitted:
            raise McpOAuthConnectError()

    def _admit_metadata_response(self, outgoing: httpx.Request, response: httpx.Response) -> None:
        if (
            outgoing.method != "GET"
            or str(outgoing.url) == self.context.server_url
            or response.status_code != 200
        ):
            return
        payload = response.json()
        if not isinstance(payload, dict):
            raise McpOAuthConnectError()
        if "authorization_servers" in payload:
            servers = payload["authorization_servers"]
            if not isinstance(servers, list) or not servers or not isinstance(servers[0], str):
                raise McpOAuthConnectError()
            validate_mcp_endpoint(servers[0])
            registered_issuer = getattr(self, "_registered_issuer", None)
            if registered_issuer is not None and servers[0] != registered_issuer:
                raise McpOAuthConnectError()
            # Preserve the exact advertised issuer, before SDK URL normalization.
            self._advertised_issuer = servers[0]
            self._admitted_endpoints = {}
            self._admitted_metadata = None
        elif "issuer" in payload:
            issuer = getattr(self, "_advertised_issuer", None)
            if issuer is None or payload["issuer"] != issuer:
                raise McpOAuthConnectError()
            if getattr(self, "_registered_issuer", None) is not None:
                # A resource server cannot impersonate the registered issuer
                # merely by putting its name in a metadata JSON response.
                source = urlsplit(str(outgoing.url))
                authority = urlsplit(issuer)
                if (source.scheme, source.netloc) != (authority.scheme, authority.netloc):
                    raise McpOAuthConnectError()
            if "S256" not in (payload.get("code_challenge_methods_supported") or []):
                raise McpOAuthConnectError()
            # Validate the complete SDK contract before admitting any endpoint.
            # Otherwise a malformed optional field can make the SDK fall back
            # while our raw JSON whitelist still appears to authorize it.
            metadata = OAuthMetadata.model_validate(payload)
            endpoints = {}
            for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
                value = payload.get(key)
                if value is None and key == "registration_endpoint":
                    continue
                if not isinstance(value, str):
                    raise McpOAuthConnectError()
                validate_mcp_endpoint(value)
                endpoints[key] = value
            self._admitted_endpoints = endpoints
            self._admitted_metadata = metadata
            requires_issuer = payload.get("authorization_response_iss_parameter_supported", False)
            if not isinstance(requires_issuer, bool):
                raise McpOAuthConnectError()
            self._require_callback_issuer = requires_issuer

    async def _perform_authorization_code_grant(self):
        self._check_sdk_metadata()
        if not getattr(self, "_admitted_endpoints", None):
            raise McpOAuthConnectError()
        return await super()._perform_authorization_code_grant()

    async def async_auth_flow(self, request: httpx.Request):
        storage = self.context.storage
        if not isinstance(storage, EphemeralMcpOAuthStorage):
            raise McpOAuthConnectError()
        flow = None
        try:
            storage._check()
            validate_mcp_endpoint(str(request.url))
            if str(request.url) != self.context.server_url:
                raise McpOAuthConnectError()
            if request.method == "POST":
                body = request.content
                if len(body) > 16_384:
                    raise McpOAuthConnectError()
                message = json.loads(body)
                if not isinstance(message, dict) or message.get("method") not in {
                    "initialize",
                    "notifications/initialized",
                    "ping",
                    "tools/list",
                }:
                    raise McpOAuthConnectError()
            elif request.method != "GET":
                raise McpOAuthConnectError()
            if not self._initialized and await storage.get_tokens() is not None:
                raise McpOAuthConnectError()
            if (
                not self._initialized
                and await storage.get_client_info() is not None
                and getattr(self, "_registered_issuer", None) is None
            ):
                raise McpOAuthConnectError()
            flow = super().async_auth_flow(request)
            async with asyncio.timeout(max(0, storage._deadline - time.monotonic())):
                outgoing = await anext(flow)
                while True:
                    storage._check()
                    validate_mcp_endpoint(str(outgoing.url))
                    if outgoing is not request:
                        if outgoing.method == "POST":
                            self._check_sdk_metadata()
                            endpoints = getattr(self, "_admitted_endpoints", {})
                            if str(outgoing.url) not in {
                                endpoints.get("token_endpoint"),
                                endpoints.get("registration_endpoint"),
                            }:
                                raise McpOAuthConnectError()
                        elif (
                            outgoing.method != "GET"
                            or "authorization" in outgoing.headers
                            or "cookie" in outgoing.headers
                        ):
                            raise McpOAuthConnectError()
                    response = yield outgoing
                    storage._check()
                    self._admit_metadata_response(outgoing, response)
                    try:
                        outgoing = await flow.asend(response)
                    except StopAsyncIteration:
                        return
        except (asyncio.CancelledError, GeneratorExit):
            self.close()
            raise
        except Exception:
            self.close()
            raise McpOAuthConnectError() from None
        finally:
            if flow is not None:
                await flow.aclose()
