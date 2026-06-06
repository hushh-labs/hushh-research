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
