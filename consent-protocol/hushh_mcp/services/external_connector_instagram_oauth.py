"""Owner-bound Instagram Login and owned-media transport.

Instagram's token exchange is unlike OAuth MCP providers: it returns a short
token followed by a 60-day Instagram User token, and refreshes without a
refresh token. Keep the provider protocol and Graph calls behind this adapter.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore

CONNECTOR_ID = "instagram"
GRAPH_VERSION = "v25.0"
GRAPH_ORIGIN = "https://graph.instagram.com"
GRAPH_BASE = f"{GRAPH_ORIGIN}/{GRAPH_VERSION}"
AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize"
TOKEN_URL = "https://api.instagram.com/oauth/access_token"  # noqa: S105 - endpoint URL
LONG_TOKEN_URL = f"{GRAPH_ORIGIN}/access_token"  # noqa: S105 - endpoint URL
REFRESH_URL = f"{GRAPH_ORIGIN}/refresh_access_token"  # noqa: S105 - endpoint URL
SCOPES = (
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
    "instagram_business_manage_insights",
)
RETURN_PATH = "/one/profile/connectors/oauth/return"
POLICY = {"version": 1, "transport": "instagram_graph_rest", "account": "owner_granted"}
POLICY_HASH = hashlib.sha256(
    json.dumps(POLICY, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
_CURSOR = re.compile(r"^[A-Za-z0-9_-]{1,512}$")
_MAX_RESPONSE_BYTES = 512_000


class InstagramConnectorError(RuntimeError):
    """An authored error code; never include provider responses or credentials."""

    def __init__(self, code: str, *, status_code: int = 400) -> None:
        super().__init__(code)
        self.status_code = status_code


def _clean(value: object | None) -> str:
    return str(value or "").strip()


def _now() -> datetime:
    return datetime.now(UTC)


def _expiry(payload: dict[str, Any]) -> datetime:
    try:
        seconds = int(payload["expires_in"])
    except (KeyError, TypeError, ValueError):
        raise InstagramConnectorError("provider_token_invalid", status_code=502) from None
    if seconds < 60 or seconds > 61 * 24 * 60 * 60:
        raise InstagramConnectorError("provider_token_invalid", status_code=502)
    return _now() + timedelta(seconds=seconds)


class ExternalConnectorInstagramOAuth:
    def __init__(
        self,
        *,
        registry: Any,
        credentials: ExternalConnectorCredentialsService,
        state_codec: Any,
        lifecycle: ExternalConnectorLifecycleStore,
    ) -> None:
        self.registry = registry
        self.credentials = credentials
        self.state_codec = state_codec
        self.lifecycle = lifecycle

    async def _configuration(self) -> tuple[Any, str, str, str]:
        connector = await self.registry.get_connector(CONNECTOR_ID)
        origin = get_app_runtime_settings().app_frontend_origin.rstrip("/")
        redirect_uri = f"{origin}{RETURN_PATH}"
        parts = urlsplit(redirect_uri)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or connector is None
            or connector.owner_user_id is not None
            or connector.auth_style != "oauth"
            or connector.transport_kind != "instagram_graph_rest"
            or connector.mcp_endpoint != GRAPH_BASE
            or connector.oauth_authorize_url != AUTHORIZE_URL
            or connector.oauth_token_url != TOKEN_URL
            or tuple(connector.oauth_scopes) != SCOPES
            or connector.oauth_client_id_env != "INSTAGRAM_APP_ID"
            or connector.oauth_client_secret_env != "INSTAGRAM_APP_SECRET"  # noqa: S105 - env name
            or connector.capability_policy != POLICY
            or tuple(connector.registered_redirect_uris) != (redirect_uri,)
        ):
            raise InstagramConnectorError("connector_configuration_invalid", status_code=503)
        client_id = _clean(os.getenv("INSTAGRAM_APP_ID"))
        client_secret = _clean(os.getenv("INSTAGRAM_APP_SECRET"))
        if not client_id or not client_secret:
            raise InstagramConnectorError("connector_unavailable", status_code=503)
        return connector, client_id, client_secret, redirect_uri

    async def connection_available(self) -> bool:
        try:
            await self._configuration()
        except InstagramConnectorError:
            return False
        return True

    async def start(
        self, *, user_id: str, redirect_uri: str, flow: str, profile: str
    ) -> dict[str, str]:
        _, client_id, _, registered_redirect = await self._configuration()
        if flow != "web" or profile != "selected" or redirect_uri != registered_redirect:
            raise InstagramConnectorError("redirect_not_registered")
        attempt_id = secrets.token_urlsafe(32)
        # Instagram Login does not advertise PKCE. The encrypted nonce fills the
        # shared attempt schema; signed state and exact owner/redirect binding
        # protect the callback, and the nonce is scrubbed on completion.
        nonce = self.credentials.encrypt_secret(
            secrets.token_urlsafe(32), aad=f"instagram-oauth-attempt:{attempt_id}"
        )
        attempt = await self.lifecycle.start_attempt(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            attempt_id=attempt_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            flow="web",
            ciphertext=nonce["ciphertext"],
            iv=nonce["iv"],
        )
        query = urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": ",".join(SCOPES),
                "state": self.state_codec._signed_state(attempt_id),
                "enable_fb_login": "false",
            }
        )
        return {
            "authorizeUrl": f"{AUTHORIZE_URL}?{query}",
            "expiresAt": attempt["expires_at"].isoformat(),
            "attemptId": attempt_id,
            "connectorId": CONNECTOR_ID,
        }

    @staticmethod
    async def _request_json(
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(
                timeout=15, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    method, url, params=params, data=data, headers=headers
                ) as response:
                    if response.status_code >= 400:
                        raise InstagramConnectorError(
                            "grant_rejected"
                            if response.status_code in {400, 401, 403}
                            else "provider_unavailable",
                            status_code=502,
                        )
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > _MAX_RESPONSE_BYTES:
                            raise InstagramConnectorError(
                                "provider_response_invalid", status_code=502
                            )
        except httpx.HTTPError:
            raise InstagramConnectorError("provider_unavailable", status_code=502) from None
        try:
            payload = json.loads(body)
        except ValueError:
            raise InstagramConnectorError("provider_response_invalid", status_code=502) from None
        if not isinstance(payload, dict):
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        return payload

    @classmethod
    async def _short_token(
        cls, *, code: str, client_id: str, client_secret: str, redirect_uri: str
    ) -> dict[str, Any]:
        return await cls._request_json(
            "POST",
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code": code,
            },
            headers={"Accept": "application/json"},
        )

    @classmethod
    async def _long_token(cls, *, short_token: str, client_secret: str) -> dict[str, Any]:
        return await cls._request_json(
            "GET",
            LONG_TOKEN_URL,
            params={
                "grant_type": "ig_exchange_token",
                "client_secret": client_secret,
                "access_token": short_token,
            },
            headers={"Accept": "application/json"},
        )

    @classmethod
    async def _graph_get(
        cls, path: str, *, access_token: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        return await cls._request_json(
            "GET",
            f"{GRAPH_BASE}/{path}",
            params=params,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
        )

    async def complete(self, *, state: str, code: str, expected_user_id: str) -> dict[str, str]:
        attempt_id = self.state_codec._verify_state(state)
        attempt = await self.lifecycle.claim_attempt(
            attempt_id=attempt_id, user_id=expected_user_id
        )
        if not attempt or attempt["connector_id"] != CONNECTOR_ID or attempt["flow"] != "web":
            raise InstagramConnectorError("attempt_unavailable", status_code=409)
        _, client_id, client_secret, redirect_uri = await self._configuration()
        if attempt["oauth_client_id"] != client_id or attempt["redirect_uri"] != redirect_uri:
            raise InstagramConnectorError("connector_configuration_invalid", status_code=503)
        short = await self._short_token(
            code=code,
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
        )
        # Instagram Login wraps the code exchange in a one-element `data`
        # array. Reject any ambiguous account response before sealing a token.
        short_data = short.get("data")
        if (
            not isinstance(short_data, list)
            or len(short_data) != 1
            or not isinstance(short_data[0], dict)
        ):
            raise InstagramConnectorError("provider_token_invalid", status_code=502)
        grant = short_data[0]
        short_token = _clean(grant.get("access_token"))
        app_scoped_id = _clean(grant.get("user_id"))
        granted = frozenset(_clean(grant.get("permissions")).replace(" ", "").split(","))
        if not short_token or not app_scoped_id or not set(SCOPES).issubset(granted):
            raise InstagramConnectorError("insufficient_scope", status_code=403)
        long = await self._long_token(short_token=short_token, client_secret=client_secret)
        access_token = _clean(long.get("access_token"))
        expires_at = _expiry(long)
        if not access_token:
            raise InstagramConnectorError("provider_token_invalid", status_code=502)
        profile_data = await self._graph_get(
            "me",
            access_token=access_token,
            params={"fields": "id,user_id,username,account_type"},
        )
        profile = profile_data.get("data", profile_data)
        if isinstance(profile, list):
            profile = profile[0] if len(profile) == 1 else None
        if not isinstance(profile, dict):
            raise InstagramConnectorError("provider_identity_invalid", status_code=502)
        username = _clean(profile.get("username"))
        professional_id = _clean(profile.get("user_id"))
        if (
            _clean(profile.get("id")) != app_scoped_id
            or not professional_id.isdecimal()
            or not username
            or profile.get("account_type") not in {"Business", "Media_Creator"}
        ):
            raise InstagramConnectorError("provider_identity_invalid", status_code=502)
        secret = {
            "accessToken": access_token,
            "appScopedUserId": app_scoped_id,
            "instagramUserId": professional_id,
            "accountLabel": username[:254],
            "accountType": profile["account_type"],
            "grantedScopes": sorted(granted),
            "oauthClientId": client_id,
            "issuedAt": _now().isoformat(),
        }

        def seal(_: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
            return self.credentials.seal_credential(
                user_id=expected_user_id,
                connector_id=CONNECTOR_ID,
                generation=current["connection_generation"] + 1,
                version=current["credential_version"] + 1,
                secret=secret,
                expires_at=expires_at,
            )

        completed = await self.lifecycle.finalize(
            attempt_id=attempt_id, user_id=expected_user_id, seal=seal
        )
        if not completed:
            raise InstagramConnectorError("connection_changed", status_code=409)
        verified = await self.lifecycle.mark_verified(
            user_id=expected_user_id,
            connector_id=CONNECTOR_ID,
            generation=completed["connection_generation"],
            version=completed["credential_version"],
            policy_hash=POLICY_HASH,
        )
        if not verified:
            raise InstagramConnectorError("connection_changed", status_code=409)
        return {"status": "connected", "connectorId": CONNECTOR_ID}

    async def current_credential(self, *, user_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        row = await self.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if (
            not row
            or row["status"] != "connected"
            or row.get("validation_state") != "verified"
            or row.get("verified_policy_hash") != POLICY_HASH
            or row.get("envelope_version") != 2
        ):
            raise InstagramConnectorError("reconnect_required", status_code=401)
        _, client_id, _, _ = await self._configuration()
        credential = self.credentials.open_credential(
            user_id=user_id, connector_id=CONNECTOR_ID, row=row
        )
        if (
            credential.get("oauthClientId") != client_id
            or not set(SCOPES).issubset(set(credential.get("grantedScopes") or ()))
            or not _clean(credential.get("instagramUserId")).isdecimal()
        ):
            raise InstagramConnectorError("reconnect_required", status_code=401)
        expiry = row["credential_expires_at"]
        if expiry > _now() + timedelta(days=7):
            return row, credential
        try:
            issued = datetime.fromisoformat(credential["issuedAt"])
            if issued.tzinfo is None:
                raise ValueError("naive issue timestamp")
        except (KeyError, TypeError, ValueError):
            raise InstagramConnectorError("reconnect_required", status_code=401) from None
        if issued + timedelta(hours=24) > _now():
            if expiry > _now() + timedelta(minutes=5):
                return row, credential
            raise InstagramConnectorError("reconnect_required", status_code=401)
        common = {
            "user_id": user_id,
            "connector_id": CONNECTOR_ID,
            "generation": row["connection_generation"],
            "version": row["credential_version"],
        }
        lease_id = secrets.token_urlsafe(24)
        if not await self.lifecycle.claim_refresh(**common, lease_id=lease_id):
            raise InstagramConnectorError("refresh_in_progress", status_code=409)
        try:
            refreshed = await self._request_json(
                "GET",
                REFRESH_URL,
                params={
                    "grant_type": "ig_refresh_token",
                    "access_token": credential["accessToken"],
                },
                headers={"Accept": "application/json"},
            )
            token = _clean(refreshed.get("access_token"))
            if not token:
                raise InstagramConnectorError("provider_token_invalid", status_code=502)
            refreshed_secret = {
                **credential,
                "accessToken": token,
                "issuedAt": _now().isoformat(),
            }
            envelope = self.credentials.seal_credential(
                user_id=user_id,
                connector_id=CONNECTOR_ID,
                generation=common["generation"],
                version=common["version"] + 1,
                secret=refreshed_secret,
                expires_at=_expiry(refreshed),
            )
            if not await self.lifecycle.settle_refresh(
                **common, lease_id=lease_id, envelope=envelope
            ):
                raise InstagramConnectorError("connection_changed", status_code=409)
        except BaseException as error:
            # Cancellation and envelope failures must release the short lease.
            # Shield the cleanup so a cancelled request cannot strand it.
            await asyncio.shield(
                self.lifecycle.settle_refresh(
                    **common,
                    lease_id=lease_id,
                    rejected=isinstance(error, InstagramConnectorError)
                    and str(error) == "grant_rejected",
                )
            )
            raise
        updated = await self.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if (
            not updated
            or updated["connection_generation"] != common["generation"]
            or updated["status"] != "connected"
        ):
            raise InstagramConnectorError("connection_changed", status_code=409)
        return updated, self.credentials.open_credential(
            user_id=user_id, connector_id=CONNECTOR_ID, row=updated
        )

    async def owned_media(
        self, *, user_id: str, limit: int = 25, after: str | None = None
    ) -> dict[str, Any]:
        if limit < 1 or limit > 50 or (after is not None and not _CURSOR.fullmatch(after)):
            raise InstagramConnectorError("invalid_media_page")
        row, credential = await self.current_credential(user_id=user_id)
        params: dict[str, Any] = {
            "fields": "id,caption,media_type,media_url,permalink,timestamp,thumbnail_url",
            "limit": limit,
        }
        if after:
            params["after"] = after
        payload = await self._graph_get(
            f"{credential['instagramUserId']}/media",
            access_token=credential["accessToken"],
            params=params,
        )
        current = await self.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID, purge=False)
        if (
            not current
            or current["status"] != "connected"
            or current["connection_generation"] != row["connection_generation"]
            or current["credential_version"] != row["credential_version"]
        ):
            raise InstagramConnectorError("connection_changed", status_code=409)
        raw_items = payload.get("data")
        if not isinstance(raw_items, list) or len(raw_items) > limit:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        posts = []
        for item in raw_items:
            if not isinstance(item, dict) or not _clean(item.get("id")).isdecimal():
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            permalink = _clean(item.get("permalink"))
            parts = urlsplit(permalink)
            try:
                port = parts.port
            except ValueError:
                raise InstagramConnectorError(
                    "provider_response_invalid", status_code=502
                ) from None
            if (
                len(permalink) > 2048
                or any(ord(char) <= 32 for char in permalink)
                or parts.scheme != "https"
                or parts.username
                or parts.password
                or port
                or parts.hostname
                not in {
                    "instagram.com",
                    "www.instagram.com",
                }
            ):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            posts.append(
                {
                    "id": item["id"],
                    "caption": _clean(item.get("caption"))[:2200],
                    "mediaType": _clean(item.get("media_type")),
                    "permalink": permalink,
                    "timestamp": _clean(item.get("timestamp")),
                    "mediaUrl": _clean(item.get("media_url")) or None,
                    "thumbnailUrl": _clean(item.get("thumbnail_url")) or None,
                }
            )
        paging = payload.get("paging")
        cursors = paging.get("cursors") if isinstance(paging, dict) else None
        next_cursor = cursors.get("after") if isinstance(cursors, dict) else None
        if next_cursor is not None and not _CURSOR.fullmatch(str(next_cursor)):
            next_cursor = None
        return {"posts": posts, "nextCursor": next_cursor}

    async def disconnect(self, *, user_id: str) -> dict[str, str]:
        old = await self.lifecycle.disconnect(user_id=user_id, connector_id=CONNECTOR_ID)
        # Instagram Login's documented token lifecycle has no token revocation
        # endpoint. The local grant is scrubbed and fenced; the owner can also
        # remove the app in Instagram's Apps and Websites settings.
        outcome = "unavailable" if old.get("credential_ciphertext") else "not_attempted"
        if outcome == "unavailable":
            await self.lifecycle.record_revocation(
                user_id=user_id,
                connector_id=CONNECTOR_ID,
                generation=old["connection_generation"] + 1,
                outcome=outcome,
                release_fence=True,
            )
        return {"status": "revoked", "connectorId": CONNECTOR_ID, "revocationOutcome": outcome}
