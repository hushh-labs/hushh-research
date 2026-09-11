"""Shared key-unwrapping primitive for existing browser X25519 envelopes.

This is cryptography, not authorization: callers must verify the recipient,
owner and purpose before calling it. Keys exist only in process memory here.
"""

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def unwrap_x25519_aes256_key(
    *,
    recipient_private_key: X25519PrivateKey,
    sender_public_key: bytes,
    wrapped_key: bytes,
    nonce: bytes,
    tag: bytes,
    additional_data: bytes | None,
) -> bytes:
    """Match wrapExportKeyForConnector without assuming an export's purpose.

    None AAD supports the existing legacy export contract only. New ceremonies
    must provide authenticated purpose/owner/deployment metadata.
    """
    if len(sender_public_key) != 32 or len(wrapped_key) != 32 or len(nonce) != 12 or len(tag) != 16:
        raise ValueError("invalid_wrapped_key_shape")
    shared = recipient_private_key.exchange(X25519PublicKey.from_public_bytes(sender_public_key))
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared)
    key = AESGCM(digest.finalize()).decrypt(nonce, wrapped_key + tag, additional_data)
    if len(key) != 32:
        raise ValueError("invalid_unwrapped_key_length")
    return key
