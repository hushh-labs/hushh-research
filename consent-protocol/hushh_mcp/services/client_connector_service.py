"""Owner-held public connector registry shared by consented information flows."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any

from db.db_client import get_db

_WRAPPING_ALGORITHM = "X25519-AES256-GCM"


class ClientConnectorError(RuntimeError):
    def __init__(self, message: str, *, code: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _text(value: Any) -> str:
    return str(value or "").strip()


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else (_text(value) or None)


def _connector_key_id(value: str | None) -> str:
    key_id = _text(value)
    if not key_id:
        raise ClientConnectorError(
            "Client connector key id is required.", code="CLIENT_CONNECTOR_KEY_ID_REQUIRED"
        )
    if not re.fullmatch(r"[A-Za-z0-9._:-]{3,120}", key_id):
        raise ClientConnectorError(
            "Client connector key id contains unsupported characters.",
            code="CLIENT_CONNECTOR_KEY_ID_INVALID",
        )
    return key_id


def _public_key(value: str | None) -> str:
    key = _text(value)
    if len(key) < 32:
        raise ClientConnectorError(
            "Client connector public key is required.", code="CLIENT_CONNECTOR_PUBLIC_KEY_REQUIRED"
        )
    return key


def _wrapping_algorithm(value: str | None) -> str:
    algorithm = _text(value) or _WRAPPING_ALGORITHM
    if algorithm != _WRAPPING_ALGORITHM:
        raise ClientConnectorError(
            "Client connector uses an unsupported wrapping algorithm.",
            code="CLIENT_CONNECTOR_WRAPPING_UNSUPPORTED",
        )
    return algorithm


class ClientConnectorService:
    """Stores public keys only; private keys remain in the owner's unlocked vault."""

    def __init__(self, *, db: Any | None = None) -> None:
        self._db = db

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    @staticmethod
    def _public(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "user_id": row.get("user_id"),
            "connector_key_id": row.get("connector_key_id"),
            "connector_public_key": row.get("connector_public_key"),
            "connector_wrapping_alg": row.get("connector_wrapping_alg") or _WRAPPING_ALGORITHM,
            "public_key_fingerprint": row.get("public_key_fingerprint"),
            "status": row.get("status"),
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at")),
            "rotated_at": _iso(row.get("rotated_at")),
            "revoked_at": _iso(row.get("revoked_at")),
        }

    async def get(self, *, user_id: str) -> dict[str, Any]:
        user = _text(user_id)
        rows = (
            self.db.execute_raw(
                """SELECT * FROM one_kyc_client_connectors
               WHERE user_id = :user_id AND status = 'active'
               ORDER BY updated_at DESC LIMIT 1""",
                {"user_id": user},
            ).data
            or []
        )
        connector = self._public(dict(rows[0])) if rows else None
        return {"configured": connector is not None, "connector": connector}

    async def register(
        self,
        *,
        user_id: str,
        connector_public_key: str,
        connector_key_id: str,
        connector_wrapping_alg: str = _WRAPPING_ALGORITHM,
        public_key_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        user = _text(user_id)
        if not user:
            raise ClientConnectorError(
                "Client connector user id is required.", code="CLIENT_CONNECTOR_USER_REQUIRED"
            )
        key = _public_key(connector_public_key)
        key_id = _connector_key_id(connector_key_id)
        algorithm = _wrapping_algorithm(connector_wrapping_alg)
        fingerprint = (
            _text(public_key_fingerprint) or hashlib.sha256(key.encode("utf-8")).hexdigest()
        )
        self.db.execute_raw(
            """UPDATE one_kyc_client_connectors SET status = 'rotated', rotated_at = NOW(), updated_at = NOW()
               WHERE user_id = :user_id AND connector_key_id <> :connector_key_id AND status = 'active'""",
            {"user_id": user, "connector_key_id": key_id},
        )
        rows = (
            self.db.execute_raw(
                """INSERT INTO one_kyc_client_connectors (
                   user_id, connector_key_id, connector_public_key, connector_wrapping_alg,
                   public_key_fingerprint, status, updated_at
               ) VALUES (:user_id, :connector_key_id, :connector_public_key, :connector_wrapping_alg,
                         :public_key_fingerprint, 'active', NOW())
               ON CONFLICT (user_id, connector_key_id) DO UPDATE SET
                   connector_public_key = EXCLUDED.connector_public_key,
                   connector_wrapping_alg = EXCLUDED.connector_wrapping_alg,
                   public_key_fingerprint = EXCLUDED.public_key_fingerprint,
                   status = 'active', revoked_at = NULL, updated_at = NOW()
               RETURNING *""",
                {
                    "user_id": user,
                    "connector_key_id": key_id,
                    "connector_public_key": key,
                    "connector_wrapping_alg": algorithm,
                    "public_key_fingerprint": fingerprint,
                },
            ).data
            or []
        )
        connector = self._public(dict(rows[0])) if rows else None
        return {"configured": connector is not None, "connector": connector}


_service: ClientConnectorService | None = None


def get_client_connector_service() -> ClientConnectorService:
    global _service
    if _service is None:
        _service = ClientConnectorService()
    return _service
