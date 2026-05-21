# tests/test_vault.py
"""
Vault Encryption Tests (BYOK-Compliant)
=======================================

Tests for vault encryption/decryption functionality.

IMPORTANT: These tests use dynamically generated test keys via fixtures
defined in conftest.py. This ensures BYOK compliance - no production
keys are ever used in tests.

The `test_vault_key` fixture is automatically available from conftest.py.
"""

import base64
import json

import pytest

from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data


def test_encrypt_decrypt_roundtrip(test_vault_key):
    """
    Test that data can be encrypted and decrypted successfully.

    Uses dynamically generated test key (BYOK-compliant).
    """
    payload = {
        "email": "alice@hushh.ai",
        "preferences": {"category": "electronics", "frequency": "weekly"},
    }
    plaintext = json.dumps(payload)

    encrypted: EncryptedPayload = encrypt_data(plaintext, test_vault_key)
    decrypted = decrypt_data(encrypted, test_vault_key)

    assert isinstance(decrypted, str)
    assert decrypted == plaintext


def test_decryption_fails_with_wrong_key(test_vault_key):
    """
    Test that decryption fails when using an incorrect key.

    Uses dynamically generated test key (BYOK-compliant).
    """
    plaintext = "sensitive data"
    encrypted = encrypt_data(plaintext, test_vault_key)

    # Generate a different fake key (32-byte hex)
    import os

    wrong_key = os.urandom(32).hex()

    with pytest.raises(ValueError, match="Invalid authentication tag"):
        decrypt_data(encrypted, wrong_key)


def test_decryption_fails_with_tampered_data(test_vault_key):
    """
    Test that decryption fails when ciphertext has been tampered with.

    Uses dynamically generated test key (BYOK-compliant).
    """
    plaintext = "user@hushh.ai"
    encrypted = encrypt_data(plaintext, test_vault_key)

    # Tamper with ciphertext
    corrupted = encrypted.model_copy(
        update={"ciphertext": base64.b64encode(b"malicious content").decode("utf-8")}
    )

    with pytest.raises(Exception, match="Decryption failed"):
        decrypt_data(corrupted, test_vault_key)


def test_encrypted_payload_structure(test_vault_key):
    """
    Test that encrypted payload has the correct structure.
    """
    plaintext = "test data"
    encrypted = encrypt_data(plaintext, test_vault_key)

    dump = encrypted.model_dump()
    assert "ciphertext" in dump
    assert "iv" in dump
    assert "tag" in dump


def test_different_ivs_produce_different_ciphertext(test_vault_key):
    """
    Test that encrypting the same data twice produces different ciphertext
    (due to random IV generation).
    """
    plaintext = "same data"

    encrypted1 = encrypt_data(plaintext, test_vault_key)
    encrypted2 = encrypt_data(plaintext, test_vault_key)

    # Same plaintext + key but different IVs should produce different ciphertexts
    assert encrypted1.ciphertext != encrypted2.ciphertext
    assert encrypted1.iv != encrypted2.iv
