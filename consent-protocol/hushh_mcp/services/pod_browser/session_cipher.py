"""Browser-purpose encryption and opaque site identity under existing custody."""

from __future__ import annotations

import json
import secrets

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .consent import private_commitment
from .contracts import BrowserRefused
from .origin import public_origin


class BrowserSessionCipher:
    def __init__(self, owner: str, custody_key: bytes) -> None:
        if not owner or len(custody_key) != 32:
            raise BrowserRefused("BROWSER_SESSION_KEY_UNAVAILABLE")
        self._owner = owner
        self._key = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None, info=b"hussh/browser-session/v1"
        ).derive(custody_key)

    def site_id(self, origin: str, account: str) -> str:
        if public_origin(origin) != origin or not account or len(account) > 128:
            raise BrowserRefused("BROWSER_SESSION_SITE_INVALID")
        return private_commitment(self._key, [self._owner, origin, account])

    def _aad(self, site: str, generation: int, key: str) -> bytes:
        return json.dumps(
            ["browser-session/v1", self._owner, site, generation, key], separators=(",", ":")
        ).encode()

    def seal(self, raw: bytes, site: str, generation: int, key: str) -> bytes:
        nonce = secrets.token_bytes(12)
        return nonce + AESGCM(self._key).encrypt(nonce, raw, self._aad(site, generation, key))

    def open(self, raw: bytes, site: str, generation: int, key: str) -> bytes:
        return AESGCM(self._key).decrypt(raw[:12], raw[12:], self._aad(site, generation, key))
