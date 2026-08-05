"""Consent-token signatures: HMAC today, Ed25519 for the pod era — one slot, both.

THE PROBLEM THIS SOLVES. Consent tokens are HMAC-SHA256 under ``APP_SIGNING_KEY``.
Symmetric means verify == forge: a pod that could check a token could mint one
for every user, which is why no pod may ever hold the hub's key — and why a pod
today cannot enforce consent at its own door at all.

THE SHAPE OF THE FIX. The token's wire format is
``HCT:<b64url(payload)>.<signature>`` and every parser treats the signature slot
as opaque (``split(".", 1)``). So the slot itself becomes self-describing:

    HMAC (today):    64 hex chars, exactly as before
    Ed25519 (new):   ed25519.<kid>.<b64url(signature)>

* The payload stays BYTE-IDENTICAL — no new field, because ``validate_token``
  accepts exactly 5 parts (6 with ``commercial``) and a new field would break
  every deployed verifier at once.
* New verifiers dispatch on the ``ed25519.`` tag and accept both algorithms.
* OLD verifiers hit their HMAC compare, fail to match a tagged signature, and
  REJECT — fail-closed, which is the correct default and what makes the
  rollout safe: deploy verify-both everywhere first, flip issuance second.

WHO HOLDS WHAT. The control plane holds the Ed25519 PRIVATE key
(``CONSENT_ED25519_PRIVATE_KEY``) and signs. A pod holds only PUBLIC keys
(``CONSENT_ED25519_PUBLIC_KEYS``, a JSON ``{kid: b64_raw_32}`` map — public
material, safe in plain env) and verifies. Verification proves authenticity;
REVOCATION remains a control-plane lookup (``validate_token_with_db``), which
in a pod stays fail-closed until the revocation relay exists. Signature first,
currency second — this module only moves the first half out of the forgeable
regime.

SCOPE, deliberately narrow: this signs CONSENT TOKENS. The other seven
``APP_SIGNING_KEY`` subsystems (trust links, fabric grants, receipts, the audit
chain, OAuth state, developer pepper) stay HMAC at the hub — a pod has no
business verifying them, and dragging them along is what would turn a two-week
change into a rewrite of the trust model.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

SIGNING_ALG_ENV = "CONSENT_TOKEN_SIGNING_ALG"
PRIVATE_KEY_ENV = "CONSENT_ED25519_PRIVATE_KEY"
KID_ENV = "CONSENT_ED25519_KID"
PUBLIC_KEYS_ENV = "CONSENT_ED25519_PUBLIC_KEYS"

ALG_HMAC = "hmac"
ALG_ED25519 = "ed25519"

_TAG = "ed25519."


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _decode_raw32(material: str) -> Optional[bytes]:
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(material + "=" * (-len(material) % 4))
        except Exception:  # noqa: BLE001 - try the next encoding
            continue
        if len(raw) == 32:
            return raw
    return None


def signing_alg() -> str:
    """The ISSUANCE algorithm. Default HMAC — flipping is an explicit act."""
    value = (os.getenv(SIGNING_ALG_ENV) or "").strip().lower()
    return value if value in (ALG_HMAC, ALG_ED25519) else ALG_HMAC


@lru_cache(maxsize=1)
def _private_key():
    material = (os.getenv(PRIVATE_KEY_ENV) or "").strip()
    if not material:
        return None
    raw = _decode_raw32(material)
    if raw is None:
        raise RuntimeError(f"{PRIVATE_KEY_ENV} must be a base64 raw 32-byte Ed25519 seed")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    return Ed25519PrivateKey.from_private_bytes(raw)


@lru_cache(maxsize=1)
def _public_keys() -> dict[str, bytes]:
    """kid -> raw public key. From the env map, plus the private key's own pair.

    Deriving the issuer's verifying key from its signing key means the hub can
    verify what it issues without configuring itself twice.
    """
    keys: dict[str, bytes] = {}
    material = (os.getenv(PUBLIC_KEYS_ENV) or "").strip()
    if material:
        try:
            parsed = json.loads(material)
        except ValueError as exc:
            raise RuntimeError(f"{PUBLIC_KEYS_ENV} must be a JSON {{kid: base64}} map") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError(f"{PUBLIC_KEYS_ENV} must be a JSON {{kid: base64}} map")
        for kid, value in parsed.items():
            raw = _decode_raw32(str(value))
            if raw is None:
                raise RuntimeError(f"{PUBLIC_KEYS_ENV} entry {kid!r} is not a raw 32-byte key")
            keys[str(kid)] = raw

    private = _private_key()
    if private is not None:
        from cryptography.hazmat.primitives import serialization

        keys.setdefault(
            current_kid(),
            private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
            ),
        )
    return keys


def current_kid() -> str:
    return (os.getenv(KID_ENV) or "").strip() or "hushh-consent-1"


def reset_caches() -> None:
    """Test hook: environment changed, drop the cached keys."""
    _private_key.cache_clear()
    _public_keys.cache_clear()


def hmac_signature(payload: str, key: str) -> str:
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def sign_payload(payload: str, *, hmac_key: str) -> str:
    """Sign per the configured issuance algorithm."""
    if signing_alg() == ALG_ED25519:
        private = _private_key()
        if private is None:
            # Issuance was explicitly configured asymmetric and the key is
            # absent: refuse rather than silently minting forgeable tokens.
            raise RuntimeError(
                f"{SIGNING_ALG_ENV}=ed25519 but {PRIVATE_KEY_ENV} is not set -- "
                f"a verifier-only process (a pod) can never issue"
            )
        signature = private.sign(payload.encode("utf-8"))
        return f"{_TAG}{current_kid()}.{_b64url(signature)}"
    return hmac_signature(payload, hmac_key)


def verify_payload(payload: str, signature: str, *, hmac_key: str) -> bool:
    """Verify either algorithm, fail-closed on everything unknown.

    A tagged signature with no matching public key is INVALID — never a
    fall-through to HMAC, which would let a malformed tag downgrade the check.
    """
    if signature.startswith(_TAG):
        remainder = signature[len(_TAG) :]
        kid, _, encoded = remainder.partition(".")
        if not kid or not encoded:
            return False
        public_raw = _public_keys().get(kid)
        if public_raw is None:
            logger.warning("consent_token.unknown_signing_kid kid=%s", kid)
            return False
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        try:
            Ed25519PublicKey.from_public_bytes(public_raw).verify(
                _b64url_decode(encoded), payload.encode("utf-8")
            )
            return True
        except (InvalidSignature, ValueError):
            return False
    return hmac.compare_digest(signature, hmac_signature(payload, hmac_key))
