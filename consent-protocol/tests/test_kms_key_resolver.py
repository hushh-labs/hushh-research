"""Hermetic tests for KMS envelope key resolution (SC-12 / SC-13 / SC-28).

No network, no google-cloud-kms: the decryptor is injected, so the fail-safe /
fail-closed logic and the envelope round-trip are exercised directly.
"""

from __future__ import annotations

import base64

import pytest

from hushh_mcp.kms_key_resolver import resolve_key

_PLAINTEXT = "a" * 40  # >= 32 chars, a valid APP_SIGNING_KEY shape
_KEK = "projects/p/locations/l/keyRings/r/cryptoKeys/k"


def test_disabled_returns_plaintext_verbatim():
    out = resolve_key(
        label="APP_SIGNING_KEY",
        plaintext=_PLAINTEXT,
        wrapped_b64="ignored-when-disabled",
        kek_resource=_KEK,
        enabled=False,
        strict=False,
    )
    assert out == _PLAINTEXT


def test_enabled_unwraps_via_injected_decryptor():
    unwrapped_dek = "b" * 64
    seen = {}

    def fake(*, ciphertext, key_name):
        seen["ciphertext"] = ciphertext
        seen["key_name"] = key_name
        return unwrapped_dek.encode()

    wrapped = base64.b64encode(b"wrapped-bytes").decode()
    out = resolve_key(
        label="VAULT_DATA_KEY",
        plaintext="",
        wrapped_b64=wrapped,
        kek_resource=_KEK,
        enabled=True,
        strict=False,
        decryptor=fake,
    )
    assert out == unwrapped_dek
    assert seen["key_name"] == _KEK
    assert seen["ciphertext"] == b"wrapped-bytes"


def test_enabled_but_unconfigured_falls_back_when_not_strict():
    out = resolve_key(
        label="APP_SIGNING_KEY",
        plaintext=_PLAINTEXT,
        wrapped_b64="",
        kek_resource="",
        enabled=True,
        strict=False,
    )
    assert out == _PLAINTEXT


def test_enabled_but_unconfigured_raises_when_strict():
    with pytest.raises(RuntimeError):
        resolve_key(
            label="APP_SIGNING_KEY",
            plaintext=_PLAINTEXT,
            wrapped_b64="",
            kek_resource="",
            enabled=True,
            strict=True,
        )


def test_decrypt_failure_falls_back_when_not_strict():
    def boom(*, ciphertext, key_name):
        raise RuntimeError("kms unreachable")

    wrapped = base64.b64encode(b"x").decode()
    out = resolve_key(
        label="APP_SIGNING_KEY",
        plaintext=_PLAINTEXT,
        wrapped_b64=wrapped,
        kek_resource=_KEK,
        enabled=True,
        strict=False,
        decryptor=boom,
    )
    assert out == _PLAINTEXT


def test_decrypt_failure_raises_when_strict():
    def boom(*, ciphertext, key_name):
        raise RuntimeError("kms unreachable")

    wrapped = base64.b64encode(b"x").decode()
    with pytest.raises(RuntimeError):
        resolve_key(
            label="APP_SIGNING_KEY",
            plaintext=_PLAINTEXT,
            wrapped_b64=wrapped,
            kek_resource=_KEK,
            enabled=True,
            strict=True,
            decryptor=boom,
        )


def test_empty_kms_plaintext_falls_back_when_not_strict():
    def empties(*, ciphertext, key_name):
        return b"   "  # whitespace -> stripped empty -> treated as failure

    wrapped = base64.b64encode(b"x").decode()
    out = resolve_key(
        label="VAULT_DATA_KEY",
        plaintext=_PLAINTEXT,
        wrapped_b64=wrapped,
        kek_resource=_KEK,
        enabled=True,
        strict=False,
        decryptor=empties,
    )
    assert out == _PLAINTEXT
