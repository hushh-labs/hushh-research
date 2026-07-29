"""Tests for DeveloperConsentRequest connector_public_key field bound (CWE-400).

connector_public_key previously had only a min_length=16 constraint with no
upper bound, allowing arbitrarily large public-key blobs to reach the vault
key-wrapping layer. RSA 4096-bit public keys in PEM/DER base64 are at most
~800 chars; max_length=8192 provides headroom for all common key formats.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.developer import DeveloperConsentRequest

_VALID_KEY_AT_MIN = "x" * 16
_VALID_KEY = "x" * 512
_OVER_MAX_KEY = "x" * 8193
_AT_MAX_KEY = "x" * 8192


def _base_request(**overrides) -> dict:
    base = {
        "user_id": "user_abc",
        "scope": "pkm.read",
        "connector_public_key": _VALID_KEY,
        "connector_key_id": "key-001",
        "connector_wrapping_alg": "RSA-OAEP",
    }
    base.update(overrides)
    return base


class TestConnectorPublicKeyBound:
    """DeveloperConsentRequest.connector_public_key max_length=8192."""

    def test_key_at_min_length_accepted(self):
        req = DeveloperConsentRequest(**_base_request(connector_public_key=_VALID_KEY_AT_MIN))
        assert req.connector_public_key == _VALID_KEY_AT_MIN

    def test_key_at_max_length_accepted(self):
        req = DeveloperConsentRequest(**_base_request(connector_public_key=_AT_MAX_KEY))
        assert len(req.connector_public_key) == 8192

    def test_key_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperConsentRequest(**_base_request(connector_public_key=_OVER_MAX_KEY))

    def test_key_below_min_length_rejected(self):
        with pytest.raises(ValidationError):
            DeveloperConsentRequest(**_base_request(connector_public_key="x" * 15))

    def test_typical_rsa_key_size_accepted(self):
        rsa_2048_pem_approx_len = 736
        req = DeveloperConsentRequest(
            **_base_request(connector_public_key="x" * rsa_2048_pem_approx_len)
        )
        assert len(req.connector_public_key) == rsa_2048_pem_approx_len


class TestConnectorPublicKeyBoundViaRoute:
    """POST /api/v1/request-consent rejects oversized connector_public_key with 422."""

    def _client(self) -> TestClient:
        from api.routes import developer
        app = FastAPI()
        app.include_router(developer.router)
        return TestClient(app, raise_server_exceptions=False)

    def test_oversized_key_rejected_with_422(self):
        resp = self._client().post(
            "/api/v1/request-consent",
            json=_base_request(connector_public_key=_OVER_MAX_KEY),
        )
        assert resp.status_code == 422

    def test_valid_key_passes_model_validation(self):
        resp = self._client().post(
            "/api/v1/request-consent",
            json=_base_request(connector_public_key=_VALID_KEY),
        )
        assert resp.status_code != 422, (
            "Valid connector_public_key must pass Pydantic validation"
        )
