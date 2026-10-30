"""Purpose-separated sealing for small Calendar email follow-up records."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


class FollowupCryptoError(RuntimeError):
    pass


class FollowupCipher:
    """One server-held key, separately derived encryption and identity uses."""

    def __init__(self, encoded_key: str | None = None) -> None:
        raw = (
            encoded_key
            if encoded_key is not None
            else os.environ.get("CALENDAR_EMAIL_FOLLOWUP_KEY", "")
        )
        try:
            master = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        except (ValueError, binascii.Error) as exc:
            raise FollowupCryptoError("followup_key_unavailable") from exc
        if len(master) != 32:
            raise FollowupCryptoError("followup_key_unavailable")
        self._seal_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"calendar-email-followup/seal/v1",
        ).derive(master)
        self._identity_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"calendar-email-followup/identity/v1",
        ).derive(master)

    def _aad(self, owner: str, account_id: str, row: str, purpose: str) -> bytes:
        return json.dumps(
            ["calendar-email-followup/v1", owner, account_id, row, purpose],
            separators=(",", ":"),
        ).encode()

    def seal(self, value: Any, *, owner: str, account_id: str, row: str, purpose: str) -> str:
        nonce = secrets.token_bytes(12)
        content = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        encrypted = AESGCM(self._seal_key).encrypt(
            nonce, content, self._aad(owner, account_id, row, purpose)
        )
        return base64.urlsafe_b64encode(nonce + encrypted).decode().rstrip("=")

    def open(self, value: str, *, owner: str, account_id: str, row: str, purpose: str) -> Any:
        try:
            raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            plaintext = AESGCM(self._seal_key).decrypt(
                raw[:12], raw[12:], self._aad(owner, account_id, row, purpose)
            )
            return json.loads(plaintext)
        except Exception as exc:
            raise FollowupCryptoError("followup_record_unavailable") from exc

    def digest(self, owner: str, account_id: str, purpose: str, value: str) -> str:
        scope = json.dumps([owner, account_id, purpose, value], separators=(",", ":"))
        return hmac.new(self._identity_key, scope.encode(), hashlib.sha256).hexdigest()

    def evidence_key(self, owner: str, account_id: str) -> bytes:
        return hmac.new(
            self._identity_key, f"evidence:{owner}:{account_id}".encode(), hashlib.sha256
        ).digest()
