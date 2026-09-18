"""Per-user encrypted credential storage for external MCP connectors.

Separate trust domain from both `google_connection_service.py` (Google-specific
OAuth) and the operator-level `enterprise_crm_registry` secret scheme
(`runtime_settings.get_connector_secrets_key()`, one shared key for the whole
deployment). A connector credential here is a *personal* secret -- the user's
own Notion/HubSpot/etc. access -- so the ciphertext is AES-256-GCM encrypted
with AAD bound to (user_id, connector_id), mirroring
`google_connection_service.py`'s `f"google-connection:{user_id}"` pattern
rather than reusing either of those.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
from datetime import UTC, datetime
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.db_client import get_db


class ExternalConnectorCredentialError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(UTC)


def _clean(value: object | None) -> str:
    return str(value or "").strip()


def _aad(user_id: str, connector_id: str) -> str:
    return f"external-connector:{user_id}:{connector_id}"


class ExternalConnectorCredentialsService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    def _token_key(self) -> bytes:
        raw = _clean(os.getenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY"))
        if not raw:
            raise ExternalConnectorCredentialError(
                "External connector credential storage is not configured", status_code=503
            )
        try:
            decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            if len(decoded) in {16, 24, 32}:
                return decoded
        except Exception:
            pass
        encoded = raw.encode()
        if len(encoded) in {16, 24, 32}:
            return encoded
        raise ExternalConnectorCredentialError(
            "External connector credential key is invalid", status_code=503
        )

    def encrypt_secret(self, value: str, *, aad: str) -> dict[str, str]:
        """Public so `external_connector_oauth_service.py` can encrypt a PKCE
        verifier under this same key/trust domain without a second key to
        manage -- an OAuth attempt's verifier is exactly as sensitive as a
        stored connector credential."""
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._token_key()).encrypt(nonce, value.encode(), aad.encode())
        return {
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode(),
            "iv": base64.urlsafe_b64encode(nonce).decode(),
            "algorithm": "aes-256-gcm-aad-v1",
        }

    def decrypt_secret(self, *, ciphertext: str, iv: str, aad: str) -> str:
        try:
            nonce = base64.urlsafe_b64decode(_clean(iv))
            blob = base64.urlsafe_b64decode(_clean(ciphertext))
            return AESGCM(self._token_key()).decrypt(nonce, blob, aad.encode()).decode()
        except Exception as exc:
            raise ExternalConnectorCredentialError(
                "Connector credential needs reauthorization", status_code=401
            ) from exc

    async def _execute(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(self.db.execute_raw, sql, params)
        return result.data or []

    async def store_credential(
        self,
        *,
        user_id: str,
        connector_id: str,
        secret: dict[str, Any],
        account_label: str | None = None,
    ) -> dict[str, Any]:
        """Encrypt an arbitrary connector secret (an API key, or an OAuth
        token envelope) and mark the connection active. `secret` is
        JSON-serialized before encryption so both auth styles share one
        storage shape."""

        user_id = _clean(user_id)
        connector_id = _clean(connector_id)
        if not user_id or not connector_id:
            raise ExternalConnectorCredentialError("user_id and connector_id are required")
        envelope = self.encrypt_secret(json.dumps(secret), aad=_aad(user_id, connector_id))
        now = _now()
        await self._execute(
            """INSERT INTO user_external_connector_connections (
                 user_id, connector_id, status,
                 credential_ciphertext, credential_iv, credential_algorithm,
                 connected_account_label, connected_at, revoked_at, last_error_code,
                 created_at, updated_at
               ) VALUES (
                 :user_id, :connector_id, 'connected',
                 :ciphertext, :iv, :algorithm,
                 :account_label, :now, NULL, NULL,
                 :now, :now
               ) ON CONFLICT (user_id, connector_id) DO UPDATE SET
                 status = 'connected',
                 credential_ciphertext = EXCLUDED.credential_ciphertext,
                 credential_iv = EXCLUDED.credential_iv,
                 credential_algorithm = EXCLUDED.credential_algorithm,
                 connected_account_label = EXCLUDED.connected_account_label,
                 connected_at = EXCLUDED.connected_at,
                 revoked_at = NULL,
                 last_error_code = NULL,
                 updated_at = EXCLUDED.updated_at""",
            {
                "user_id": user_id,
                "connector_id": connector_id,
                "ciphertext": envelope["ciphertext"],
                "iv": envelope["iv"],
                "algorithm": envelope["algorithm"],
                "account_label": _clean(account_label) or None,
                "now": now,
            },
        )
        return {"status": "connected", "connectorId": connector_id, "connectedAt": now.isoformat()}

    async def get_credential(self, *, user_id: str, connector_id: str) -> dict[str, Any] | None:
        """Decrypt and return the stored secret for an active connection, or
        None if never connected/revoked. Raises on tamper/reauth-needed."""

        user_id = _clean(user_id)
        connector_id = _clean(connector_id)
        rows = await self._execute(
            """SELECT credential_ciphertext, credential_iv, status
               FROM user_external_connector_connections
               WHERE user_id = :user_id AND connector_id = :connector_id""",
            {"user_id": user_id, "connector_id": connector_id},
        )
        row = rows[0] if rows else None
        if not row or row.get("status") != "connected" or not row.get("credential_ciphertext"):
            return None
        secret_json = self.decrypt_secret(
            ciphertext=row["credential_ciphertext"],
            iv=row["credential_iv"],
            aad=_aad(user_id, connector_id),
        )
        return json.loads(secret_json)

    async def status(self, *, user_id: str, connector_id: str) -> dict[str, Any]:
        user_id = _clean(user_id)
        connector_id = _clean(connector_id)
        rows = await self._execute(
            """SELECT status, connected_account_label, connected_at, last_error_code
               FROM user_external_connector_connections
               WHERE user_id = :user_id AND connector_id = :connector_id""",
            {"user_id": user_id, "connector_id": connector_id},
        )
        row = rows[0] if rows else None
        if not row:
            return {"connectorId": connector_id, "status": "not_connected"}
        return {
            "connectorId": connector_id,
            "status": row["status"],
            "accountLabel": row.get("connected_account_label"),
            "connectedAt": row.get("connected_at"),
            "lastErrorCode": row.get("last_error_code"),
        }

    async def list_statuses(self, *, user_id: str) -> list[dict[str, Any]]:
        user_id = _clean(user_id)
        rows = await self._execute(
            """SELECT connector_id, status, connected_account_label, connected_at, last_error_code
               FROM user_external_connector_connections
               WHERE user_id = :user_id""",
            {"user_id": user_id},
        )
        return [
            {
                "connectorId": row["connector_id"],
                "status": row["status"],
                "accountLabel": row.get("connected_account_label"),
                "connectedAt": row.get("connected_at"),
                "lastErrorCode": row.get("last_error_code"),
            }
            for row in rows
        ]

    async def disconnect(self, *, user_id: str, connector_id: str) -> dict[str, Any]:
        user_id = _clean(user_id)
        connector_id = _clean(connector_id)
        now = _now()
        await self._execute(
            """UPDATE user_external_connector_connections
               SET status = 'revoked',
                   credential_ciphertext = NULL,
                   credential_iv = NULL,
                   credential_algorithm = NULL,
                   revoked_at = :now,
                   updated_at = :now
               WHERE user_id = :user_id AND connector_id = :connector_id""",
            {"user_id": user_id, "connector_id": connector_id, "now": now},
        )
        return {"status": "revoked", "connectorId": connector_id}


_singleton: ExternalConnectorCredentialsService | None = None


def get_external_connector_credentials_service() -> ExternalConnectorCredentialsService:
    global _singleton
    if _singleton is None:
        _singleton = ExternalConnectorCredentialsService()
    return _singleton
