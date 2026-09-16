"""Owner-side export encryption for consent tests, lifted from the UAT smoke script.

``scripts/uat_kai_regression_smoke.py`` carries ``_encrypt_export_payload`` as a
method that never touches instance state. Tests that need to play the owner's
browser (encrypt a plaintext under a fresh export key, wrap that key to the
requester's X25519 connector key, and bind both to the v2 envelope) import
this module instead of instantiating the smoke harness.

The construction mirrors ``hushh-webapp/lib/services/one-kyc-client-zk-service.ts``
and is the exact inverse of
``hushh_mcp.consent.export_projection.decrypt_scoped_export_package``:

1. AES-256-GCM encrypt the JSON plaintext under a random export key, with the
   canonical AAD bytes as associated data.
2. X25519 ECDH between an ephemeral sender key and the connector public key;
   ``SHA256(shared_secret)`` is the wrapping key.
3. AES-256-GCM wrap the export key under the wrapping key, with the canonical
   envelope submission bytes as associated data.

Only the requester (the connector private key holder) can unwrap; the backend
stores ciphertext and the wrapped key and never sees the plaintext.

KEEP IN SYNC: ``encrypt_export_for_connector`` below and
``UatKaiRegressionSmoke._encrypt_export_payload`` in
``scripts/uat_kai_regression_smoke.py`` are the same construction, line for
line. The smoke script is a standalone operator tool that does not import
from ``tests``; a change to the envelope, the AAD, or the wrapping must be
applied to both, and ``test_uat_kai_regression_smoke.py`` plus the lifecycle
e2e test are the two decrypt round-trips that catch a drift.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.consent.export_envelope import (
    CONSENT_EXPORT_WRAPPING_ALGORITHM,
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    canonical_envelope_submission_bytes,
    digest_bytes,
)

_GCM_TAG_BYTES = 16


def _b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("utf-8")


def _b64decode(value: str) -> bytes:
    normalized = str(value or "").strip().replace("-", "+").replace("_", "/")
    while normalized and len(normalized) % 4 != 0:
        normalized += "="
    return base64.b64decode(normalized)


def generate_connector_key() -> tuple[X25519PrivateKey, str]:
    """A fresh requester-held connector key: (private key, raw public key base64)."""
    private_key = X25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return private_key, _b64encode(public_bytes)


def encrypt_export_for_connector(
    payload: dict[str, Any],
    *,
    connector_public_key_b64: str,
    connector_key_id: str,
    aad: ConsentExportAadV2 | None = None,
) -> dict[str, Any]:
    """Encrypt ``payload`` for the connector and return the approval body fields.

    The result carries the camelCase keys ``POST /api/consent/pending/approve``
    reads (``encryptedData``, ``wrappedExportKey``, ``exportEnvelope``, ...).
    When ``aad`` is given the package is a strict v2 envelope: ``version`` is 2
    and ``exportEnvelope`` binds the ciphertext digest and the AAD digest.
    """
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    export_key = os.urandom(32)
    export_iv = os.urandom(12)
    aad_bytes = canonical_aad_bytes(aad) if aad is not None else None
    export_ciphertext = AESGCM(export_key).encrypt(export_iv, plaintext, aad_bytes)
    ciphertext = export_ciphertext[:-_GCM_TAG_BYTES]

    envelope = None
    if aad is not None:
        envelope = ConsentExportEnvelopeSubmissionV2(
            export_id=aad.export_id,
            aad=aad,
            aad_sha256=digest_bytes(aad_bytes or b""),
            ciphertext_sha256=digest_bytes(ciphertext),
            ciphertext_bytes=len(ciphertext),
        )

    sender_private = X25519PrivateKey.generate()
    connector_public_key = X25519PublicKey.from_public_bytes(_b64decode(connector_public_key_b64))
    shared_secret = sender_private.exchange(connector_public_key)
    wrapping_digest = hashes.Hash(hashes.SHA256())
    wrapping_digest.update(shared_secret)
    wrapping_key = wrapping_digest.finalize()

    wrapped_iv = os.urandom(12)
    wrapping_aad = canonical_envelope_submission_bytes(envelope) if envelope is not None else None
    wrapped = AESGCM(wrapping_key).encrypt(wrapped_iv, export_key, wrapping_aad)
    sender_public_key = sender_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )

    package: dict[str, Any] = {
        "encryptedData": _b64encode(ciphertext),
        "encryptedIv": _b64encode(export_iv),
        "encryptedTag": _b64encode(export_ciphertext[-_GCM_TAG_BYTES:]),
        "wrappedExportKey": _b64encode(wrapped[:-_GCM_TAG_BYTES]),
        "wrappedKeyIv": _b64encode(wrapped_iv),
        "wrappedKeyTag": _b64encode(wrapped[-_GCM_TAG_BYTES:]),
        "senderPublicKey": _b64encode(sender_public_key),
        "wrappingAlg": CONSENT_EXPORT_WRAPPING_ALGORITHM,
        "connectorKeyId": connector_key_id,
    }
    if envelope is not None:
        package["version"] = 2
        package["exportEnvelope"] = envelope.model_dump(mode="json")
    return package


__all__ = ["encrypt_export_for_connector", "generate_connector_key"]
