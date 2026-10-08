"""Short-lived Google access tokens, minted by the agent from its own sealed login.

``PodGoogleTokenSource.access_token(service, level)`` is the one way a connector in
the agent gets a token:

* the level's scopes must already be granted (``CONNECTOR_SCOPES``), so a Gmail
  read never borrows a broader token and a level never granted fails as
  ``SCOPE_NOT_GRANTED`` before Google is asked;
* each refresh is narrowed to exactly those scopes (RFC 6749 section 6), and the
  answer must carry them all. Narrowing fails open at Google (it may return more),
  which is acceptable here only because the token never leaves this process;
* a cached token is reused until 90 seconds before it expires;
* one refresh at a time per connector (single flight), so ten tools asking at once
  cost Google one call and cannot race a rotation;
* ``invalid_grant`` marks the login ``needs_reauth`` in the log, and every caller
  gets that word until the owner signs in again;
* a rotated refresh token is recorded as the next generation; when that write
  fails (a lost race, a fenced log, no store) the caller gets
  ``CREDENTIALS_UNAVAILABLE``, never a raw store exception;
* access tokens live in memory only, and nothing sensitive is ever logged.

Hussh's native phone clients need no client secret to refresh; an owner's own client
uses the secret they sealed (``google_owner_client``).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable, Optional

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_google_oauth as google
from hushh_mcp.services.pod_connector_credential_seal import CONNECTOR_SCOPES, GOOGLE_OWNER_CLIENT

logger = logging.getLogger(__name__)

SKEW_S = 90
NOT_CONNECTED = "NOT_CONNECTED"
NEEDS_REAUTH = "NEEDS_REAUTH"
SCOPE_NOT_GRANTED = "SCOPE_NOT_GRANTED"
LEVEL_UNSUPPORTED = "LEVEL_UNSUPPORTED"
CREDENTIALS_UNAVAILABLE = "CREDENTIALS_UNAVAILABLE"
PROVIDER_UNREACHABLE = "PROVIDER_UNREACHABLE"


class ConnectorTokenError(RuntimeError):
    """No token for this request. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def required_scopes(service: str, level: str, granted: tuple[str, ...]) -> tuple[str, ...]:
    """The first scope set for (service, level) that the login fully holds."""
    alternatives = (CONNECTOR_SCOPES.get(service) or {}).get(level)
    if not alternatives:
        raise ConnectorTokenError(LEVEL_UNSUPPORTED)
    held = set(granted)
    for group in alternatives:
        if set(group) <= held:
            return group
    raise ConnectorTokenError(SCOPE_NOT_GRANTED)


class PodGoogleTokenSource:
    """Access tokens per (connector, scope set), from the agent's own login."""

    def __init__(
        self,
        *,
        log_resolver: Optional[Callable[[], Any]] = None,
        post: Optional[google.Post] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._log_resolver = log_resolver
        self._post = post
        self._clock = clock
        self._locks: dict[str, asyncio.Lock] = {}
        # (connector, scopes) -> (credential id, generation, access token, expires at)
        self._cache: dict[tuple[str, tuple[str, ...]], tuple[str, int, str, float]] = {}

    def _log(self) -> Any:
        if self._log_resolver is not None:
            return self._log_resolver()
        from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

        return _resolve_log()

    def forget(self, connector_id: str) -> None:
        """Drop every cached token for a connector (disconnect, reconnect)."""
        for key in [key for key in self._cache if key[0] == connector_id]:
            del self._cache[key]

    def _held(self, service: str) -> store.ConnectorCredential:
        try:
            credential = store.active_connector_credential(service)
        except store.ConnectorCredentialsUnavailable:
            raise ConnectorTokenError(CREDENTIALS_UNAVAILABLE) from None
        if credential is None:
            raise ConnectorTokenError(NOT_CONNECTED)
        if credential.status != store.STATUS_CONNECTED or not credential.refresh_token:
            raise ConnectorTokenError(NEEDS_REAUTH)
        return credential

    def _client_secret(self, credential: store.ConnectorCredential) -> Optional[str]:
        if credential.client_profile != "owner_client":
            try:
                google.validate_native_client(credential.client_profile, credential.client_id)
            except google.GoogleOAuthError:
                raise ConnectorTokenError(NEEDS_REAUTH) from None
            return None
        owner = store.active_connector_credential(GOOGLE_OWNER_CLIENT)
        if owner is None or owner.client_id != credential.client_id or not owner.client_secret:
            raise ConnectorTokenError(NEEDS_REAUTH)
        return owner.client_secret

    async def _advance(
        self, credential: store.ConnectorCredential, service: str, **changes: Any
    ) -> bool:
        return await _advance_or_false(self._log, credential, service, **changes)

    async def access_token(self, service: str, level: str = "read") -> str:
        lock = self._locks.setdefault(service, asyncio.Lock())
        async with lock:
            credential = self._held(service)
            scopes = required_scopes(service, level, credential.granted_scopes)
            cached = self._cache.get((service, scopes))
            now = self._clock()
            if (
                cached
                and cached[:2] == (credential.credential_id, credential.generation)
                and cached[3] - SKEW_S > now
            ):
                return cached[2]
            return await self._refresh(credential, service, scopes, now)

    async def validate_current(
        self, credential: store.ConnectorCredential, *, post: Optional[google.Post] = None
    ) -> None:
        """Validate an exact grant after revocation, without cached bearer authority."""
        service = credential.connector_id
        async with self._locks.setdefault(service, asyncio.Lock()):
            current = store.active_connector_credential(service)
            if (
                current is None
                or current.status != store.STATUS_CONNECTED
                or (current.credential_id, current.generation)
                != (credential.credential_id, credential.generation)
            ):
                return
            self.forget(service)
            scopes = required_scopes(service, "read", credential.granted_scopes)
            try:
                await self._refresh(credential, service, scopes, self._clock(), post=post)
            except ConnectorTokenError as exc:
                if exc.code == NEEDS_REAUTH:
                    current = store.active_connector_credential(service)
                    if current is not None and current.status == store.STATUS_CONNECTED:
                        if current.credential_id != credential.credential_id:
                            return  # The refusal was for the old login only.
                        raise ConnectorTokenError(CREDENTIALS_UNAVAILABLE) from None
                raise

    async def _refresh(
        self,
        credential: store.ConnectorCredential,
        service: str,
        scopes: tuple,
        now: float,
        *,
        post: Optional[google.Post] = None,
    ) -> str:
        try:
            grant = await google.refresh(
                client_id=credential.client_id,
                refresh_token=credential.refresh_token,
                scopes=scopes,
                client_secret=self._client_secret(credential),
                post=post if post is not None else self._post,
            )
        except google.GoogleOAuthError as exc:
            if exc.code != google.INVALID_GRANT:
                raise ConnectorTokenError(PROVIDER_UNREACHABLE) from None
            self.forget(service)
            # The login is dead at Google whether or not this write lands.
            await self._advance(credential, service, needs_reauth=True)
            logger.info("pod_connector_tokens.needs_reauth connector=%s", service)
            raise ConnectorTokenError(NEEDS_REAUTH) from None
        if not set(scopes) <= set(grant.scopes):
            raise ConnectorTokenError(SCOPE_NOT_GRANTED)
        generation = credential.generation
        if grant.refresh_token and grant.refresh_token != credential.refresh_token:
            if not await self._advance(credential, service, refresh_token=grant.refresh_token):
                raise ConnectorTokenError(CREDENTIALS_UNAVAILABLE)
            logger.info("pod_connector_tokens.rotated connector=%s", service)
            generation += 1
        current = self._held(service)
        if current.credential_id != credential.credential_id or current.generation != generation:
            # The response belongs to a disconnected/replaced generation. Neither
            # its access token nor its rotation may escape into the new login.
            raise ConnectorTokenError(CREDENTIALS_UNAVAILABLE)
        expires_at = now + max(grant.expires_in_s, 0)
        self._cache[(service, scopes)] = (
            credential.credential_id,
            generation,
            grant.access_token,
            expires_at,
        )
        return grant.access_token


async def _advance_or_false(
    log_resolver: Callable[[], Any],
    credential: store.ConnectorCredential,
    service: str,
    **changes: Any,
) -> bool:
    """Write the next generation; False (logged by type only) when it could not land."""
    from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogFenced  # noqa: PLC0415

    try:
        advanced = await store.advance_credential(
            log_resolver(),
            hushh_id=_hushh_id(),
            connector_id=service,
            expected_generation=credential.generation,
            expected_credential_id=credential.credential_id,
            **changes,
        )
    except (PodLogConflict, PodLogFenced, store.ConnectorStoreMissing) as exc:
        logger.warning(
            "pod_connector_tokens.record_failed connector=%s reason=%s",
            service,
            type(exc).__name__,
        )
        return False
    if (
        advanced is None
        or advanced.credential_id != credential.credential_id
        or advanced.generation != credential.generation + 1
    ):
        return False
    if changes.get("needs_reauth"):
        return advanced.status == store.STATUS_NEEDS_REAUTH and not advanced.refresh_token
    return advanced.status == store.STATUS_CONNECTED and advanced.refresh_token == changes.get(
        "refresh_token"
    )


def _hushh_id() -> str:
    return (os.environ.get("HUSSH_ID") or "").strip()


_SOURCE: Optional[PodGoogleTokenSource] = None


def google_token_source() -> PodGoogleTokenSource:
    """The process-wide token source every in-agent Google connector shares."""
    global _SOURCE
    if _SOURCE is None:
        _SOURCE = PodGoogleTokenSource()
    return _SOURCE


__all__ = [
    "CREDENTIALS_UNAVAILABLE",
    "LEVEL_UNSUPPORTED",
    "NEEDS_REAUTH",
    "NOT_CONNECTED",
    "PROVIDER_UNREACHABLE",
    "SCOPE_NOT_GRANTED",
    "SKEW_S",
    "ConnectorTokenError",
    "PodGoogleTokenSource",
    "google_token_source",
    "required_scopes",
]
