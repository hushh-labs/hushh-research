"""Reviewer chat authority and semantic acceptance contracts."""

import pytest

from scripts import _reviewer_session as reviewer_session
from scripts import measure_agent_chat_latency as driver


def test_fast_semantically_invalid_answer_fails_latency_acceptance():
    report = {
        "samples": [
            {
                "prompt_id": "synthetic",
                "outcome": "finished",
                "client_first_visible_ms": 100.0,
                "client_total_ms": 200.0,
            }
        ],
        "categories": {},
    }
    report["samples"][0]["answer_validated"] = False
    assert any("semantic" in b for b in driver.evaluate_bounds(report, None))


def test_real_chat_unlock_header_and_integrity_stay_out_of_artifacts():
    import base64
    import hashlib
    from unittest.mock import Mock

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    secret = "synthetic-only-passphrase"
    vault_key, salt, iv = bytes(range(32)), bytes(range(16)), bytes(range(12))
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100000).derive(
        secret.encode()
    )

    def encode(value):
        return base64.b64encode(value).decode()

    payload = {
        "vaultKeyHash": hashlib.sha256(vault_key).hexdigest(),
        "wrappers": [
            {
                "method": "passphrase",
                "salt": encode(salt),
                "iv": encode(iv),
                "encryptedVaultKey": encode(AESGCM(key).encrypt(iv, vault_key, None)),
            }
        ],
    }
    http = Mock()
    http.post.return_value.status_code = 200
    http.post.return_value.json.return_value = payload
    session = reviewer_session.ReviewerSession("synthetic", "firebase", "owner", secret)
    derived = reviewer_session.derive_reviewer_chat_key("https://example.test", session, http=http)
    expected = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=b"", info=b"hussh-one-chat-v1"
    ).derive(vault_key)
    assert derived == "hck1." + expected.hex()
    assert "Chat-Key" not in repr(http.post.call_args)
    http.post.return_value.close.assert_called_once()
    payload["vaultKeyHash"] = "0" * 64
    with pytest.raises(RuntimeError, match="integrity"):
        reviewer_session.derive_reviewer_chat_key("https://example.test", session, http=http)
