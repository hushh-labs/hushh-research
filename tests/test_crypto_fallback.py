"""Crypto hardware-to-software fallback resilience tests.

Verifies that when hardware AES acceleration is unavailable or raises
RuntimeError during cipher initialization, the CipherEngine falls back
transparently to the pure-software AES-GCM layer and the full
encrypt/decrypt loop continues to work flawlessly.

[Crypto Safety Guard by Abdul Gaffar]
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from hushh_mcp.services.crypto import (
    CipherEngine,
    HardwareAESBackend,
    SoftwareAESGCMBackend,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_PLAINTEXT = b"Hushh consent payload - classified"
_AAD = b"hushh-aad-context"


@pytest.fixture()
def software_engine(monkeypatch: pytest.MonkeyPatch) -> CipherEngine:
    """CipherEngine where hardware init always raises RuntimeError."""
    monkeypatch.setenv("HUSHH_HW_AES", "0")
    return CipherEngine()


@pytest.fixture()
def hardware_engine(monkeypatch: pytest.MonkeyPatch) -> CipherEngine:
    """CipherEngine where hardware backend is reported as available."""
    monkeypatch.setenv("HUSHH_HW_AES", "1")
    return CipherEngine()


# ---------------------------------------------------------------------------
# TestHardwareInitFailureFallback  ← core requirement
# ---------------------------------------------------------------------------


class TestHardwareInitFailureFallback:
    """Hardware raises RuntimeError; software fallback must take over."""

    def test_engine_initialises_without_raising(self, software_engine: CipherEngine) -> None:
        assert software_engine is not None

    def test_engine_uses_software_backend_after_failure(
        self, software_engine: CipherEngine
    ) -> None:
        assert software_engine.backend_name == "software-aesgcm"

    def test_hardware_available_flag_is_false_after_failure(
        self, software_engine: CipherEngine
    ) -> None:
        assert software_engine._hardware_available is False

    def test_encrypt_succeeds_on_software_fallback(
        self, software_engine: CipherEngine
    ) -> None:
        ct, _key, _nonce = software_engine.encrypt(_PLAINTEXT)
        assert isinstance(ct, bytes)
        assert len(ct) > 0

    def test_decrypt_succeeds_on_software_fallback(
        self, software_engine: CipherEngine
    ) -> None:
        ct, key, nonce = software_engine.encrypt(_PLAINTEXT)
        recovered = software_engine.decrypt(ct, key=key, nonce=nonce)
        assert recovered == _PLAINTEXT

    def test_encrypt_decrypt_roundtrip_with_aad(
        self, software_engine: CipherEngine
    ) -> None:
        ct, key, nonce = software_engine.encrypt(_PLAINTEXT, aad=_AAD)
        recovered = software_engine.decrypt(ct, key=key, nonce=nonce, aad=_AAD)
        assert recovered == _PLAINTEXT

    def test_ciphertext_differs_from_plaintext(
        self, software_engine: CipherEngine
    ) -> None:
        ct, _key, _nonce = software_engine.encrypt(_PLAINTEXT)
        assert ct != _PLAINTEXT

    def test_mocked_hardware_init_raises_runtime_error(self) -> None:
        """Explicit mock: HardwareAESBackend.__init__ raises RuntimeError."""
        with patch.object(
            HardwareAESBackend,
            "__init__",
            side_effect=RuntimeError("mock: AES-NI driver missing"),
        ):
            engine = CipherEngine()
        assert engine.backend_name == "software-aesgcm"
        assert engine._hardware_available is False

    def test_mocked_hardware_failure_encrypt_decrypt(self) -> None:
        with patch.object(
            HardwareAESBackend,
            "__init__",
            side_effect=RuntimeError("mock: hardware unavailable"),
        ):
            engine = CipherEngine()
        ct, key, nonce = engine.encrypt(_PLAINTEXT)
        assert engine.decrypt(ct, key=key, nonce=nonce) == _PLAINTEXT


# ---------------------------------------------------------------------------
# TestHardwareBackendAvailable
# ---------------------------------------------------------------------------


class TestHardwareBackendAvailable:
    def test_engine_uses_hardware_backend_when_available(
        self, hardware_engine: CipherEngine
    ) -> None:
        assert hardware_engine.backend_name == "hardware-aes"

    def test_hardware_available_flag_is_true(
        self, hardware_engine: CipherEngine
    ) -> None:
        assert hardware_engine._hardware_available is True

    def test_hardware_encrypt_decrypt_roundtrip(
        self, hardware_engine: CipherEngine
    ) -> None:
        ct, key, nonce = hardware_engine.encrypt(_PLAINTEXT)
        assert hardware_engine.decrypt(ct, key=key, nonce=nonce) == _PLAINTEXT


# ---------------------------------------------------------------------------
# TestSoftwareBackendDirect
# ---------------------------------------------------------------------------


class TestSoftwareBackendDirect:
    def test_software_backend_encrypt_returns_bytes(self) -> None:
        backend = SoftwareAESGCMBackend()
        key = os.urandom(32)
        nonce = os.urandom(12)
        ct = backend.encrypt(key, nonce, _PLAINTEXT, None)
        assert isinstance(ct, bytes)

    def test_software_backend_roundtrip(self) -> None:
        backend = SoftwareAESGCMBackend()
        key = os.urandom(32)
        nonce = os.urandom(12)
        ct = backend.encrypt(key, nonce, _PLAINTEXT, None)
        assert backend.decrypt(key, nonce, ct, None) == _PLAINTEXT

    def test_software_backend_name(self) -> None:
        assert SoftwareAESGCMBackend().backend_name == "software-aesgcm"

    def test_software_backend_aad_roundtrip(self) -> None:
        backend = SoftwareAESGCMBackend()
        key = os.urandom(32)
        nonce = os.urandom(12)
        ct = backend.encrypt(key, nonce, _PLAINTEXT, _AAD)
        assert backend.decrypt(key, nonce, ct, _AAD) == _PLAINTEXT

    def test_software_backend_wrong_aad_raises(self) -> None:
        backend = SoftwareAESGCMBackend()
        key = os.urandom(32)
        nonce = os.urandom(12)
        ct = backend.encrypt(key, nonce, _PLAINTEXT, _AAD)
        with pytest.raises(Exception):
            backend.decrypt(key, nonce, ct, b"wrong-aad")


# ---------------------------------------------------------------------------
# TestHardwareBackendProbe
# ---------------------------------------------------------------------------


class TestHardwareBackendProbe:
    def test_hardware_init_fails_when_env_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HUSHH_HW_AES", raising=False)
        with pytest.raises(RuntimeError):
            HardwareAESBackend()

    def test_hardware_init_fails_when_env_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HUSHH_HW_AES", "0")
        with pytest.raises(RuntimeError):
            HardwareAESBackend()

    def test_hardware_init_succeeds_when_env_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HUSHH_HW_AES", "1")
        backend = HardwareAESBackend()
        assert backend.backend_name == "hardware-aes"

    def test_hardware_backend_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HUSHH_HW_AES", "1")
        assert HardwareAESBackend().backend_name == "hardware-aes"


# ---------------------------------------------------------------------------
# TestCipherEngineKeyNonce
# ---------------------------------------------------------------------------


class TestCipherEngineKeyNonce:
    def test_generate_key_returns_32_bytes(self, software_engine: CipherEngine) -> None:
        assert len(software_engine.generate_key()) == 32

    def test_generate_nonce_returns_12_bytes(self, software_engine: CipherEngine) -> None:
        assert len(software_engine.generate_nonce()) == 12

    def test_generate_key_unique(self, software_engine: CipherEngine) -> None:
        assert software_engine.generate_key() != software_engine.generate_key()

    def test_caller_supplied_key_is_used(self, software_engine: CipherEngine) -> None:
        key = os.urandom(32)
        nonce = os.urandom(12)
        ct, returned_key, returned_nonce = software_engine.encrypt(
            _PLAINTEXT, key=key, nonce=nonce
        )
        assert returned_key == key
        assert returned_nonce == nonce

    def test_decrypt_wrong_key_raises(self, software_engine: CipherEngine) -> None:
        ct, key, nonce = software_engine.encrypt(_PLAINTEXT)
        with pytest.raises(Exception):
            software_engine.decrypt(ct, key=os.urandom(32), nonce=nonce)

    def test_decrypt_wrong_nonce_raises(self, software_engine: CipherEngine) -> None:
        ct, key, nonce = software_engine.encrypt(_PLAINTEXT)
        with pytest.raises(Exception):
            software_engine.decrypt(ct, key=key, nonce=os.urandom(12))


# ---------------------------------------------------------------------------
# TestConcurrentFallbackStability
# ---------------------------------------------------------------------------


class TestConcurrentFallbackStability:
    def test_multiple_engines_all_fall_back_independently(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("HUSHH_HW_AES", "0")
        engines = [CipherEngine() for _ in range(5)]
        for e in engines:
            assert e.backend_name == "software-aesgcm"

    def test_repeated_encrypt_decrypt_stable(self, software_engine: CipherEngine) -> None:
        for _ in range(10):
            ct, key, nonce = software_engine.encrypt(_PLAINTEXT)
            assert software_engine.decrypt(ct, key=key, nonce=nonce) == _PLAINTEXT

    def test_different_plaintexts_each_roundtrip(
        self, software_engine: CipherEngine
    ) -> None:
        payloads = [f"payload-{i}".encode() for i in range(8)]
        for pt in payloads:
            ct, key, nonce = software_engine.encrypt(pt)
            assert software_engine.decrypt(ct, key=key, nonce=nonce) == pt


# ---------------------------------------------------------------------------
# TestTrustBoundaryProof
# ---------------------------------------------------------------------------


class TestTrustBoundaryProof:
    """Canonical trust-boundary proof — crypto fallback chain.

    Caller chain:
        test suite
        → CipherEngine._init_cipher()     [try/except RuntimeError]
        → HardwareAESBackend.__init__()   [raises RuntimeError on missing driver]
        → SoftwareAESGCMBackend           [transparent software fallback]
        → hushh_mcp.services.crypto
        [Crypto Safety Guard by Abdul Gaffar]
    """

    def test_golden_path_hardware_failure_to_software_roundtrip(self) -> None:
        """Golden-path: mock driver failure → software fallback → encrypt/decrypt."""
        with patch.object(
            HardwareAESBackend,
            "__init__",
            side_effect=RuntimeError("AES-NI driver not found"),
        ):
            engine = CipherEngine()

        assert engine.backend_name == "software-aesgcm"
        assert engine._hardware_available is False

        plaintext = b"Hushh consent boundary proof"
        ct, key, nonce = engine.encrypt(plaintext)
        recovered = engine.decrypt(ct, key=key, nonce=nonce)
        assert recovered == plaintext

    def test_crypto_guard_signature_in_module_docstring(self) -> None:
        import hushh_mcp.services.crypto as crypto_mod

        assert "[Crypto Safety Guard by Abdul Gaffar]" in (crypto_mod.__doc__ or "")

    def test_no_runtime_error_escapes_engine_init(self) -> None:
        with patch.object(
            HardwareAESBackend,
            "__init__",
            side_effect=RuntimeError("catastrophic HW failure"),
        ):
            try:
                engine = CipherEngine()
            except RuntimeError:
                pytest.fail("RuntimeError escaped CipherEngine.__post_init__")

        assert engine is not None

    def test_software_backend_satisfies_cipher_backend_protocol(self) -> None:
        from hushh_mcp.services.crypto import CipherBackend

        assert isinstance(SoftwareAESGCMBackend(), CipherBackend)
