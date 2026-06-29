# hushh_mcp/vault/encrypt.py

import base64
import os
from typing import Literal

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from hushh_mcp.types import EncryptedPayload

# ==================== Constants ====================

IV_LENGTH = 12  # GCM recommended IV size
TAG_LENGTH = 16
ALGORITHM_NAME: Literal["aes-256-gcm"] = "aes-256-gcm"


# ==================== Encrypt ====================
def validate_key_hex(key_hex: str) -> None:
    if len(key_hex) != 64:
        raise ValueError("AES-256 key must be 64 hexadecimal characters")

    try:
        bytes.fromhex(key_hex)
    except ValueError:
        raise ValueError("AES-256 key must be valid hexadecimal")


def encrypt_data(plaintext: str, key_hex: str) -> EncryptedPayload:
    try:
        validate_key_hex(key_hex)
        key = bytes.fromhex(key_hex)
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
        validate_key_hex(key_hex)
        key = bytes.fromhex(key_hex)
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


# ============ PBKDF2-HMAC-SHA256 + AES-256-CBC (MuleSoft JCE interop) ============
#
# MuleSoft's JCE Decrypt module emits PBKDF2WithHmacSHA256 + AES-256-CBC (FIPS),
# not AES-GCM. The connector key is derived from a password + salt + iteration
# count (PBKDF2), then used for AES-256-CBC with PKCS7 padding. The stored blob
# is base64(iv || ciphertext). This is used for CRM connector credentials only;
# user data stays on AES-256-GCM above.

PBKDF2_CBC_ALGORITHM = "pbkdf2-hmacsha256-aes256-cbc"
_AES_CBC_IV_LENGTH = 16  # CBC IV = one AES block


def derive_pbkdf2_key(password: str, salt: str, iterations: int) -> bytes:
    """Derive a 256-bit AES key via PBKDF2-HMAC-SHA256 (deterministic)."""
    import hashlib

    if iterations < 1:
        raise ValueError("PBKDF2 iteration count must be >= 1")
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations, dklen=32
    )


def encrypt_data_pbkdf2_cbc(plaintext: str, password: str, salt: str, iterations: int) -> str:
    """Encrypt to base64(iv || ciphertext) — matches MuleSoft JCE AES-256-CBC output.

    Provided so Hushh can produce MuleSoft-compatible blobs (e.g. an encrypt
    helper endpoint) and so tests can round-trip without a live Mule.
    """
    try:
        key = derive_pbkdf2_key(password, salt, iterations)
        iv = os.urandom(_AES_CBC_IV_LENGTH)
        padder = _cbc_padder()
        padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
        encryptor = Cipher(
            algorithms.AES(key), modes.CBC(iv), backend=default_backend()
        ).encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()
        return base64.b64encode(iv + ciphertext).decode("utf-8")
    except Exception as e:
        raise RuntimeError(f"PBKDF2-CBC encryption failed: {str(e)}")


def decrypt_data_pbkdf2_cbc(blob_b64: str, password: str, salt: str, iterations: int) -> str:
    """Decrypt a base64(iv || ciphertext) MuleSoft JCE AES-256-CBC blob."""
    try:
        raw = base64.b64decode(blob_b64)
        if len(raw) <= _AES_CBC_IV_LENGTH:
            raise ValueError("blob too short to contain IV + ciphertext")
        iv, ciphertext = raw[:_AES_CBC_IV_LENGTH], raw[_AES_CBC_IV_LENGTH:]
        key = derive_pbkdf2_key(password, salt, iterations)
        decryptor = Cipher(
            algorithms.AES(key), modes.CBC(iv), backend=default_backend()
        ).decryptor()
        padded = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = _cbc_unpadder()
        return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")
    except Exception as e:
        raise RuntimeError(f"PBKDF2-CBC decryption failed: {str(e)}")


def _cbc_padder():
    from cryptography.hazmat.primitives import padding

    return padding.PKCS7(128).padder()


def _cbc_unpadder():
    from cryptography.hazmat.primitives import padding

    return padding.PKCS7(128).unpadder()
