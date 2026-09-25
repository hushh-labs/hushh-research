"""Live, bounded SDK connection attempt. No database or provider-specific dispatch.

The HTTP owner supplies verified identity, registered return URI and current
configuration revision. Losing this process means reconnecting, not restoring
credentials from a hosted store. No product tool is invoked while connecting.
"""

from __future__ import annotations

import asyncio
import secrets

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata

from hushh_mcp.one_adk.mcp_oauth_storage import (
    ConnectOnlyMcpOAuthProvider,
    EphemeralMcpOAuthStorage,
    McpOAuthCallback,
    McpOAuthConnectError,
    OAuthVaultResult,
)
from hushh_mcp.services.mcp_public_http import validate_mcp_endpoint


class McpOAuthConnection:
    def __init__(
        self,
        *,
        owner_id: str,
        connector_id: str,
        revision: str,
        endpoint: str,
        redirect_uri: str,
        registered_client: OAuthClientInformationFull | None = None,
        registered_issuer: str | None = None,
    ):
        validate_mcp_endpoint(endpoint)
        if not owner_id or not connector_id or not revision:
            raise McpOAuthConnectError()
        if (registered_client is None) != (registered_issuer is None):
            raise McpOAuthConnectError()
        self._owner = owner_id
        self._connector = connector_id
        self._revision = revision
        self._endpoint = endpoint
        self._registered_client = registered_client
        self._registered_issuer = registered_issuer
        self._active = True
        self._task: asyncio.Task[OAuthVaultResult] | None = None
        self._redirect = asyncio.get_running_loop().create_future()
        self._storage = EphemeralMcpOAuthStorage(is_current=lambda: self._active)
        self._callback = McpOAuthCallback(owner_id=owner_id, is_current=lambda: self._active)
        self._provider = ConnectOnlyMcpOAuthProvider(
            endpoint,
            OAuthClientMetadata(
                redirect_uris=[redirect_uri],
                client_name="Hussh One",
                token_endpoint_auth_method="none",  # noqa: S106 - public OAuth client
            ),
            self._storage,
        )
        self._provider.use_callback(self._callback, self._on_redirect)
        self._expiry = asyncio.get_running_loop().call_later(300, self.close)

    def _check(self, owner_id: str, connector_id: str, revision: str) -> None:
        if not self._active or (owner_id, connector_id, revision) != (
            self._owner,
            self._connector,
            self._revision,
        ):
            raise McpOAuthConnectError()

    async def _on_redirect(self, url: str) -> None:
        if not self._active or self._redirect.done():
            raise McpOAuthConnectError()
        self._redirect.set_result(url)

    async def _run(self) -> OAuthVaultResult:
        try:
            async with asyncio.timeout(300):
                async with self._provider.create_http_client() as client:
                    # Connection handshake only. Closing the HTTP streams ends
                    # local ownership; do not OAuth-retry a DELETE or tool call.
                    async with streamable_http_client(
                        self._endpoint,
                        http_client=client,
                        terminate_on_close=False,
                    ) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                if not self._active:
                    raise McpOAuthConnectError()
                return await self._provider.take_result()
        except asyncio.CancelledError:
            raise
        except Exception:
            # SDK task groups can contain private provider exceptions.
            raise McpOAuthConnectError() from None
        finally:
            self._provider.close()

    async def start(self) -> str:
        if not self._active or self._task is not None:
            raise McpOAuthConnectError()
        try:
            if self._registered_client is not None and self._registered_issuer is not None:
                await self._provider.use_registered_client(
                    self._registered_client, issuer=self._registered_issuer
                )
            # SDK storage now holds a bounded copy. Do not retain another.
            self._registered_client = None
            self._registered_issuer = None
            self._task = asyncio.create_task(self._run())
            done, _ = await asyncio.wait(
                (self._redirect, self._task), timeout=25, return_when=asyncio.FIRST_COMPLETED
            )
            if self._task in done:
                # Consume failure to avoid unhandled task diagnostics.
                await self._task
                raise McpOAuthConnectError()
            if self._redirect not in done:
                raise McpOAuthConnectError()
            return self._redirect.result()
        except BaseException:
            self.close()
            raise

    async def complete(
        self,
        *,
        owner_id: str,
        connector_id: str,
        revision: str,
        code: str,
        state: str,
        issuer: str | None,
    ) -> OAuthVaultResult:
        self._check(owner_id, connector_id, revision)
        if self._task is None:
            raise McpOAuthConnectError()
        # Bad callbacks do not consume another owner's valid attempt.
        self._callback.submit(owner_id=owner_id, code=code, state=state, issuer=issuer)
        try:
            async with asyncio.timeout(25):
                result = await asyncio.shield(self._task)
            self._check(owner_id, connector_id, revision)
            return result
        finally:
            self.close()

    def close(self) -> None:
        self._active = False
        self._registered_client = None
        self._registered_issuer = None
        self._expiry.cancel()
        self._provider.close()
        task, self._task = self._task, None
        if task is not None:
            if not task.done():
                task.cancel()
            else:
                if not task.cancelled():
                    task.exception()
        if not self._redirect.done():
            self._redirect.cancel()
        replacement = asyncio.get_running_loop().create_future()
        replacement.cancel()
        self._redirect = replacement


class McpOAuthAttempts:
    """Bounded process-local continuations, never durable credentials.

    A request routed to a different worker fails closed and must reconnect.
    Deployment must provide affinity before this can support multiple workers.
    """

    def __init__(self):
        self._entries: dict[str, tuple[str, str, str, McpOAuthConnection, asyncio.TimerHandle]] = {}

    async def begin(self, **kwargs) -> dict[str, str]:
        owner = kwargs["owner_id"]
        if not owner or len(self._entries) >= 128:
            raise McpOAuthConnectError()
        if sum(entry[0] == owner for entry in self._entries.values()) >= 2:
            raise McpOAuthConnectError()
        attempt = McpOAuthConnection(**kwargs)
        handle = secrets.token_urlsafe(32)
        timer = asyncio.get_running_loop().call_later(300, self._discard, handle)
        self._entries[handle] = (owner, kwargs["connector_id"], kwargs["revision"], attempt, timer)
        try:
            url = await attempt.start()
            return {"attemptId": handle, "authorizeUrl": url}
        except BaseException:
            self._discard(handle)
            raise

    def _get(self, handle: str, owner_id: str, connector_id: str, revision: str):
        entry = self._entries.get(handle)
        if entry is None or entry[:3] != (owner_id, connector_id, revision):
            raise McpOAuthConnectError()
        return entry[3]

    def _discard(self, handle: str) -> None:
        entry = self._entries.pop(handle, None)
        if entry is not None:
            entry[4].cancel()
            entry[3].close()

    async def complete(self, *, handle: str, **kwargs) -> OAuthVaultResult:
        attempt = self._get(handle, kwargs["owner_id"], kwargs["connector_id"], kwargs["revision"])
        # Claim before await: concurrent completion cannot exchange twice.
        entry = self._entries.pop(handle)
        try:
            return await attempt.complete(**kwargs)
        finally:
            entry[4].cancel()
            attempt.close()

    def cancel(self, *, handle: str, owner_id: str, connector_id: str, revision: str) -> None:
        self._get(handle, owner_id, connector_id, revision)
        self._discard(handle)


mcp_oauth_attempts = McpOAuthAttempts()
