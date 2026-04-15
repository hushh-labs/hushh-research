# hushh_mcp/vault/encrypt.py

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from hushh_mcp.types import EncryptedPayload

# ==================== Constants ====================

IV_LENGTH = 12  # GCM recommended IV size
TAG_LENGTH = 16
ALGORITHM_NAME = "aes-256-gcm"

# ==================== Encrypt ====================


def _validate_key_hex(key_hex: str) -> bytes:
    """Validate and convert a hex-encoded AES-256 key to bytes.

    Raises ValueError if the key is not a valid 64-character hex string (256-bit).
    """
    if not isinstance(key_hex, str):
        raise ValueError("Vault key must be a hex string")
    cleaned = key_hex.strip()
    if len(cleaned) != 64:
        raise ValueError(
            f"Vault key must be exactly 64 hex characters (256-bit), got {len(cleaned)}"
        )
    try:
        return bytes.fromhex(cleaned)
    except ValueError:
        raise ValueError("Vault key contains invalid hex characters")


def encrypt_data(plaintext: str, key_hex: str) -> EncryptedPayload:
    try:
        key = _validate_key_hex(key_hex)
        iv = os.urandom(IV_LENGTH)
        backend = default_backend()

        cipher = Cipher(algorithms.AES(key), modes.GCM(iv), backend=backend)
        encryptor = cipher.encryptor()

        ciphertext = encryptor.update(plaintext.encode("utf-8")) + encryptor.finalize()
        tag = encryptor.tag

        return EncryptedPayload(
            ciphertext=base64.b64encode(ciphertext).decode("utf-8"),
            iv=base64.b64encode(iv).decode("utf-8"),
            tag=base64.b64encode(tag).decode("utf-8"),
            encoding="base64",
            algorithm=ALGORITHM_NAME,
        )
    except Exception as e:
        raise RuntimeError(f"Encryption failed: {str(e)}")


# ==================== Decrypt ====================


def decrypt_data(payload: EncryptedPayload, key_hex: str) -> str:
    try:
        key = _validate_key_hex(key_hex)
        iv = base64.b64decode(payload.iv)
        tag = base64.b64decode(payload.tag)
        ciphertext = base64.b64decode(payload.ciphertext)

        backend = default_backend()
        cipher = Cipher(algorithms.AES(key), modes.GCM(iv, tag), backend=backend)
        decryptor = cipher.decryptor()

        decrypted = decryptor.update(ciphertext) + decryptor.finalize()
        return decrypted.decode("utf-8")

    except InvalidTag:
        raise ValueError("Decryption failed: Invalid authentication tag. Possible tampering.")
    except Exception as e:
        raise RuntimeError(f"Decryption failed: {str(e)}")
