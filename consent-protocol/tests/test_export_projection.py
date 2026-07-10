from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.consent.export_projection import (
    decrypt_scoped_export_package,
    narrow_decrypted_export,
    project_domain_data_for_scope,
)


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("utf-8")


def _encrypt_export(payload: dict, *, connector_public_key: X25519PublicKey) -> dict:
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    export_key = os.urandom(32)
    export_iv = os.urandom(12)
    export_ciphertext = AESGCM(export_key).encrypt(export_iv, plaintext, None)

    sender_private = X25519PrivateKey.generate()
    shared_secret = sender_private.exchange(connector_public_key)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared_secret)
    wrapping_key = digest.finalize()
    wrapped_iv = os.urandom(12)
    wrapped = AESGCM(wrapping_key).encrypt(wrapped_iv, export_key, None)
    sender_public_key = sender_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )

    return {
        "encrypted_data": _b64(export_ciphertext[:-16]),
        "iv": _b64(export_iv),
        "tag": _b64(export_ciphertext[-16:]),
        "wrapped_key_bundle": {
            "wrapped_export_key": _b64(wrapped[:-16]),
            "wrapped_key_iv": _b64(wrapped_iv),
            "wrapped_key_tag": _b64(wrapped[-16:]),
            "sender_public_key": _b64(sender_public_key),
            "wrapping_alg": "X25519-AES256-GCM",
        },
    }


def test_decrypt_scoped_export_package_round_trip_inline_ciphertext():
    connector_private = X25519PrivateKey.generate()
    connector_public = connector_private.public_key()
    payload = {"financial": {"net_worth": 1656064.53}}

    package = _encrypt_export(payload, connector_public_key=connector_public)

    decrypted = decrypt_scoped_export_package(
        wrapped_key_bundle=package["wrapped_key_bundle"],
        iv_b64=package["iv"],
        tag_b64=package["tag"],
        ciphertext=package["encrypted_data"],
        connector_private_key=connector_private,
    )

    assert decrypted == payload


def test_decrypt_scoped_export_package_round_trip_raw_bytes():
    """Raw download bytes (not base64) must decrypt identically to inline."""
    connector_private = X25519PrivateKey.generate()
    connector_public = connector_private.public_key()
    payload = {"financial": {"net_worth": 1656064.53}}

    package = _encrypt_export(payload, connector_public_key=connector_public)
    raw_bytes = base64.b64decode(package["encrypted_data"])

    decrypted = decrypt_scoped_export_package(
        wrapped_key_bundle=package["wrapped_key_bundle"],
        iv_b64=package["iv"],
        tag_b64=package["tag"],
        ciphertext=raw_bytes,
        connector_private_key=connector_private,
    )

    assert decrypted == payload


def test_project_domain_data_for_scope_wildcard_returns_full_domain():
    domain_data = {"net_worth": 100, "accounts": [{"id": 1}]}
    result = project_domain_data_for_scope("financial", "attr.financial.*", domain_data)
    assert result == {"financial": domain_data}


def test_project_domain_data_for_scope_narrows_to_path():
    domain_data = {"analytics": {"quality_metrics": {"score": 92}}, "other": "ignored"}
    result = project_domain_data_for_scope(
        "financial", "attr.financial.analytics.quality_metrics", domain_data
    )
    assert result == {"financial": {"analytics": {"quality_metrics": {"score": 92}}}}


def test_extract_path_value_items_traversal_over_lists():
    """The `_items` special segment traverses lists when passed directly.

    project_domain_data_for_scope normalizes dotted scope path segments by
    stripping leading/trailing underscores, so `_items` never reaches this
    special case via a scope string. This is pre-existing behavior preserved
    verbatim from the original smoke-script implementation; the underlying
    _items traversal capability is exercised here directly instead.
    """
    from hushh_mcp.consent.export_projection import _extract_path_value

    domain_data = {"accounts": [{"id": 1, "balance": 10}, {"id": 2, "balance": 20}]}
    result = _extract_path_value(domain_data, ["accounts", "_items", "balance"])
    assert result == [10, 20]


def test_project_domain_data_for_scope_missing_path_returns_empty_domain():
    domain_data = {"net_worth": 100}
    result = project_domain_data_for_scope("financial", "attr.financial.nonexistent", domain_data)
    assert result == {"financial": {}}


def test_narrow_decrypted_export_passthrough_without_expected_scope():
    payload = {"financial": {"net_worth": 100}}
    assert narrow_decrypted_export(payload, None) == payload


def test_narrow_decrypted_export_narrows_using_source_domain_metadata():
    payload = {
        "financial": {"net_worth": 100, "accounts": []},
        "__export_metadata": {"source_domain": "financial"},
    }
    result = narrow_decrypted_export(payload, "attr.financial.net_worth")
    assert result == {
        "financial": {"net_worth": 100},
        "__export_metadata": {"source_domain": "financial"},
    }


def test_narrow_decrypted_export_derives_domain_from_scope_when_no_metadata():
    payload = {"financial": {"net_worth": 100}}
    result = narrow_decrypted_export(payload, "attr.financial.*")
    assert result == {"financial": {"net_worth": 100}}
