"""OAuth adapter for curated (operator-registered) external MCP connectors.

Generalizes `external_connector_google_oauth.py`'s Drive-specific pattern
(PKCE, signed state, the v2 lifecycle store's generation/version fencing,
policy-hash-gated reconnect, leased refresh) across whichever curated
connector the registry names -- HubSpot first -- instead of a second
Drive-shaped implementation per vendor. The operator registry
(`external_mcp_connectors`) supplies the descriptor, while reviewed runtime
pins bind secret-bearing endpoint, scope, and client-variable fields. A new
connector of this same shape needs a descriptor, an `apply`, and a reviewed
runtime trust pin before it can receive an OAuth client secret.

Deliberately narrower than Drive in two ways:
- No OIDC identity verification. Drive's pattern binds a refresh token to a
  verified Google subject via the `openid`/`email` scopes and an id_token.
  Not every OAuth provider issues one -- HubSpot's remote MCP server does
  not -- so a curated connector's account label is best-effort only (there
  is no per-provider `get_user_details`-style call here; execution, not
  connection, is where that would live) and a stale refresh token can only
  be detected by the provider rejecting it (`invalid_grant`), not by an
  identity mismatch.
- No provider revocation URL. HubSpot's descriptor declares none. Disconnect
  only scrubs the local credential; the outcome is always "unavailable",
  matching `capability_policy` growing an `oauthRevokeUrl` field later if a
  connector ever needs a real revoke call.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from os import getenv
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
    ExternalConnectorCredentialsService,
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_google_oauth import (
    registered_redirect_uris as _runtime_redirect_uris,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ConnectorLifecycleError,
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.external_connector_registry_service import (
    ExternalConnectorRegistryService,
    ExternalMcpConnectorDefinition,
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError, list_tools
from hushh_mcp.services.mcp_public_http import (
    McpResponseLimitError,
    UnsafeMcpEndpoint,
    create_public_mcp_http_client,
    validate_mcp_endpoint,
)

RESPONSE_LIMIT = 256 * 1024
_REFRESH_MARGIN = timedelta(seconds=120)
# Shorter than the 20s chat-turn deadline that wraps a refresh, so a slow provider
# fails here (and releases the lease) instead of being cancelled mid-flight.
_REFRESH_POST_TIMEOUT = 12.0
_FEATURE = "curated_mcp_connectors"
# The registry is operator-writable and intentionally contains no secrets.
# It therefore cannot itself decide which process environment variable is
# safe to put in an OAuth token exchange. Keep each enabled provider's
# endpoint, scope, and secret-name binding in reviewed application code.
# Adding a provider is deliberately fail-closed until its pin is reviewed.
_CURATED_OAUTH_RUNTIME_PINS: dict[str, tuple[str, str, str, tuple[str, ...], str, str]] = {
    "hubspot": (
        "https://mcp.hubspot.com/",
        "https://mcp.hubspot.com/oauth/authorize/user",
        "https://mcp.hubspot.com/oauth/v3/token",
        (),
        "HUBSPOT_OAUTH_CLIENT_ID",
        "HUBSPOT_OAUTH_CLIENT_SECRET",
    ),
}

# Which of a curated provider's tools may run WITHOUT a per-call review card.
# Reviewed here, in code, not in the operator-writable registry: an edited row
# must not be able to free a tool. A tool also has to be annotated read-only by
# the server itself (see mcp_review_outcome); every other tool, including all
# writes, keeps exact-call review. Adding a provider or a tool is a reviewed
# code change, and a provider absent from this table keeps review on every call.
_CURATED_FREE_READ_TOOLS: dict[str, frozenset[str]] = {
    "hubspot": frozenset(
        {
            "get_user_details",
            "get_organization_details",
            "discover_hubspot_schema",
            "search_crm_objects",
            "get_crm_objects",
            "search_properties",
            "get_properties",
            "search_owners",
            "query_crm_data",
            "tool_guidance",
        }
    ),
}

logger = logging.getLogger(__name__)


def curated_free_read_tools(connector_id: str) -> frozenset[str]:
    return _CURATED_FREE_READ_TOOLS.get(connector_id, frozenset())


class CuratedConnectorOAuthError(RuntimeError):
    def __init__(self, code: str, *, status_code: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class _StateCodec(Protocol):
    """The signed-state/PKCE methods `ExternalConnectorOAuthService` already
    provides -- shared, not reimplemented, so a state token from any
    provider adapter verifies the same way."""

    @staticmethod
    def _pkce_challenge(verifier: str) -> str: ...
    def _signed_state(self, attempt_id: str) -> str: ...
    def _verify_state(self, state: str) -> str: ...


def curated_policy_hash(connector: ExternalMcpConnectorDefinition) -> str:
    """A registry edit forces reconnect: a stolen or rotated credential can
    never ride an endpoint, client, or scope grant the owner never actually
    consented to. Hashes only the fields a live connection depends on --
    never display_name/description, which are cosmetic."""
    payload = {
        "mcp_endpoint": connector.mcp_endpoint,
        "auth_style": connector.auth_style,
        "oauth_authorize_url": connector.oauth_authorize_url,
        "oauth_token_url": connector.oauth_token_url,
        "oauth_scopes": sorted(connector.oauth_scopes),
        "oauth_client_id_env": connector.oauth_client_id_env,
        "oauth_client_secret_env": connector.oauth_client_secret_env,
        # The tool allowlist only narrows which tools chat may offer; it does
        # not change what the person authorized, so editing it must not force
        # every connected user to sign in again.
        "capability_policy": {
            key: value for key, value in connector.capability_policy.items() if key != "tools"
        },
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def registered_redirect_uris(connector: ExternalMcpConnectorDefinition) -> tuple[str, ...]:
    # Same runtime rule as Drive: the shared registry row's URIs, plus the
    # loopback web return only in a development runtime on a loopback origin.
    return _runtime_redirect_uris(connector)


def is_curated_oauth_connector(connector: ExternalMcpConnectorDefinition | None) -> bool:
    """True for a connector this adapter can serve: operator-owned (never a
    private per-user row -- those never reach this admission path at all),
    OAuth, native MCP transport, and explicitly marked reviewed-chat-ready.
    Google connectors keep their own dedicated adapters and are excluded
    even though they otherwise match this shape."""
    if connector is None:
        return False
    policy = getattr(connector, "capability_policy", None) or {}
    return bool(
        getattr(connector, "owner_user_id", "unset") is None
        and getattr(connector, "auth_style", None) == "oauth"
        and getattr(connector, "transport_kind", None) == "mcp"
        and policy.get("chat") == "reviewed"
        and not str(getattr(connector, "connector_id", "google_")).startswith("google_")
    )


class ExternalConnectorCuratedOAuth:
    def __init__(
        self,
        *,
        registry: ExternalConnectorRegistryService | None = None,
        credentials: ExternalConnectorCredentialsService | None = None,
        lifecycle: ExternalConnectorLifecycleStore | None = None,
        state_codec: _StateCodec,
    ) -> None:
        self.registry = registry or get_external_connector_registry_service()
        self.credentials = credentials or get_external_connector_credentials_service()
        self.lifecycle = lifecycle or ExternalConnectorLifecycleStore()
        self.state_codec = state_codec

    async def _configuration(
        self, connector_id: str, connector: ExternalMcpConnectorDefinition | None = None
    ) -> tuple[ExternalMcpConnectorDefinition, str, str]:
        # A caller that just read the live registry row may pass it to save a query.
        if connector is None or connector.connector_id != connector_id:
            connector = await self.registry.get_connector(connector_id)
        if connector is None or not is_curated_oauth_connector(connector):
            raise CuratedConnectorOAuthError("connector_unavailable", status_code=503)
        expected = _CURATED_OAUTH_RUNTIME_PINS.get(connector.connector_id)
        if (
            expected is None
            or (
                connector.mcp_endpoint,
                connector.oauth_authorize_url,
                connector.oauth_token_url,
                connector.oauth_scopes,
                connector.oauth_client_id_env,
                connector.oauth_client_secret_env,
            )
            != expected
        ):
            raise CuratedConnectorOAuthError("connector_configuration_invalid", status_code=503)
        # A descriptor is checked on apply, but registry rows can predate that
        # validation or be changed out-of-band. Do not let an OAuth client
        # secret, authorization code, or refresh token reach a non-public
        # endpoint even briefly.
        try:
            for endpoint in (
                connector.mcp_endpoint,
                connector.oauth_authorize_url,
                connector.oauth_token_url,
            ):
                validate_mcp_endpoint(endpoint or "")
        except UnsafeMcpEndpoint:
            raise CuratedConnectorOAuthError(
                "connector_configuration_invalid", status_code=503
            ) from None
        client_id = getenv(connector.oauth_client_id_env or "", "").strip()
        client_secret = getenv(connector.oauth_client_secret_env or "", "").strip()
        if not client_id or not client_secret:
            raise CuratedConnectorOAuthError("connector_unavailable", status_code=503)
        return connector, client_id, client_secret

    async def connection_available(self, connector_id: str, *, user_id: str) -> bool:
        """Safe catalog readiness; never reveal OAuth credentials or endpoints."""
        if not connector_feature_enabled(_FEATURE, user_id):
            return False
        try:
            connector, _, _ = await self._configuration(connector_id)
        except CuratedConnectorOAuthError:
            return False
        return bool(registered_redirect_uris(connector))

    async def start(
        self, *, connector_id: str, user_id: str, redirect_uri: str, flow: str = "web"
    ) -> dict[str, Any]:
        if not connector_feature_enabled(_FEATURE, user_id):
            raise CuratedConnectorOAuthError("connector_unavailable", status_code=403)
        connector, client_id, _ = await self._configuration(connector_id)
        if flow not in {"web", "native"} or redirect_uri not in registered_redirect_uris(connector):
            raise CuratedConnectorOAuthError("redirect_not_registered")
        attempt_id = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(32)
        aad = json.dumps(
            ["external-connector-pkce-v2", user_id, connector_id, attempt_id],
            separators=(",", ":"),
        )
        encrypted = self.credentials.encrypt_secret(json.dumps({"verifier": verifier}), aad=aad)
        attempt = await self.lifecycle.start_attempt(
            user_id=user_id,
            connector_id=connector_id,
            attempt_id=attempt_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            flow=flow,
            ciphertext=encrypted["ciphertext"],
            iv=encrypted["iv"],
        )
        query = dict(
            client_id=client_id,
            redirect_uri=redirect_uri,
            response_type="code",
            state=self.state_codec._signed_state(attempt_id),
            code_challenge=self.state_codec._pkce_challenge(verifier),
            code_challenge_method="S256",
        )
        # An empty scope list is a real, deliberate request some providers
        # require (HubSpot's remote MCP server advertises scopes_supported:
        # [] and rejects a non-empty scope parameter) -- omit the query
        # param entirely rather than sending scope= with nothing after it.
        if connector.oauth_scopes:
            query["scope"] = " ".join(connector.oauth_scopes)
        return {
            "authorizeUrl": f"{connector.oauth_authorize_url}?{urlencode(query)}",
            "attemptId": attempt_id,
            "connectorId": connector_id,
            "expiresAt": attempt["expires_at"].isoformat(),
        }

    async def _post(
        self, url: str, *, token_url: str, data: dict[str, str], timeout_seconds: float = 20
    ) -> dict[str, Any]:
        # Fixed to the connector's own configured token endpoint, no
        # redirects, proxy inheritance, or response/request-body logging.
        if url != token_url:
            raise CuratedConnectorOAuthError("connector_configuration_invalid", status_code=503)
        try:
            validate_mcp_endpoint(token_url)
        except UnsafeMcpEndpoint:
            raise CuratedConnectorOAuthError(
                "connector_configuration_invalid", status_code=503
            ) from None
        try:
            async with (
                asyncio.timeout(timeout_seconds),
                create_public_mcp_http_client(
                    timeout=httpx.Timeout(15),
                    max_response_bytes=RESPONSE_LIMIT,
                ) as client,
            ):
                async with client.stream(
                    "POST", url, data=data, headers={"Accept": "application/json"}
                ) as response:
                    payload = bytearray()
                    async for chunk in response.aiter_bytes():
                        payload.extend(chunk)
                        if len(payload) > RESPONSE_LIMIT:
                            raise CuratedConnectorOAuthError(
                                "provider_response_too_large", status_code=502
                            )
                    try:
                        parsed = json.loads(payload)
                    except (ValueError, UnicodeError):
                        raise CuratedConnectorOAuthError(
                            "provider_unavailable", status_code=502
                        ) from None
                    if not isinstance(parsed, dict):
                        raise CuratedConnectorOAuthError("provider_unavailable", status_code=502)
                    if response.status_code != 200:
                        if response.status_code == 400 and parsed.get("error") == "invalid_grant":
                            raise CuratedConnectorOAuthError("grant_rejected", status_code=401)
                        raise CuratedConnectorOAuthError("provider_unavailable", status_code=503)
                    return parsed
        except McpResponseLimitError:
            raise CuratedConnectorOAuthError(
                "provider_response_too_large", status_code=502
            ) from None
        except (httpx.HTTPError, TimeoutError, UnsafeMcpEndpoint):
            raise CuratedConnectorOAuthError("provider_unavailable", status_code=503) from None

    def _token_fields(self, token: dict[str, Any]) -> dict[str, Any]:
        access = token.get("access_token")
        expiry = token.get("expires_in")
        if (
            not isinstance(access, str)
            or not 1 <= len(access) <= 16384
            or str(token.get("token_type", "")).lower() != "bearer"
            or isinstance(expiry, bool)
            or not isinstance(expiry, (int, float))
            or not 0 < expiry <= 86400
        ):
            raise CuratedConnectorOAuthError("provider_response_invalid", status_code=502)
        refresh = token.get("refresh_token")
        if refresh is not None and (not isinstance(refresh, str) or not 1 <= len(refresh) <= 16384):
            raise CuratedConnectorOAuthError("provider_response_invalid", status_code=502)
        return dict(
            accessToken=access,
            refreshToken=refresh,
            expiresAt=(datetime.now(UTC) + timedelta(seconds=expiry)).isoformat(),
        )

    async def _exchange(self, *, state: str, code: str, owner: str) -> tuple[dict, dict]:
        attempt_id = self.state_codec._verify_state(state)
        attempt = await self.lifecycle.claim_attempt(attempt_id=attempt_id, user_id=owner)
        if attempt is None:
            raise CuratedConnectorOAuthError("attempt_unavailable", status_code=409)
        connector, client_id, client_secret = await self._configuration(attempt["connector_id"])
        if attempt["oauth_client_id"] != client_id or attempt[
            "redirect_uri"
        ] not in registered_redirect_uris(connector):
            raise CuratedConnectorOAuthError("attempt_configuration_changed", status_code=409)
        aad = json.dumps(
            ["external-connector-pkce-v2", attempt["user_id"], attempt["connector_id"], attempt_id],
            separators=(",", ":"),
        )
        try:
            proof = json.loads(
                self.credentials.decrypt_secret(
                    ciphertext=attempt["code_verifier_ciphertext"],
                    iv=attempt["code_verifier_iv"],
                    aad=aad,
                )
            )
        except (ValueError, ExternalConnectorCredentialError):
            raise CuratedConnectorOAuthError("attempt_unavailable", status_code=409) from None
        token = await self._post(
            connector.oauth_token_url,
            token_url=connector.oauth_token_url,
            data=dict(
                grant_type="authorization_code",
                code=code,
                redirect_uri=attempt["redirect_uri"],
                client_id=client_id,
                client_secret=client_secret,
                code_verifier=proof["verifier"],
            ),
        )
        credential = self._token_fields(token)
        credential["oauthClientId"] = client_id
        return attempt, credential

    def _seal_activation(self, attempt: dict, current: dict, credential: dict) -> dict:
        if not credential.get("refreshToken"):
            # A curated connector has no identity check to fall back on a
            # previously-stored refresh token the way Drive can (no id_token
            # here) -- if the provider didn't hand back a fresh one, the
            # connection cannot be kept alive past this access token's life.
            raise CuratedConnectorOAuthError("offline_consent_required", status_code=409)
        return self.credentials.seal_credential(
            user_id=attempt["user_id"],
            connector_id=attempt["connector_id"],
            generation=current["connection_generation"] + 1,
            version=current["credential_version"] + 1,
            secret=credential,
            expires_at=datetime.fromisoformat(credential["expiresAt"]),
        )

    async def complete(self, *, state: str, code: str, expected_user_id: str) -> dict[str, str]:
        attempt, credential = await self._exchange(state=state, code=code, owner=expected_user_id)
        if attempt["flow"] != "web":
            raise CuratedConnectorOAuthError("attempt_flow_mismatch", status_code=409)
        result = await self.lifecycle.finalize(
            attempt_id=attempt["attempt_id"],
            user_id=expected_user_id,
            seal=lambda a, current: self._seal_activation(a, current, credential),
        )
        if result is None:
            raise CuratedConnectorOAuthError("attempt_unavailable", status_code=409)
        status = "verifying"
        try:
            if await self.verify(connector_id=attempt["connector_id"], user_id=expected_user_id):
                status = "connected"
        except (
            CuratedConnectorOAuthError,
            ExternalConnectorCredentialError,
            ExternalMcpError,
        ) as error:
            # The staged grant remains unverified; the person sees
            # "Sign-in needed" instead of a false "Connected".
            logger.warning("curated_connector_oauth.verify_failed code=%s", error)
        return {"connectorId": attempt["connector_id"], "status": status}

    async def current_credential(
        self,
        *,
        connector_id: str,
        user_id: str,
        connector: ExternalMcpConnectorDefinition | None = None,
    ) -> tuple[dict, dict]:
        """Internal only. Execution additionally enforces chat admission and
        the review policy before/after any tool call. `connector` is the live
        registry row when the caller already holds it."""
        row = await self.lifecycle.read(user_id=user_id, connector_id=connector_id, purge=False)
        if (
            not row
            or row["status"] not in {"connected", "verifying"}
            or row["envelope_version"] != 2
        ):
            raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
        connector, client_id, client_secret = await self._configuration(connector_id, connector)
        # Check the registry hasn't drifted from what was consented to BEFORE
        # any decrypt or provider call: an operator edit (endpoint, token
        # URL, client) must force reconnect, never silently carry an old
        # refresh token or access token to a changed target.
        if row.get("verified_policy_hash") not in (None, curated_policy_hash(connector)):
            raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
        credential = self.credentials.open_credential(
            user_id=user_id, connector_id=connector_id, row=row
        )
        if credential.get("oauthClientId") != client_id:
            raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
        if row["credential_expires_at"] > datetime.now(UTC) + _REFRESH_MARGIN:
            return row, credential
        common = dict(
            user_id=user_id,
            connector_id=connector_id,
            generation=row["connection_generation"],
            version=row["credential_version"],
        )
        lease_id = secrets.token_urlsafe(24)
        if not await self.lifecycle.claim_refresh(**common, lease_id=lease_id):
            # Another caller holds the lease (parallel tool calls at the margin).
            # Give it a moment to persist, then use its fresh credential.
            return await self._await_concurrent_refresh(
                user_id=user_id,
                connector_id=connector_id,
                generation=row["connection_generation"],
                client_id=client_id,
            )
        try:
            token = await self._post(
                connector.oauth_token_url,
                token_url=connector.oauth_token_url,
                data=dict(
                    grant_type="refresh_token",
                    refresh_token=credential["refreshToken"],
                    client_id=client_id,
                    client_secret=client_secret,
                ),
                timeout_seconds=_REFRESH_POST_TIMEOUT,
            )
            refreshed = {**credential, **self._token_fields(token)}
            # RFC 6749 doesn't require a refresh grant to return a new
            # refresh token; HubSpot's is documented as single-use and
            # rotating, so a provider that omits one here is treated as
            # keeping the prior token valid, not as revoking it.
            refreshed["refreshToken"] = refreshed.get("refreshToken") or credential["refreshToken"]
            encrypted = self.credentials.seal_credential(
                user_id=user_id,
                connector_id=connector_id,
                generation=common["generation"],
                version=common["version"] + 1,
                secret=refreshed,
                expires_at=datetime.fromisoformat(refreshed["expiresAt"]),
            )
            await self._persist_refresh(common, lease_id, encrypted)
        except CuratedConnectorOAuthError as error:
            await self.lifecycle.settle_refresh(
                **common, lease_id=lease_id, rejected=str(error) == "grant_rejected"
            )
            raise
        except BaseException:
            # Cancellation (the chat turn's deadline) or a storage failure: never
            # leave the lease held. Shielded so a cancel cannot skip the release.
            await asyncio.shield(self._release_lease(common, lease_id))
            raise
        updated = await self.lifecycle.read(user_id=user_id, connector_id=connector_id, purge=False)
        if (
            not updated
            or updated["connection_generation"] != common["generation"]
            or updated["status"] not in {"connected", "verifying"}
        ):
            raise CuratedConnectorOAuthError("connection_changed", status_code=409)
        return updated, self.credentials.open_credential(
            user_id=user_id, connector_id=connector_id, row=updated
        )

    async def _persist_refresh(self, common: dict[str, Any], lease_id: str, envelope: dict) -> None:
        """Store the rotated credential. The provider has already spent the old
        single-use refresh token, so a transient storage error is retried."""
        for attempt in range(3):
            try:
                stored = await self.lifecycle.settle_refresh(
                    **common, lease_id=lease_id, envelope=envelope
                )
            except ConnectorLifecycleError:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.25 * (attempt + 1))
                continue
            if not stored:
                raise CuratedConnectorOAuthError("connection_changed", status_code=409)
            return

    async def _release_lease(self, common: dict[str, Any], lease_id: str) -> None:
        try:
            await self.lifecycle.settle_refresh(**common, lease_id=lease_id)
        except Exception:
            logger.warning("curated_connector_oauth.lease_release_failed")

    async def _await_concurrent_refresh(
        self, *, user_id: str, connector_id: str, generation: int, client_id: str
    ) -> tuple[dict, dict]:
        for delay in (0.3, 0.5, 0.8):
            await asyncio.sleep(delay)
            fresh = await self.lifecycle.read(
                user_id=user_id, connector_id=connector_id, purge=False
            )
            if (
                fresh
                and fresh["connection_generation"] == generation
                and fresh["status"] in {"connected", "verifying"}
                and fresh["credential_expires_at"] > datetime.now(UTC) + _REFRESH_MARGIN
            ):
                credential = self.credentials.open_credential(
                    user_id=user_id, connector_id=connector_id, row=fresh
                )
                if credential.get("oauthClientId") != client_id:
                    break
                return fresh, credential
        raise CuratedConnectorOAuthError("refresh_in_progress", status_code=409)

    async def verify(self, *, connector_id: str, user_id: str) -> bool:
        """Prove the credential actually reaches the connector's MCP
        endpoint (not just that the OAuth exchange succeeded)."""
        connector, _, _ = await self._configuration(connector_id)
        row, credential = await self.current_credential(connector_id=connector_id, user_id=user_id)
        await list_tools(
            endpoint=connector.mcp_endpoint,
            headers={"Authorization": f"Bearer {credential['accessToken']}"},
        )
        return await self.lifecycle.mark_verified(
            user_id=user_id,
            connector_id=connector_id,
            generation=row["connection_generation"],
            version=row["credential_version"],
            policy_hash=curated_policy_hash(connector),
        )

    async def disconnect(self, *, connector_id: str, user_id: str) -> dict[str, str]:
        old = await self.lifecycle.disconnect(user_id=user_id, connector_id=connector_id)
        # No provider revoke URL exists for this adapter's connectors in v1
        # (see module docstring) -- local scrub is the whole disconnect.
        outcome = "unavailable" if old.get("credential_ciphertext") else "not_attempted"
        if old.get("credential_ciphertext"):
            await self.lifecycle.record_revocation(
                user_id=user_id,
                connector_id=connector_id,
                generation=old["connection_generation"] + 1,
                outcome=outcome,
                # No provider revoke exists to wait on, so do not hold the
                # reconnect fence that a real revocation attempt would clear.
                release_fence=True,
            )
        return {"status": "revoked", "connectorId": connector_id, "revocationOutcome": outcome}
