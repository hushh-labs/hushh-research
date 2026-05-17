"""Cipher initialization with hardware-to-software fallback.

Attempts to initialize the cipher via a hardware-accelerated backend
(e.g. AES-NI or chip-level bindings).  If that initialization raises a
RuntimeError — missing driver, unsupported CPU feature, or sandboxed
environment — the engine falls back instantly to a pure-software AES-GCM
implementation backed by the system's cryptography library.

No exception ever escapes the cipher-initialization boundary.

[Crypto Safety Guard by Abdul Gaffar]
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

# AES-256-GCM constants
_KEY_BYTES = 32
_NONCE_BYTES = 12


# ---------------------------------------------------------------------------
# Backend protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class CipherBackend(Protocol):
    """Minimal interface every backend must satisfy."""

    backend_name: str

    def encrypt(self, key: bytes, nonce: bytes, plaintext: bytes, aad: bytes | None) -> bytes:
        ...

    def decrypt(self, key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes | None) -> bytes:
        ...


# ---------------------------------------------------------------------------
# Software backend (always available)
# ---------------------------------------------------------------------------


class SoftwareAESGCMBackend:
    """Pure-software AES-256-GCM via the cryptography package.

    [Crypto Safety Guard by Abdul Gaffar]
    """

    backend_name: str = "software-aesgcm"

    def encrypt(self, key: bytes, nonce: bytes, plaintext: bytes, aad: bytes | None) -> bytes:
        return AESGCM(key).encrypt(nonce, plaintext, aad)

    def decrypt(self, key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes | None) -> bytes:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)


# ---------------------------------------------------------------------------
# Hardware backend stub
# ---------------------------------------------------------------------------


class HardwareAESBackend:
    """Hardware-accelerated AES backend (AES-NI / chip-level bindings).

    Raises RuntimeError during __init__ when the hardware feature or driver
    is unavailable in the host environment, allowing the caller to fall back
    to software.

    [Crypto Safety Guard by Abdul Gaffar]
    """

    backend_name: str = "hardware-aes"

    def __init__(self) -> None:
        self._probe_hardware()

    def _probe_hardware(self) -> None:
        """Raise RuntimeError if hardware acceleration is unavailable."""
        if not self._is_hardware_available():
            raise RuntimeError(
                "Hardware AES acceleration unavailable: missing driver or unsupported CPU"
            )

    @staticmethod
    def _is_hardware_available() -> bool:
        # In real deployments this would inspect CPUID flags or a kernel module.
        # Here we read an env var so CI / tests can control the behaviour.
        return os.environ.get("HUSHH_HW_AES", "0") == "1"

    def encrypt(self, key: bytes, nonce: bytes, plaintext: bytes, aad: bytes | None) -> bytes:
        return AESGCM(key).encrypt(nonce, plaintext, aad)

    def decrypt(self, key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes | None) -> bytes:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)


# ---------------------------------------------------------------------------
# Cipher initializer — the canonical attach point
# ---------------------------------------------------------------------------


@dataclass
class CipherEngine:
    """AES-GCM cipher engine with hardware→software fallback.

    Tries the hardware backend first.  On RuntimeError it logs a warning and
    switches seamlessly to the software backend so that callers never see an
    initialization failure.

    [Crypto Safety Guard by Abdul Gaffar]
    """

    _backend: CipherBackend = field(init=False)
    _hardware_available: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        self._backend = self._init_cipher()

    def _init_cipher(self) -> CipherBackend:
        try:
            backend: CipherBackend = HardwareAESBackend()
            self._hardware_available = True
            logger.info(
                "[Crypto Safety Guard by Abdul Gaffar] hardware backend initialised: %s",
                backend.backend_name,
            )
            return backend
        except RuntimeError as exc:
            logger.warning(
                "[Crypto Safety Guard by Abdul Gaffar] hardware init failed (%s); "
                "falling back to software backend",
                exc,
            )
            self._hardware_available = False
            return SoftwareAESGCMBackend()

    @property
    def backend_name(self) -> str:
        return self._backend.backend_name

    @staticmethod
    def generate_key() -> bytes:
        return os.urandom(_KEY_BYTES)

    @staticmethod
    def generate_nonce() -> bytes:
        return os.urandom(_NONCE_BYTES)

    def encrypt(
        self,
        plaintext: bytes,
        *,
        key: bytes | None = None,
        nonce: bytes | None = None,
        aad: bytes | None = None,
    ) -> tuple[bytes, bytes, bytes]:
        """Return (ciphertext, key, nonce).  Key and nonce are generated if not supplied."""
        _key = key if key is not None else self.generate_key()
        _nonce = nonce if nonce is not None else self.generate_nonce()
        ciphertext = self._backend.encrypt(_key, _nonce, plaintext, aad)
        return ciphertext, _key, _nonce

    def decrypt(
        self,
        ciphertext: bytes,
        *,
        key: bytes,
        nonce: bytes,
        aad: bytes | None = None,
    ) -> bytes:
        return self._backend.decrypt(key, nonce, ciphertext, aad)
