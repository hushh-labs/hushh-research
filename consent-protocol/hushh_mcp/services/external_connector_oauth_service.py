"""Generic OAuth PKCE start/complete for an oauth-style external connector.

Generalizes `google_connection_service.py`'s start()/complete() shape (signed
state, PKCE verifier encrypted at rest, short-lived attempt row) across
whichever connector the registry names, instead of one Google-specific
implementation. The connector's own `oauth_authorize_url` / `oauth_token_url`
/ `oauth_scopes` / `oauth_client_id_env` / `oauth_client_secret_env` come
from `external_mcp_connectors` (`external_connector_registry_service.py`),
never hardcoded here -- a new OAuth-style connector needs a registry row and
two env vars, not a code change.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_registry_service import (
    ExternalConnectorRegistryService,
    get_external_connector_registry_service,
)


class ExternalConnectorOAuthError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(UTC)


def _clean(value: object | None) -> str:
    return str(value or "").strip()


class ExternalConnectorOAuthService:
    def __init__(
        self,
        *,
        db: Any | None = None,
        registry: ExternalConnectorRegistryService | None = None,
        credentials: ExternalConnectorCredentialsService | None = None,
    ) -> None:
        self.db = db or get_db()
        self._registry = registry or get_external_connector_registry_service()
        self._credentials = credentials or get_external_connector_credentials_service()

    def drive(self):
        # Import-safe adapter; shares registry, credentials, signed state and
        # database with existing connectors, never the Mail credential domain.
        from hushh_mcp.services.external_connector_google_oauth import ExternalConnectorGoogleOAuth

        return ExternalConnectorGoogleOAuth(
            db=self.db, registry=self._registry, credentials=self._credentials, state_codec=self
        )

    async def _execute(
        self, sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(self.db.execute_raw, sql, params)
        return result.data or []

    def _signing_key(self) -> bytes:
        try:
            return get_core_security_settings().app_signing_key.encode()
        except ValueError as exc:
            raise ExternalConnectorOAuthError(
                "OAuth state signing is not configured", status_code=503
            ) from exc

    @staticmethod
    def _pkce_challenge(verifier: str) -> str:
        import base64

        digest = hashlib.sha256(verifier.encode()).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()

    def _signed_state(self, attempt_id: str) -> str:
        signature = hmac.new(self._signing_key(), attempt_id.encode(), hashlib.sha256).hexdigest()
        return f"{attempt_id}.{signature}"

    def _verify_state(self, state: str) -> str:
        attempt_id, dot, signature = _clean(state).partition(".")
        if not dot or not attempt_id or not signature:
            raise ExternalConnectorOAuthError("OAuth state is invalid")
        expected = hmac.new(self._signing_key(), attempt_id.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ExternalConnectorOAuthError("OAuth state is invalid")
        return attempt_id

    async def start(
        self,
        *,
        user_id: str,
        connector_id: str,
        redirect_uri: str,
        flow: str = "web",
        profile: str = "selected",
    ) -> dict[str, Any]:
        if connector_id == "google_drive":
            return await self.drive().start(
                user_id=user_id, redirect_uri=redirect_uri, flow=flow, profile=profile
            )
        if profile != "selected":
            raise ExternalConnectorOAuthError("This connector does not support live access")
        if flow != "web":
            raise ExternalConnectorOAuthError(
                "This connector does not support native authorization"
            )
        connector = await self._registry.get_connector(connector_id)
        if connector is None or connector.auth_style != "oauth":
            raise ExternalConnectorOAuthError("This connector does not support OAuth")
        client_id = _clean(os.getenv(connector.oauth_client_id_env or ""))
        if not client_id:
            raise ExternalConnectorOAuthError(
                f"{connector.display_name} is not configured in this environment", status_code=503
            )
        attempt_id = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        state = self._signed_state(attempt_id)
        credentials = self._credentials
        envelope = credentials.encrypt_secret(
            verifier, aad=f"external-connector-oauth-attempt:{attempt_id}"
        )
        expires_at = _now() + timedelta(minutes=10)
        await self._execute(
            """INSERT INTO external_connector_oauth_attempts (
                 attempt_id, user_id, connector_id,
                 code_verifier_ciphertext, code_verifier_iv, redirect_uri, expires_at
               ) VALUES (
                 :attempt_id, :user_id, :connector_id,
                 :ciphertext, :iv, :redirect_uri, :expires_at
               )""",
            {
                "attempt_id": attempt_id,
                "user_id": user_id,
                "connector_id": connector_id,
                "ciphertext": envelope["ciphertext"],
                "iv": envelope["iv"],
                "redirect_uri": redirect_uri,
                "expires_at": expires_at,
            },
        )
        query = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(connector.oauth_scopes),
            "code_challenge": self._pkce_challenge(verifier),
            "code_challenge_method": "S256",
            "state": state,
        }
        return {
            "authorizeUrl": f"{connector.oauth_authorize_url}?{urlencode(query)}",
            "expiresAt": expires_at.isoformat(),
        }

    async def complete(self, *, state: str, code: str, expected_user_id: str) -> dict[str, Any]:
        attempt_id = self._verify_state(state)
        rows = await self._execute(
            """SELECT user_id, connector_id, code_verifier_ciphertext, code_verifier_iv,
                      redirect_uri, expires_at, consumed_at
               FROM external_connector_oauth_attempts
               WHERE attempt_id = :attempt_id""",
            {"attempt_id": attempt_id},
        )
        row = rows[0] if rows else None
        if row and row["connector_id"] == "google_drive":
            return await self.drive().complete(
                state=state, code=code, expected_user_id=expected_user_id
            )
        if not row or row.get("consumed_at") is not None:
            raise ExternalConnectorOAuthError("This connection attempt has already been used")
        if _clean(row["user_id"]) != _clean(expected_user_id):
            raise ExternalConnectorOAuthError("This connection attempt belongs to another user")
        if row["expires_at"] < _now():
            raise ExternalConnectorOAuthError("This connection attempt has expired")
        connector = await self._registry.get_connector(row["connector_id"])
        if connector is None:
            raise ExternalConnectorOAuthError("This connector is no longer available")
        client_id = _clean(os.getenv(connector.oauth_client_id_env or ""))
        client_secret = _clean(os.getenv(connector.oauth_client_secret_env or ""))
        verifier = self._credentials.decrypt_secret(
            ciphertext=row["code_verifier_ciphertext"],
            iv=row["code_verifier_iv"],
            aad=f"external-connector-oauth-attempt:{attempt_id}",
        )
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                connector.oauth_token_url,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": row["redirect_uri"],
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code_verifier": verifier,
                },
                headers={"Accept": "application/json"},
            )
        if response.status_code >= 400:
            raise ExternalConnectorOAuthError(
                f"{connector.display_name} rejected this authorization", status_code=502
            )
        token = response.json()
        access_token = _clean(token.get("access_token"))
        if not access_token:
            raise ExternalConnectorOAuthError(
                f"{connector.display_name} did not return an access token", status_code=502
            )
        await self._execute(
            """UPDATE external_connector_oauth_attempts
               SET consumed_at = :now
               WHERE attempt_id = :attempt_id""",
            {"attempt_id": attempt_id, "now": _now()},
        )
        secret: dict[str, Any] = {"accessToken": access_token}
        refresh_token = _clean(token.get("refresh_token"))
        if refresh_token:
            secret["refreshToken"] = refresh_token
        await self._credentials.store_credential(
            user_id=row["user_id"], connector_id=row["connector_id"], secret=secret
        )
        return {"status": "connected", "connectorId": row["connector_id"]}


_singleton: ExternalConnectorOAuthService | None = None


def get_external_connector_oauth_service() -> ExternalConnectorOAuthService:
    global _singleton
    if _singleton is None:
        _singleton = ExternalConnectorOAuthService()
    return _singleton
