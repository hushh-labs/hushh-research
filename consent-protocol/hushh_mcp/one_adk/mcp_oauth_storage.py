"""Request-only MCP SDK OAuth storage; durable custody belongs to the browser vault.

This implements the SDK port, not OAuth itself. The connection workflow must bind
``is_current`` to its authenticated owner/attempt, deliver ``take_result`` only
to that browser, and close the SDK provider/client on every terminal path.
No model, session history, database or diagnostic payload receives this result.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)


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
