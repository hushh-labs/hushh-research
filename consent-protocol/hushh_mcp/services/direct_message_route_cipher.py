"""Opaque navigation selections; participant authorization remains independent."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.direct_messages_service import DirectMessageCipher, DirectMessagesError


class DirectMessageRouteCipher:
    @staticmethod
    def _key() -> bytes:
        # A purpose-specific key keeps navigation and stored message envelopes separate.
        return hashlib.sha256(
            b"hussh-direct-message-route-v1\0" + DirectMessageCipher._key()
        ).digest()

    @staticmethod
    def _aad(viewer: str) -> bytes:
        return json.dumps(["direct-message-route-v1", viewer], separators=(",", ":")).encode()

    def seal(self, viewer: str, kind: str, ref: str) -> str:
        if kind not in {"conversation", "person"} or not ref or len(ref) > 64:
            raise ValueError("Invalid selection")
        nonce = secrets.token_bytes(12)
        body = json.dumps([kind, ref], separators=(",", ":")).encode()
        encrypted = AESGCM(self._key()).encrypt(nonce, body, self._aad(viewer))
        return "dm1." + base64.urlsafe_b64encode(nonce + encrypted).decode().rstrip("=")

    def open(self, viewer: str, token: str) -> tuple[str, str]:
        key = self._key()
        try:
            if not token.startswith("dm1.") or len(token) > 512:
                raise ValueError("Invalid token")
            encoded = token[4:]
            raw = base64.b64decode(
                encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
            )
            body = AESGCM(key).decrypt(raw[:12], raw[12:], self._aad(viewer))
            kind, ref = json.loads(body)
            if (
                kind not in {"conversation", "person"}
                or not isinstance(ref, str)
                or not ref
                or len(ref) > 64
            ):
                raise ValueError("Invalid selection")
            return kind, ref
        except Exception as exc:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_ROUTE_INVALID",
                "This conversation link is unavailable.",
                status_code=400,
            ) from exc
