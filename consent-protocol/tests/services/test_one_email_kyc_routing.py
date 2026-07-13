"""Unit tests for OneEmailKycService.classify_kyc_request (Pass 1 routing).

Verifies that classify_kyc_request delegates to _llm_generate_structured and
returns the routing dict unchanged. No real Gemini calls are made.
"""

from unittest.mock import patch

import pytest

from hushh_mcp.services.one_email_kyc_service import get_one_email_kyc_service


@pytest.mark.asyncio
async def test_classify_routes_hotel_booking_to_identity():
    service = get_one_email_kyc_service()
    routing = {
        "classification": "kyc",
        "requested_items": [
            {
                "label": "Full name",
                "domain": "identity",
                "scope": "attr.identity.name",
                "rationale": "personal info to confirm booking",
            }
        ],
        "primary_domains": ["identity"],
        "confidence": 0.94,
        "reasoning": "Asks for personal info to confirm a hotel booking -> identity, not travel.",
    }

    with patch.object(service, "_llm_generate_structured", return_value=routing) as gen:
        result = await service.classify_kyc_request(
            subject="Confirm your hotel booking",
            body="Please provide your information so we can confirm your hotel booking.",
            pkm_index={
                "available_domains": ["identity", "travel"],
                "domain_summaries": {
                    "travel": "flight search history",
                    "identity": "name, dob, address",
                },
            },
        )

    assert result["primary_domains"] == ["identity"]
    assert result["classification"] == "kyc"
    gen.assert_called_once()
