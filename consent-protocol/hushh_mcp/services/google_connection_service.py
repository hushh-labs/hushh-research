"""Shared, consent-safe Google OAuth credential and service-grant boundary.

This is deliberately independent from the legacy Gmail receipt tables. New
services use this normalized account + grant model; Gmail can migrate through a
compatibility facade after the new flow has baked. Tokens never leave this
service and are encrypted with authenticated user/provider-bound data.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_app_runtime_settings, get_core_security_settings

GoogleService = Literal["gmail", "calendar", "contacts"]

_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - OAuth endpoint, not a credential
_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
# Calendar is a first-class One agent. Keep its provider callback on the same
# canonical One route declared by the web navigation contract; the old
# `/profile/...` page remains only as a compatibility handler for old links.
_RETURN_PATH = "/one/profile/google/oauth/return"
_SERVICE_SCOPES: dict[GoogleService, dict[str, tuple[str, ...]]] = {
    "gmail": {"read": ("https://www.googleapis.com/auth/gmail.readonly",)},
    "calendar": {
        "read": (
            "https://www.googleapis.com/auth/calendar.events.readonly",
            "https://www.googleapis.com/auth/calendar.freebusy",
        ),
        "manage": (
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.freebusy",
        ),
    },
    "contacts": {"read": ("https://www.googleapis.com/auth/contacts.readonly",)},
}


class GoogleConnectionError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(UTC)


def _clean(value: object | None) -> str:
    return str(value or "").strip()


class GoogleConnectionService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def _execute_raw_async(self, sql: str, params: dict[str, Any] | None = None) -> Any:
        """Keep legacy synchronous database work off the async request loop."""
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    @staticmethod
    def _env(primary: str, legacy: str) -> str:
        return _clean(os.getenv(primary) or os.getenv(legacy))

    def _client_id(self) -> str:
        return self._env("GOOGLE_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_ID")

    def _client_secret(self) -> str:
        return self._env("GOOGLE_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_CLIENT_SECRET")

    def _configured_redirect(self) -> str:
        # The generic setting wins. During the Gmail compatibility period,
        # derive Calendar's distinct callback from the backend-owned origin
        # rather than incorrectly reusing Gmail's callback secret.
        configured = _clean(os.getenv("GOOGLE_OAUTH_REDIRECT_URI"))
        if configured:
            return configured
        origin = get_app_runtime_settings().app_frontend_origin
        if origin:
            return f"{origin}{_RETURN_PATH}"
        return _clean(os.getenv("GMAIL_OAUTH_REDIRECT_URI"))

    def _signing_key(self) -> bytes:
        try:
            key = get_core_security_settings().app_signing_key
        except ValueError as exc:
            raise GoogleConnectionError(
                "Google OAuth state signing is not configured", status_code=503
            ) from exc
        return key.encode()

    def _token_key(self) -> bytes:
        raw = self._env("GOOGLE_OAUTH_TOKEN_KEY", "GMAIL_OAUTH_TOKEN_KEY")
        if not raw:
            raise GoogleConnectionError("Google token storage is not configured", status_code=503)
        try:
            decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            if len(decoded) in {16, 24, 32}:
                return decoded
        except Exception:
            pass
        encoded = raw.encode()
        if len(encoded) in {16, 24, 32}:
            return encoded
        raise GoogleConnectionError("Google token storage key is invalid", status_code=503)

    def is_configured(self) -> bool:
        return bool(self._client_id() and self._client_secret() and self._configured_redirect())

    def _redirect_uri(self, supplied: str | None) -> str:
        configured = self._configured_redirect()
        if not configured:
            raise GoogleConnectionError("Google OAuth is not configured", status_code=503)
        origin = get_app_runtime_settings().app_frontend_origin
        expected = f"{origin}{_RETURN_PATH}" if origin else configured
        if configured != expected:
            raise GoogleConnectionError(
                "Google OAuth redirect configuration is invalid", status_code=503
            )
        if supplied and not hmac.compare_digest(_clean(supplied), configured):
            raise GoogleConnectionError("Google OAuth redirect URI is not allowed", status_code=400)
        return configured

    @staticmethod
    def scopes(service: GoogleService, access_level: Literal["read", "manage"]) -> tuple[str, ...]:
        if service not in _SERVICE_SCOPES or access_level not in _SERVICE_SCOPES[service]:
            raise GoogleConnectionError("Unsupported Google service permission", status_code=422)
        return _SERVICE_SCOPES[service][access_level]

    def _encrypt(self, value: str, *, aad: str) -> dict[str, str]:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._token_key()).encrypt(nonce, value.encode(), aad.encode())
        return {
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode(),
            "iv": base64.urlsafe_b64encode(nonce).decode(),
            "tag": "aad-gcm-v1",
        }

    def _decrypt(self, envelope: dict[str, Any], *, aad: str) -> str:
        try:
            nonce = base64.urlsafe_b64decode(_clean(envelope["iv"]))
            ciphertext = base64.urlsafe_b64decode(_clean(envelope["ciphertext"]))
            return AESGCM(self._token_key()).decrypt(nonce, ciphertext, aad.encode()).decode()
        except Exception as exc:
            raise GoogleConnectionError(
                "Google connection needs reauthorization", status_code=401
            ) from exc

    @staticmethod
    def _pkce_challenge(verifier: str) -> str:
        digest = hashlib.sha256(verifier.encode()).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()

    def _signed_state(self, attempt_id: str) -> str:
        signature = hmac.new(self._signing_key(), attempt_id.encode(), hashlib.sha256).hexdigest()
        return f"{attempt_id}.{signature}"

    def _verify_state(self, state: str) -> str:
        attempt_id, dot, signature = _clean(state).partition(".")
        if not dot or not attempt_id or not signature:
            raise GoogleConnectionError("Google OAuth state is invalid", status_code=400)
        expected = hmac.new(self._signing_key(), attempt_id.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise GoogleConnectionError("Google OAuth state is invalid", status_code=400)
        return attempt_id

    async def start(
        self,
        *,
        user_id: str,
        service: GoogleService,
        access_level: Literal["read", "manage"],
        redirect_uri: str | None,
        login_hint: str | None,
    ) -> dict[str, Any]:
        if not self.is_configured():
            raise GoogleConnectionError("Google OAuth is not configured", status_code=503)
        resolved_redirect = self._redirect_uri(redirect_uri)
        requested_scopes = ("openid", "email", "profile", *self.scopes(service, access_level))
        attempt_id = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        state = self._signed_state(attempt_id)
        await self._execute_raw_async(
            """
            INSERT INTO google_oauth_attempts (
              attempt_id, user_id, service, redirect_uri, requested_scope_csv,
              state_digest, verifier_ciphertext, verifier_iv, verifier_tag, expires_at
            ) VALUES (
              :attempt_id, :user_id, :service, :redirect_uri, :scope_csv,
              :state_digest, :ciphertext, :iv, :tag, :expires_at
            )
            """,
            {
                "attempt_id": attempt_id,
                "user_id": user_id,
                "service": service,
                "redirect_uri": resolved_redirect,
                "scope_csv": " ".join(requested_scopes),
                "state_digest": hashlib.sha256(state.encode()).hexdigest(),
                **self._encrypt(verifier, aad=f"oauth-attempt:{attempt_id}"),
                "expires_at": _now() + timedelta(minutes=10),
            },
        )
        query = {
            "client_id": self._client_id(),
            "redirect_uri": resolved_redirect,
            "response_type": "code",
            "scope": " ".join(requested_scopes),
            "access_type": "offline",
            "include_granted_scopes": "true",
            "code_challenge": self._pkce_challenge(verifier),
            "code_challenge_method": "S256",
            "state": state,
            "prompt": "consent select_account" if not _clean(login_hint) else "consent",
        }
        if _clean(login_hint):
            query["login_hint"] = _clean(login_hint)
        return {
            "configured": True,
            "authorize_url": f"{_AUTHORIZE_URL}?{urlencode(query)}",
            "redirect_uri": resolved_redirect,
            "expires_at": (_now() + timedelta(minutes=10)).isoformat(),
        }

    async def _post_form(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(url, data=data)
        if response.status_code >= 400:
            try:
                error_payload = response.json()
            except ValueError:
                error_payload = {}
            if (
                isinstance(error_payload, dict)
                and _clean(error_payload.get("error")) == "invalid_grant"
            ):
                raise GoogleConnectionError(
                    "Google connection needs reauthorization", status_code=401
                )
            raise GoogleConnectionError("Google authorization request failed", status_code=502)
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def _userinfo(self, access_token: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                _USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
            )
        if response.status_code >= 400:
            raise GoogleConnectionError(
                "Google account profile could not be verified", status_code=502
            )
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def _connection(self, user_id: str) -> dict[str, Any] | None:
        result = await self._execute_raw_async(
            "SELECT * FROM google_provider_connections WHERE user_id = :user_id AND provider = 'google'",
            {"user_id": user_id},
        )
        return result.data[0] if result.data else None

    async def _mark_needs_reauth(
        self,
        *,
        user_id: str,
        service: GoogleService,
        expected_refresh_ciphertext: str | None,
    ) -> None:
        """Fail closed after Google rejects a refresh token.

        A refresh-token rejection is durable provider state, not a transient
        Calendar API failure. Persisting it keeps status and the reconnect UI
        truthful instead of claiming a dead credential is connected.
        """
        updated = await self._execute_raw_async(
            """
            UPDATE google_provider_connections
            SET status = 'needs_reauth',
                access_token_ciphertext = NULL,
                access_token_iv = NULL,
                access_token_tag = NULL,
                access_token_expires_at = NULL,
                updated_at = NOW()
            WHERE user_id = :user_id
              AND provider = 'google'
              AND status = 'connected'
              AND refresh_token_ciphertext = :expected_refresh_ciphertext
            RETURNING user_id
            """,
            {
                "user_id": user_id,
                "expected_refresh_ciphertext": expected_refresh_ciphertext,
            },
        )
        if not updated.data:
            return
        await self._execute_raw_async(
            """
            UPDATE google_service_grants
            SET status = 'needs_reauth', updated_at = NOW()
            WHERE user_id = :user_id AND provider = 'google' AND service = :service
            """,
            {"user_id": user_id, "service": service},
        )

    async def _store_authorized_connection(
        self,
        *,
        user_id: str,
        token: dict[str, Any],
        service: GoogleService,
        requested_scopes: tuple[str, ...],
        oauth_started_at: datetime,
    ) -> dict[str, Any]:
        access_token = _clean(token.get("access_token"))
        if not access_token:
            raise GoogleConnectionError("Google did not return an access token", status_code=502)
        existing = await self._connection(user_id)
        refresh_token = _clean(token.get("refresh_token"))
        if not refresh_token and existing:
            refresh_token = self._decrypt(
                {
                    "ciphertext": existing.get("refresh_token_ciphertext"),
                    "iv": existing.get("refresh_token_iv"),
                },
                aad=f"google-connection:{user_id}",
            )
        if not refresh_token:
            raise GoogleConnectionError(
                "Google did not return a refresh token; reconnect and grant consent",
                status_code=400,
            )
        profile = await self._userinfo(access_token)
        expires_at = _now() + timedelta(seconds=max(60, int(token.get("expires_in") or 3600)))
        refresh = self._encrypt(refresh_token, aad=f"google-connection:{user_id}")
        access = self._encrypt(access_token, aad=f"google-connection:{user_id}")
        connection_write = await self._execute_raw_async(
            """INSERT INTO google_provider_connections (
                 user_id, provider, provider_subject, provider_email, status,
                 refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
                 access_token_ciphertext, access_token_iv, access_token_tag, access_token_expires_at, connected_at
               ) VALUES (
                 :user_id, 'google', :subject, :email, 'connected',
                 :refresh_ciphertext, :refresh_iv, :refresh_tag,
                 :access_ciphertext, :access_iv, :access_tag, :expires_at, NOW()
               ) ON CONFLICT (user_id, provider) DO UPDATE SET
                 provider_subject = EXCLUDED.provider_subject, provider_email = EXCLUDED.provider_email,
                 status = 'connected', refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                 refresh_token_iv = EXCLUDED.refresh_token_iv, refresh_token_tag = EXCLUDED.refresh_token_tag,
                 access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                 access_token_iv = EXCLUDED.access_token_iv, access_token_tag = EXCLUDED.access_token_tag,
                 access_token_expires_at = EXCLUDED.access_token_expires_at, revoked_at = NULL, updated_at = NOW()
               WHERE google_provider_connections.status <> 'disconnected'
                  OR google_provider_connections.revoked_at IS NULL
                  OR google_provider_connections.revoked_at <= :oauth_started_at
               RETURNING user_id""",
            {
                "user_id": user_id,
                "subject": _clean(profile.get("sub")) or None,
                "email": _clean(profile.get("email")).lower() or None,
                "expires_at": expires_at,
                "refresh_ciphertext": refresh["ciphertext"],
                "refresh_iv": refresh["iv"],
                "refresh_tag": refresh["tag"],
                "access_ciphertext": access["ciphertext"],
                "access_iv": access["iv"],
                "access_tag": access["tag"],
                "oauth_started_at": oauth_started_at,
            },
        )
        if not connection_write.data:
            raise GoogleConnectionError(
                "This Google authorization was cancelled. Start a new connection to continue.",
                status_code=409,
            )
        scopes = _clean(token.get("scope")) or " ".join(requested_scopes)
        level = (
            "manage"
            if service == "calendar"
            and "https://www.googleapis.com/auth/calendar.events" in scopes.split()
            else "read"
        )
        grant_write = await self._execute_raw_async(
            """INSERT INTO google_service_grants (user_id, provider, service, status, scope_csv, access_level)
               VALUES (:user_id, 'google', :service, 'connected', :scope_csv, :access_level)
               ON CONFLICT (user_id, provider, service) DO UPDATE SET status = 'connected',
                 scope_csv = EXCLUDED.scope_csv, access_level = EXCLUDED.access_level,
                 disconnected_at = NULL, updated_at = NOW()
               WHERE google_service_grants.disconnected_at IS NULL
                  OR google_service_grants.disconnected_at <= :oauth_started_at
               RETURNING user_id""",
            {
                "user_id": user_id,
                "service": service,
                "scope_csv": scopes,
                "access_level": level,
                "oauth_started_at": oauth_started_at,
            },
        )
        if not grant_write.data:
            raise GoogleConnectionError(
                "This Google authorization was cancelled. Start a new connection to continue.",
                status_code=409,
            )
        return await self.status(user_id=user_id, service=service)

    async def complete(
        self, *, user_id: str, code: str, state: str, redirect_uri: str | None
    ) -> dict[str, Any]:
        attempt_id = self._verify_state(state)
        result = await self._execute_raw_async(
            """UPDATE google_oauth_attempts SET consumed_at = NOW()
               WHERE attempt_id = :attempt_id AND user_id = :user_id AND consumed_at IS NULL
                 AND expires_at > NOW() AND state_digest = :state_digest
               RETURNING *""",
            {
                "attempt_id": attempt_id,
                "user_id": user_id,
                "state_digest": hashlib.sha256(state.encode()).hexdigest(),
            },
        )
        if not result.data:
            raise GoogleConnectionError(
                "Google OAuth attempt has expired or was already used", status_code=400
            )
        attempt = result.data[0]
        if redirect_uri and not hmac.compare_digest(
            _clean(redirect_uri), _clean(attempt["redirect_uri"])
        ):
            raise GoogleConnectionError("Google OAuth redirect URI is not allowed", status_code=400)
        verifier = self._decrypt(
            {"ciphertext": attempt["verifier_ciphertext"], "iv": attempt["verifier_iv"]},
            aad=f"oauth-attempt:{attempt_id}",
        )
        token = await self._post_form(
            _TOKEN_URL,
            {
                "code": code,
                "client_id": self._client_id(),
                "client_secret": self._client_secret(),
                "redirect_uri": attempt["redirect_uri"],
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
        )
        raw_service = _clean(attempt["service"])
        if raw_service not in _SERVICE_SCOPES:
            raise GoogleConnectionError("Unsupported Google service", status_code=400)
        service = cast(GoogleService, raw_service)
        requested_scopes = tuple(_clean(attempt["requested_scope_csv"]).split())
        oauth_started_at = attempt.get("created_at")
        if not isinstance(oauth_started_at, datetime):
            oauth_started_at = _now()
        return await self._store_authorized_connection(
            user_id=user_id,
            token=token,
            service=service,
            requested_scopes=requested_scopes,
            oauth_started_at=oauth_started_at,
        )

    async def start_native(
        self,
        *,
        service: GoogleService,
        access_level: Literal["read", "manage"],
    ) -> dict[str, Any]:
        """Return the public OAuth client for a platform Google sign-in request."""
        if not self.is_configured():
            raise GoogleConnectionError("Google OAuth is not configured", status_code=503)
        return {
            "configured": True,
            "server_client_id": self._client_id(),
            "service": service,
            "access_level": access_level,
        }

    async def complete_native(
        self,
        *,
        user_id: str,
        service: GoogleService,
        access_level: Literal["read", "manage"],
        server_auth_code: str,
    ) -> dict[str, Any]:
        """Exchange a short-lived native server code without a WebView callback."""
        if not self.is_configured():
            raise GoogleConnectionError("Google OAuth is not configured", status_code=503)
        code = _clean(server_auth_code)
        if not code:
            raise GoogleConnectionError("Missing native Google authorization code", status_code=400)
        token = await self._post_form(
            _TOKEN_URL,
            {
                "code": code,
                "client_id": self._client_id(),
                "client_secret": self._client_secret(),
                "redirect_uri": "",
                "grant_type": "authorization_code",
            },
        )
        return await self._store_authorized_connection(
            user_id=user_id,
            token=token,
            service=service,
            requested_scopes=("openid", "email", "profile", *self.scopes(service, access_level)),
            oauth_started_at=_now(),
        )

    async def access_token(
        self, *, user_id: str, service: GoogleService, access_level: Literal["read", "manage"]
    ) -> str:
        row = await self._connection(user_id)
        if not row or row.get("status") != "connected":
            raise GoogleConnectionError("Connect Google Calendar first", status_code=403)
        grant = (
            await self._execute_raw_async(
                "SELECT * FROM google_service_grants WHERE user_id = :user_id AND provider = 'google' AND service = :service",
                {"user_id": user_id, "service": service},
            )
        ).data
        if (
            not grant
            or grant[0].get("status") != "connected"
            or (access_level == "manage" and grant[0].get("access_level") != "manage")
        ):
            raise GoogleConnectionError(
                "Additional Google Calendar permission is required", status_code=403
            )
        granted_scopes = set(_clean(grant[0].get("scope_csv")).split())
        required_scopes = set(self.scopes(service, access_level))
        if not required_scopes.issubset(granted_scopes):
            raise GoogleConnectionError(
                "Additional Google Calendar permission is required", status_code=403
            )
        expiry = row.get("access_token_expires_at")
        try:
            if expiry and datetime.fromisoformat(
                str(expiry).replace("Z", "+00:00")
            ) > _now() + timedelta(seconds=90):
                return self._decrypt(
                    {
                        "ciphertext": row.get("access_token_ciphertext"),
                        "iv": row.get("access_token_iv"),
                    },
                    aad=f"google-connection:{user_id}",
                )
        except ValueError:
            pass
        refresh_token = self._decrypt(
            {"ciphertext": row.get("refresh_token_ciphertext"), "iv": row.get("refresh_token_iv")},
            aad=f"google-connection:{user_id}",
        )
        try:
            token = await self._post_form(
                _TOKEN_URL,
                {
                    "client_id": self._client_id(),
                    "client_secret": self._client_secret(),
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        except GoogleConnectionError as exc:
            if exc.status_code == 401:
                await self._mark_needs_reauth(
                    user_id=user_id,
                    service=service,
                    expected_refresh_ciphertext=_clean(row.get("refresh_token_ciphertext")) or None,
                )
            raise
        access_token = _clean(token.get("access_token"))
        if not access_token:
            raise GoogleConnectionError("Google connection needs reauthorization", status_code=401)
        envelope = self._encrypt(access_token, aad=f"google-connection:{user_id}")
        token_write = await self._execute_raw_async(
            """UPDATE google_provider_connections SET access_token_ciphertext = :ciphertext,
               access_token_iv = :iv, access_token_tag = :tag,
               access_token_expires_at = :expires_at, updated_at = NOW()
               WHERE user_id = :user_id AND provider = 'google' AND status = 'connected'
               RETURNING user_id""",
            {
                **envelope,
                "expires_at": _now()
                + timedelta(seconds=max(60, int(token.get("expires_in") or 3600))),
                "user_id": user_id,
            },
        )
        if not token_write.data:
            raise GoogleConnectionError("Google connection is no longer active", status_code=409)
        return access_token

    async def status(self, *, user_id: str, service: str) -> dict[str, Any]:
        connection = await self._connection(user_id)
        result = await self._execute_raw_async(
            "SELECT * FROM google_service_grants WHERE user_id = :user_id AND provider = 'google' AND service = :service",
            {"user_id": user_id, "service": service},
        )
        grant = result.data[0] if result.data else None
        connection_active = bool(connection and connection.get("status") == "connected")
        grant_status = _clean(grant.get("status")) if grant else "disconnected"
        status = (
            grant_status
            if connection_active
            else "needs_reauth"
            if connection and connection.get("status") == "needs_reauth"
            else "disconnected"
        )
        return {
            "configured": self.is_configured(),
            "connected": bool(connection_active and grant_status == "connected"),
            "google_email": connection.get("provider_email") if connection_active else None,
            "status": status,
            "access_level": grant.get("access_level") if connection_active and grant else None,
            "scope_csv": grant.get("scope_csv") if connection_active and grant else "",
        }

    async def disconnect_service(self, *, user_id: str, service: GoogleService) -> dict[str, Any]:
        """Stop Hussh access to one Google service without revoking sibling grants.

        Google revocation is account/client-wide, so revoking here would also
        break a still-enabled Gmail grant. We locally disable the service and
        delete its pending actions; the account-level revoke remains the only
        operation that calls Google's revocation endpoint.
        """
        connection = await self._connection(user_id)
        refresh_token = ""
        if connection and connection.get("status") == "connected":
            try:
                refresh_token = self._decrypt(
                    {
                        "ciphertext": connection.get("refresh_token_ciphertext"),
                        "iv": connection.get("refresh_token_iv"),
                    },
                    aad=f"google-connection:{user_id}",
                )
            except GoogleConnectionError:
                # Local disable and token erasure remain reliable even if a
                # legacy/corrupt envelope cannot be sent to Google's revoke API.
                refresh_token = ""
        await self._execute_raw_async(
            """UPDATE google_service_grants SET status = 'disconnected', disconnected_at = NOW(),
               updated_at = NOW() WHERE user_id = :user_id AND provider = 'google' AND service = :service""",
            {"user_id": user_id, "service": service},
        )
        await self._execute_raw_async(
            """UPDATE google_oauth_attempts
               SET consumed_at = NOW()
               WHERE user_id = :user_id AND service = :service AND consumed_at IS NULL""",
            {"user_id": user_id, "service": service},
        )
        if service == "calendar":
            await self._execute_raw_async(
                "DELETE FROM google_calendar_action_proposals WHERE user_id = :user_id AND status IN ('pending', 'executing')",
                {"user_id": user_id},
            )
        active_siblings = await self._execute_raw_async(
            """
            SELECT 1 FROM google_service_grants
            WHERE user_id = :user_id AND provider = 'google' AND service <> :service
              AND status = 'connected'
            LIMIT 1
            """,
            {"user_id": user_id, "service": service},
        )
        if not active_siblings.data:
            await self._execute_raw_async(
                """
                UPDATE google_provider_connections
                SET status = 'disconnected',
                    refresh_token_ciphertext = NULL,
                    refresh_token_iv = NULL,
                    refresh_token_tag = NULL,
                    access_token_ciphertext = NULL,
                    access_token_iv = NULL,
                    access_token_tag = NULL,
                    access_token_expires_at = NULL,
                    revoked_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = :user_id AND provider = 'google'
                """,
                {"user_id": user_id},
            )
            if refresh_token:
                try:
                    async with httpx.AsyncClient(timeout=5) as client:
                        await client.post(_REVOKE_URL, data={"token": refresh_token})
                except httpx.HTTPError:
                    # Local deletion has completed; provider revoke is best effort.
                    pass
        return await self.status(user_id=user_id, service=service)


_singleton: GoogleConnectionService | None = None


def get_google_connection_service() -> GoogleConnectionService:
    global _singleton
    if _singleton is None:
        _singleton = GoogleConnectionService()
    return _singleton
