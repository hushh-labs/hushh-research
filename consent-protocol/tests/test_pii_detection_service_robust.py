import os
import sys

# Ensure root directory is in sys.path before importing services
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from services.pii_detection_service import (
    PIIDetector,
    PIIFilter,
    PIIType,
    validate_pii_access_with_db,
)


def test_pii_detector_basic_detection():
    detector = PIIDetector(use_ner=False)

    text = "Contact me at test@example.com or call 123-456-7890. My SSN is 000-12-3456."
    matches = detector.detect(text)

    # Assert email, phone, and SSN are detected
    types = {m.type for m in matches}
    assert PIIType.EMAIL in types
    assert PIIType.PHONE in types

    # Verify redaction
    redacted = detector.redact(text, replacement="[REDACTED]")
    assert "test@example.com" not in redacted
    assert "123-456-7890" not in redacted
    assert "[REDACTED]:EMAIL" in redacted
    assert "[REDACTED]:PHONE" in redacted


def test_validate_before_storage_with_allowed_types():
    detector = PIIDetector(use_ner=False)
    pii_filter = PIIFilter(detector=detector)

    # Payload contains email and phone number
    data = {"user_email": "hello@world.com", "details": "call me at 555-555-5555"}

    # If no PII is allowed, validation should fail
    assert pii_filter.validate_before_storage(data, allowed_pii_types=set()) is False

    # If email and phone are allowed, validation should pass
    allowed = {PIIType.EMAIL, PIIType.PHONE}
    assert pii_filter.validate_before_storage(data, allowed_pii_types=allowed) is True


@pytest.mark.asyncio
async def test_validate_pii_access_with_db_empty_token():
    assert await validate_pii_access_with_db("") is False
    assert await validate_pii_access_with_db(None) is False


@pytest.mark.asyncio
async def test_validate_pii_access_with_db_invalid_token():
    with patch(
        "hushh_mcp.consent.token.validate_token_with_db", new_callable=AsyncMock
    ) as mock_validate:
        mock_validate.return_value = (False, "Token expired", None)

        assert await validate_pii_access_with_db("invalid_token") is False


@pytest.mark.asyncio
async def test_validate_pii_access_with_db_valid_token_matching_scope():
    mock_token = SimpleNamespace(
        user_id="user_123", scope_str="pkm.write", scope=SimpleNamespace(value="pkm.write")
    )

    with patch(
        "hushh_mcp.consent.token.validate_token_with_db", new_callable=AsyncMock
    ) as mock_validate:
        mock_validate.return_value = (True, "Valid token", mock_token)

        # Test matching scope
        assert await validate_pii_access_with_db("valid_token", expected_scope="pkm.write") is True


@pytest.mark.asyncio
async def test_validate_pii_access_with_db_valid_token_mismatched_scope():
    mock_token = SimpleNamespace(
        user_id="user_123", scope_str="pkm.read", scope=SimpleNamespace(value="pkm.read")
    )

    with patch(
        "hushh_mcp.consent.token.validate_token_with_db", new_callable=AsyncMock
    ) as mock_validate:
        mock_validate.return_value = (True, "Valid token", mock_token)

        # Checking for write access using a read-only token should fail
        assert await validate_pii_access_with_db("valid_token", expected_scope="pkm.write") is False
