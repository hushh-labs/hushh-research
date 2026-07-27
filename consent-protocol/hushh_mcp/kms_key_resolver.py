"""KMS envelope-decryption for core key material (NIST 800-53 SC-12 / SC-13 / SC-28).

The signing / vault data-encryption keys (DEKs) are used in memory on the hot path
exactly as before; this module changes only HOW a DEK is *resolved at startup*.
When KMS key resolution is on, the DEK is stored only as **KMS-wrapped ciphertext**
(never plaintext at rest) and unwrapped once via a key-encryption-key (KEK) that
lives in Cloud KMS -- HSM-backed and FIPS 140-validated at the platform. KEK
rotation is managed by KMS and is transparent: the same DEK is re-wrapped, so
existing HMAC signatures and vault ciphertext stay valid (no DEK rotation, which
would need version-aware verification -- a documented follow-up).

Design: ``resolve_key`` is pure and injectable -- it takes the already-read env
values plus an optional ``decryptor``, so it is unit-testable with a fake and has
NO dependency on the settings module (no import cycle). The default decryptor
lazy-imports ``google-cloud-kms`` only when actually invoked, so the dependency is
required only at enablement, never for an ordinary process.
"""

from __future__ import annotations

import base64
import logging
from typing import Callable

logger = logging.getLogger(__name__)


def default_kms_decryptor(*, ciphertext: bytes, key_name: str) -> bytes:
    """Decrypt ``ciphertext`` with the Cloud KMS key ``key_name``.

    Lazy-imports ``google-cloud-kms`` so the dependency is only needed when KMS
    key resolution is actually enabled and configured.
    """
    import google.cloud.kms as kms  # lazy: only required at enablement

    client = kms.KeyManagementServiceClient()
    response = client.decrypt(request={"name": key_name, "ciphertext": ciphertext})
    return bytes(response.plaintext)


def resolve_key(
    *,
    label: str,
    plaintext: str,
    wrapped_b64: str,
    kek_resource: str,
    enabled: bool,
    strict: bool,
    decryptor: Callable[..., bytes] | None = None,
) -> str:
    """Return the plaintext DEK, unwrapping via KMS when enabled.

    OFF (default) -> returns ``plaintext`` verbatim (today's behavior, byte-for-byte).
    ON -> base64-decode ``wrapped_b64`` and KMS-decrypt it under ``kek_resource``.

    Failure handling is governed by ``strict``: when enabled but unconfigured, or
    when unwrap fails, ``strict`` raises (fail-closed, for production) while the
    default falls back to ``plaintext`` with a warning (fail-safe, for dev
    enablement). In production the plaintext env is typically empty, so a fail-safe
    fallback still surfaces downstream as a key-length validation error rather than
    silently running on a bad key.
    """
    if not enabled:
        return plaintext

    if not wrapped_b64 or not kek_resource:
        msg = f"KMS key resolution enabled for {label} but ciphertext/KEK is not configured"
        if strict:
            raise RuntimeError(msg)
        logger.warning("%s; falling back to plaintext env", msg)
        return plaintext

    try:
        ciphertext = base64.b64decode(wrapped_b64, validate=True)
        decrypt = decryptor or default_kms_decryptor
        resolved = decrypt(ciphertext=ciphertext, key_name=kek_resource).decode("utf-8").strip()
        if not resolved:
            raise ValueError("KMS returned empty plaintext")
        return resolved
    except Exception as exc:  # noqa: BLE001 -- surface as fail-closed or fail-safe per `strict`
        if strict:
            raise RuntimeError(f"KMS unwrap failed for {label}: {exc}") from exc
        logger.warning(
            "KMS unwrap failed for %s (%s); falling back to plaintext env", label, exc
        )
        return plaintext
