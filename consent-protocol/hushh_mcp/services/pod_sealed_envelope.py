"""One sealed envelope, from the owner's device to their own agent, for any purpose.

The device seals a small JSON plaintext to THIS pod's X25519 public key (the
``pod_public_key`` in the hub-signed binding the device already holds), so the hub
that carries the request can read none of it. Only the pod's private half, which
never leaves the pod process (``pod_self_registration``), can open it.

Envelope, version 1::

    {"v": 1, "alg": "X25519-HKDF-SHA256-AES256GCM",
     "epk": b64url(32-byte ephemeral X25519 public key), "iv": b64url(12 bytes),
     "ct": b64url(AES-256-GCM ciphertext || 16-byte tag),
     "aad": {"purpose", "hushhId", "podKeyId", "issuedAtMs", ...purpose fields}}

* key = HKDF-SHA256(ikm = X25519(shared), salt = epk || pod public key,
  info = the purpose's own label, 32 bytes);
* AAD bytes = the canonical JSON of ``aad`` (sorted keys, no whitespace);
* plaintext = canonical JSON of the purpose's fields.

A ``SealPurpose`` names the label, the exact AAD keys and the refusal type, so two
purposes never open each other's envelopes: the HKDF label differs, so the key does,
so AES-GCM fails before any field is read. Base64url is unpadded and canonical; a
non-canonical spelling is refused rather than normalised, so one envelope has exactly
one byte form.

Every refusal is a typed code and nothing else. A refusal never carries the plaintext,
the key, or why AES-GCM failed, because each of those is either the secret itself or
an oracle about it.
"""

from __future__ import annotations

import base64
import json
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.pod_session_authority import canonical_json

ENVELOPE_VERSION = 1
ENVELOPE_ALG = "X25519-HKDF-SHA256-AES256GCM"
BAD_ENVELOPE = "BAD_ENVELOPE"
#: How far ``issuedAtMs`` may sit from the pod's clock, either way.
MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

_ENVELOPE_KEYS = frozenset({"v", "alg", "epk", "iv", "ct", "aad"})
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_KEY_BYTES = 32
_IV_BYTES = 12
_TAG_BYTES = 16


class SealRefused(ValueError):
    """An envelope this pod will not accept. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SealPurpose:
    """What one kind of envelope is for, and how it refuses."""

    name: str
    hkdf_info: bytes
    aad_keys: frozenset[str]
    refusal: type[SealRefused] = SealRefused
    max_ciphertext_bytes: int = 4096

    def refuse(self, code: str) -> SealRefused:
        return self.refusal(code)


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(
    text: Any, *, length: Optional[int] = None, refusal: type[SealRefused] = SealRefused
) -> bytes:
    """Strict, canonical, unpadded base64url; anything else is a bad envelope."""
    if not isinstance(text, str) or not _B64URL_RE.fullmatch(text) or len(text) % 4 == 1:
        raise refusal(BAD_ENVELOPE)
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64url_encode(raw) != text or (length is not None and len(raw) != length):
        raise refusal(BAD_ENVELOPE)
    return raw


def raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def derive_key(shared: bytes, epk_raw: bytes, pod_public_raw: bytes, *, info: bytes) -> bytes:
    """The AES-256 key: HKDF-SHA256 over the X25519 secret, salted by both public keys."""
    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_BYTES, salt=epk_raw + pod_public_raw, info=info
    ).derive(shared)


def aad_bytes(aad: Mapping[str, Any]) -> bytes:
    return canonical_json(aad).encode("utf-8")


def seal(
    plaintext: Mapping[str, Any],
    *,
    purpose: SealPurpose,
    pod_public_key_raw: bytes,
    aad: Mapping[str, Any],
    ephemeral_private_key_raw: Optional[bytes] = None,
    iv: Optional[bytes] = None,
) -> dict[str, Any]:
    """The device's half, kept here for the golden vectors and the tests.

    ``ephemeral_private_key_raw`` and ``iv`` exist only so a vector is reproducible;
    a real seal draws both fresh, and reusing either with the same pod key breaks the
    scheme.
    """
    ephemeral = (
        X25519PrivateKey.from_private_bytes(ephemeral_private_key_raw)
        if ephemeral_private_key_raw is not None
        else X25519PrivateKey.generate()
    )
    nonce = iv if iv is not None else secrets.token_bytes(_IV_BYTES)
    epk_raw = raw_public(ephemeral.public_key())
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(pod_public_key_raw))
    key = derive_key(shared, epk_raw, pod_public_key_raw, info=purpose.hkdf_info)
    body = canonical_json(plaintext).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, body, aad_bytes(aad))
    return {
        "v": ENVELOPE_VERSION,
        "alg": ENVELOPE_ALG,
        "epk": b64url_encode(epk_raw),
        "iv": b64url_encode(nonce),
        "ct": b64url_encode(ciphertext),
        "aad": dict(aad),
    }


def parse_envelope(
    envelope: Any, *, purpose: SealPurpose
) -> tuple[bytes, bytes, bytes, dict[str, Any]]:
    """(epk, iv, ct, aad) of a structurally exact envelope, before any decryption."""
    refusal = purpose.refusal
    if not isinstance(envelope, Mapping) or set(envelope) != _ENVELOPE_KEYS:
        raise refusal(BAD_ENVELOPE)
    version = envelope.get("v")
    if type(version) is not int or version != ENVELOPE_VERSION:
        raise refusal(BAD_ENVELOPE)
    if envelope.get("alg") != ENVELOPE_ALG:
        raise refusal(BAD_ENVELOPE)
    aad = envelope.get("aad")
    if not isinstance(aad, Mapping) or set(aad) != purpose.aad_keys:
        raise refusal(BAD_ENVELOPE)
    epk = b64url_decode(envelope.get("epk"), length=_KEY_BYTES, refusal=refusal)
    iv = b64url_decode(envelope.get("iv"), length=_IV_BYTES, refusal=refusal)
    ct = b64url_decode(envelope.get("ct"), refusal=refusal)
    if not _TAG_BYTES < len(ct) <= purpose.max_ciphertext_bytes:
        raise refusal(BAD_ENVELOPE)
    return epk, iv, ct, dict(aad)


def decrypt(
    private_key: X25519PrivateKey,
    epk: bytes,
    iv: bytes,
    ct: bytes,
    aad: Mapping[str, Any],
    *,
    purpose: SealPurpose,
) -> bytes:
    try:
        shared = private_key.exchange(X25519PublicKey.from_public_bytes(epk))
        key = derive_key(shared, epk, raw_public(private_key.public_key()), info=purpose.hkdf_info)
        return AESGCM(key).decrypt(iv, ct, aad_bytes(aad))
    except Exception:  # noqa: BLE001 - one code for every failure: no oracle
        raise purpose.refuse(BAD_ENVELOPE) from None


def open_envelope(
    envelope: Any, *, purpose: SealPurpose, pod_private_key: X25519PrivateKey
) -> tuple[bytes, dict[str, Any]]:
    """(plaintext bytes, authenticated aad). Nothing in either is checked yet."""
    epk, iv, ct, aad = parse_envelope(envelope, purpose=purpose)
    return decrypt(pod_private_key, epk, iv, ct, aad, purpose=purpose), aad


def check_binding(
    aad: Mapping[str, Any], *, purpose: SealPurpose, hushh_id: str, pod_key_id: str
) -> None:
    """The envelope is for this purpose, this owner and this pod key."""
    if aad.get("purpose") != purpose.name:
        raise purpose.refuse(BAD_ENVELOPE)
    if not hushh_id or aad.get("hushhId") != hushh_id:
        raise purpose.refuse(BAD_ENVELOPE)
    if not pod_key_id or aad.get("podKeyId") != pod_key_id:
        raise purpose.refuse(BAD_ENVELOPE)


def check_uuid4(value: Any, *, purpose: SealPurpose) -> str:
    """A canonical lowercase version-4 UUID, or a bad envelope."""
    try:
        parsed = uuid.UUID(str(value))
    except ValueError:
        raise purpose.refuse(BAD_ENVELOPE) from None
    if not isinstance(value, str) or parsed.version != 4 or str(parsed) != value:
        raise purpose.refuse(BAD_ENVELOPE)
    return value


def check_issued(
    aad: Mapping[str, Any], *, purpose: SealPurpose, now_ms: int, floor_ms: int, stale_code: str
) -> int:
    issued = aad.get("issuedAtMs")
    if type(issued) is not int:
        raise purpose.refuse(BAD_ENVELOPE)
    if abs(now_ms - issued) > MAX_CLOCK_SKEW_MS or issued <= floor_ms:
        # Too old, from the future, or not newer than what this agent already holds:
        # a replay or a rollback, never a fresh choice.
        raise purpose.refuse(stale_code)
    return issued


def parse_json_object(raw: bytes, *, purpose: SealPurpose) -> dict[str, Any]:
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise purpose.refuse(BAD_ENVELOPE) from None
    if not isinstance(body, dict):
        raise purpose.refuse(BAD_ENVELOPE)
    return body


__all__ = [
    "BAD_ENVELOPE",
    "ENVELOPE_ALG",
    "ENVELOPE_VERSION",
    "MAX_CLOCK_SKEW_MS",
    "SealPurpose",
    "SealRefused",
    "aad_bytes",
    "b64url_decode",
    "b64url_encode",
    "check_binding",
    "check_issued",
    "check_uuid4",
    "decrypt",
    "derive_key",
    "open_envelope",
    "parse_envelope",
    "parse_json_object",
    "raw_public",
    "seal",
]
