# tests/test_encrypted_blob_bounds.py
"""
PR attach point:
  POST /api/pkm/store-domain  (api/routes/pkm_routes_shared.py)
  — EncryptedBlob.ciphertext  max_length=10_000_000  min_length=1
  — EncryptedBlob.iv          max_length=512          min_length=1
  — EncryptedBlob.tag         max_length=512          min_length=1
  — EncryptedBlob.algorithm   max_length=64

Verifies that unbounded encrypted-blob string fields now reject oversized
or empty values with 422 before reaching the service layer.

Previously all three fields were unlimited strings, allowing authenticated
users to upload arbitrary-length payloads (e.g. 100 MB ciphertext) or
empty strings that would fail later with an opaque crypto error.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token

_UID = "test-uid-blob"
_TOKEN = {"user_id": _UID, "token": "fake", "scope": "vault.owner"}

_VALID_BLOB = {
    "ciphertext": "YWJjZGVmZ2g=",  # base64 "abcdefgh"
    "iv": "dGVzdGl2MTI=",           # 12-byte IV in base64
    "tag": "dGVzdHRhZzE2Ynl0ZXM=",  # 16-byte tag in base64
}


@pytest.fixture()
def client():
    from api.main import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _store_domain_payload(blob_override: dict) -> dict:
    blob = {**_VALID_BLOB, **blob_override}
    return {
        "user_id": _UID,
        "domain": "financial",
        "encrypted_payload": blob["ciphertext"],
        "encrypted_blob": blob,
    }


# ---------------------------------------------------------------------------
# ciphertext — min_length=1 and max_length=10_000_000
# ---------------------------------------------------------------------------


def test_empty_ciphertext_rejected(client: TestClient) -> None:
    """Empty ciphertext must be rejected with 422."""
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"ciphertext": ""}),
    )
    assert resp.status_code == 422, resp.text


def test_oversized_ciphertext_rejected(client: TestClient) -> None:
    """Ciphertext > 10 MB must be rejected with 422."""
    huge = "A" * (10_000_001)
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"ciphertext": huge}),
    )
    assert resp.status_code == 422, "Expected 422 for oversized ciphertext"


def test_valid_ciphertext_not_rejected(client: TestClient) -> None:
    """Valid ciphertext must not be rejected with 422."""
    mock_service = MagicMock()
    mock_service.store_domain_data = AsyncMock(
        return_value={"success": True, "message": None, "conflict": False, "version": 1}
    )
    with patch("api.routes.pkm_routes_shared.get_pkm_service", return_value=mock_service):
        resp = client.post(
            "/api/pkm/store-domain",
            json={
                "user_id": _UID,
                "domain": "financial",
                "encrypted_payload": _VALID_BLOB["ciphertext"],
            },
        )
    assert resp.status_code != 422, f"Valid payload rejected: {resp.status_code}"


# ---------------------------------------------------------------------------
# iv — min_length=1 and max_length=512
# ---------------------------------------------------------------------------


def test_empty_iv_rejected(client: TestClient) -> None:
    """Empty iv must be rejected with 422."""
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"iv": ""}),
    )
    assert resp.status_code == 422, resp.text


def test_oversized_iv_rejected(client: TestClient) -> None:
    """iv > 512 chars must be rejected with 422."""
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"iv": "A" * 513}),
    )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# tag — min_length=1 and max_length=512
# ---------------------------------------------------------------------------


def test_empty_tag_rejected(client: TestClient) -> None:
    """Empty tag must be rejected with 422."""
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"tag": ""}),
    )
    assert resp.status_code == 422, resp.text


def test_oversized_tag_rejected(client: TestClient) -> None:
    """tag > 512 chars must be rejected with 422."""
    resp = client.post(
        "/api/pkm/store-domain",
        json=_store_domain_payload({"tag": "A" * 513}),
    )
    assert resp.status_code == 422, resp.text
