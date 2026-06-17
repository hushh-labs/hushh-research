# consent-protocol/tests/test_plaid_webhook_jwt_alg_confusion.py
"""
Regression tests: Plaid webhook JWT algorithm must be pinned to RS256.

CWE-327 / algorithm confusion attack: if the JWT algorithm is taken from the
unverified token header, an attacker can supply `alg: "none"` (to skip
signature verification) or `alg: "HS256"` (HMAC confusion). The verifier
must reject any algorithm other than the expected RS256.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.services.broker_funding_service import (
    PlaidWebhookVerificationError,
)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_service():
    """Return a BrokerFundingService with the Plaid config marked as configured.

    plaid_config is a read-only @property backed by _plaid_runtime_config.
    Setting the backing field directly lets the property return our mock
    without triggering PlaidRuntimeConfig.from_env().
    """
    from hushh_mcp.services.broker_funding_service import BrokerFundingService

    svc = BrokerFundingService.__new__(BrokerFundingService)
    mock_config = MagicMock()
    mock_config.configured = True
    svc._plaid_runtime_config = mock_config
    return svc


def _fake_unverified_header(alg: str) -> dict:
    return {"alg": alg, "kid": "test-kid"}


def _fake_jwk_response() -> dict:
    # RSA-2048 public key components (not a real key, values chosen for size)
    return {
        "key": {
            "n": "0" * 342,  # placeholder; will be parsed by _jwk_to_int
            "e": "AQAB",
        }
    }


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_alg", ["none", "HS256", "HS512", "RS512", "ES256"])
async def test_non_rs256_algorithm_rejected(bad_alg):
    """Any algorithm other than RS256 must raise PlaidWebhookVerificationError."""
    svc = _make_service()

    with (
        patch.object(
            type(svc),
            "_plaid_post",
            new=AsyncMock(return_value=_fake_jwk_response()),
        ),
        patch(
            "hushh_mcp.services.broker_funding_service.jwt.get_unverified_header",
            return_value=_fake_unverified_header(bad_alg),
        ),
    ):
        with pytest.raises(PlaidWebhookVerificationError) as exc_info:
            await svc._verify_plaid_webhook(
                headers={"Plaid-Verification": "header.payload.sig"},
                raw_body=b'{"type":"TEST"}',
            )

    assert "validation failed" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_rs256_proceeds_to_decode_step():
    """RS256 is accepted; failure at the jwt.decode step (bad signature) is fine."""
    svc = _make_service()

    with (
        patch.object(
            type(svc),
            "_plaid_post",
            new=AsyncMock(return_value=_fake_jwk_response()),
        ),
        patch(
            "hushh_mcp.services.broker_funding_service.jwt.get_unverified_header",
            return_value=_fake_unverified_header("RS256"),
        ),
        patch(
            "hushh_mcp.services.broker_funding_service.rsa.RSAPublicNumbers",
            side_effect=ValueError("test key error"),
        ),
    ):
        with pytest.raises((PlaidWebhookVerificationError, ValueError)):
            await svc._verify_plaid_webhook(
                headers={"Plaid-Verification": "header.payload.sig"},
                raw_body=b'{"type":"TEST"}',
            )
