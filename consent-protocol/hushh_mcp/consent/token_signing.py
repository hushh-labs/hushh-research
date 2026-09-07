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

SCOPE. This module owns the SIGNATURE FORMAT, not one key. Each subsystem that
uses it declares a :class:`SigningNamespace` naming its own env vars, and the
namespaces are deliberately disjoint: holding the consent-token signing key must
not let anyone sign anything else.

Two namespaces exist today. ``CONSENT_TOKENS`` is the original. ``CONSENT_AUDIT``
signs the tamper-evident audit chain, and it exists because that chain was signed
with ``APP_SIGNING_KEY`` -- the key that MINTS consent tokens. Under AU-10 that is
not non-repudiation, it is self-attestation: anyone who could verify the ledger
could also rewrite it, and the one party with the most reason to rewrite it held
the key. Separating the namespace is the whole point; reusing
``CONSENT_ED25519_PRIVATE_KEY`` for the audit chain would reproduce the defect
with a better algorithm.

The remaining ``APP_SIGNING_KEY`` subsystems (trust links, fabric grants, OAuth
state, developer pepper) stay HMAC at the hub -- a pod has no business verifying
them, and dragging them along is what would turn a two-week change into a rewrite
of the trust model.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

SIGNING_ALG_ENV = "CONSENT_TOKEN_SIGNING_ALG"
PRIVATE_KEY_ENV = "CONSENT_ED25519_PRIVATE_KEY"
KID_ENV = "CONSENT_ED25519_KID"
PUBLIC_KEYS_ENV = "CONSENT_ED25519_PUBLIC_KEYS"

ALG_HMAC = "hmac"
ALG_ED25519 = "ed25519"


@dataclass(frozen=True)
class SigningNamespace:
    """One subsystem's key material, named by its env vars.

    Frozen and hashable so the key caches can be keyed on it. Two namespaces
    sharing an env var would silently share a key, which is the exact failure
    this type exists to make impossible to write by accident.
    """

    alg_env: str
    private_key_env: str
    kid_env: str
    public_keys_env: str
    default_kid: str


CONSENT_TOKENS = SigningNamespace(
    alg_env=SIGNING_ALG_ENV,
    private_key_env=PRIVATE_KEY_ENV,
    kid_env=KID_ENV,
    public_keys_env=PUBLIC_KEYS_ENV,
    default_kid="hushh-consent-1",
)

#: The tamper-evident consent-audit chain. A DISTINCT key on purpose: signing the
#: ledger with the token-minting key means the party who can grant a permission
#: can also rewrite the record of having granted it.
CONSENT_AUDIT = SigningNamespace(
    alg_env="CONSENT_AUDIT_SIGNING_ALG",
    private_key_env="CONSENT_AUDIT_ED25519_PRIVATE_KEY",
    kid_env="CONSENT_AUDIT_ED25519_KID",
    public_keys_env="CONSENT_AUDIT_ED25519_PUBLIC_KEYS",
    default_kid="hushh-audit-1",
)

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


def signing_alg(namespace: SigningNamespace = CONSENT_TOKENS) -> str:
    """The ISSUANCE algorithm. Default HMAC -- flipping is an explicit act."""
    value = (os.getenv(namespace.alg_env) or "").strip().lower()
    return value if value in (ALG_HMAC, ALG_ED25519) else ALG_HMAC


@lru_cache(maxsize=8)
def _private_key(namespace: SigningNamespace = CONSENT_TOKENS):
    material = (os.getenv(namespace.private_key_env) or "").strip()
    if not material:
        return None
    raw = _decode_raw32(material)
    if raw is None:
        raise RuntimeError(f"{namespace.private_key_env} must be a base64 raw 32-byte Ed25519 seed")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    return Ed25519PrivateKey.from_private_bytes(raw)


@lru_cache(maxsize=8)
def _public_keys(namespace: SigningNamespace = CONSENT_TOKENS) -> dict[str, bytes]:
    """kid -> raw public key. From the env map, plus the private key's own pair.

    Deriving the issuer's verifying key from its signing key means the hub can
    verify what it issues without configuring itself twice.
    """
    keys: dict[str, bytes] = {}
    env_name = namespace.public_keys_env
    material = (os.getenv(env_name) or "").strip()
    if material:
        try:
            parsed = json.loads(material)
        except ValueError as exc:
            raise RuntimeError(f"{env_name} must be a JSON {{kid: base64}} map") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError(f"{env_name} must be a JSON {{kid: base64}} map")
        for kid, value in parsed.items():
            raw = _decode_raw32(str(value))
            if raw is None:
                raise RuntimeError(f"{env_name} entry {kid!r} is not a raw 32-byte key")
            keys[str(kid)] = raw

    private = _private_key(namespace)
    if private is not None:
        from cryptography.hazmat.primitives import serialization

        keys.setdefault(
            current_kid(namespace),
            private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
            ),
        )
    return keys


def current_kid(namespace: SigningNamespace = CONSENT_TOKENS) -> str:
    return (os.getenv(namespace.kid_env) or "").strip() or namespace.default_kid


def reset_caches() -> None:
    """Test hook: environment changed, drop the cached keys for every namespace."""
    _private_key.cache_clear()
    _public_keys.cache_clear()


def hmac_signature(payload: str, key: str) -> str:
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def sign_payload(
    payload: str, *, hmac_key: str, namespace: SigningNamespace = CONSENT_TOKENS
) -> str:
    """Sign per the configured issuance algorithm for this namespace."""
    if signing_alg(namespace) == ALG_ED25519:
        private = _private_key(namespace)
        if private is None:
            # Issuance was explicitly configured asymmetric and the key is
            # absent: refuse rather than silently minting forgeable tokens.
            raise RuntimeError(
                f"{namespace.alg_env}=ed25519 but {namespace.private_key_env} is not set -- "
                f"a verifier-only process (a pod) can never issue"
            )
        signature = private.sign(payload.encode("utf-8"))
        return f"{_TAG}{current_kid(namespace)}.{_b64url(signature)}"
    return hmac_signature(payload, hmac_key)


def verify_payload(
    payload: str,
    signature: str,
    *,
    hmac_key: str,
    namespace: SigningNamespace = CONSENT_TOKENS,
    require_asymmetric: bool = False,
) -> bool:
    """Verify either algorithm, fail-closed on everything unknown.

    A tagged signature with no matching public key is INVALID -- never a
    fall-through to HMAC, which would let a malformed tag downgrade the check.

    ``require_asymmetric`` closes the other half of that door. Accepting BOTH
    algorithms means a holder of the HMAC key can still forge a NEW row with an
    untagged signature and have it verify, which re-opens the very separation the
    asymmetric key was introduced to create. Any namespace that has finished its
    rollout should verify strictly.
    """
    if signature.startswith(_TAG):
        remainder = signature[len(_TAG) :]
        kid, _, encoded = remainder.partition(".")
        if not kid or not encoded:
            return False
        public_raw = _public_keys(namespace).get(kid)
        if public_raw is None:
            logger.warning("consent_signing.unknown_kid ns=%s kid=%s", namespace.kid_env, kid)
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
    if require_asymmetric:
        # An untagged signature under a strict namespace is a DOWNGRADE, not a
        # legacy row to be waved through.
        return False
    return hmac.compare_digest(signature, hmac_signature(payload, hmac_key))
