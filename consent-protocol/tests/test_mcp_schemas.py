import os
import sys

# Ensure root directory is in sys.path before importing mcp_server
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import json
from unittest.mock import AsyncMock, patch

import pytest
from mcp.types import TextContent

from mcp_server import call_tool


@pytest.mark.asyncio
async def test_mcp_call_tool_validation_success():
    # Mock a handler to verify it gets called with valid schema-validated/filled arguments
    mock_handler = AsyncMock(return_value=[TextContent(type="text", text="ok")])

    with (
        patch("mcp_server.HANDLERS", {"validate_token": mock_handler}),
        patch("mcp_server.is_tool_allowed", return_value=True),
    ):
        # validate_token takes: token (str, required), expected_scope (str, optional)
        arguments = {"token": "HCT:mock_token_signature", "expected_scope": "pkm.read"}

        result = await call_tool("validate_token", arguments)
        assert len(result) == 1
        assert result[0].text == "ok"

        # Verify the handler was invoked with the exact arguments
        mock_handler.assert_called_once_with(
            {"token": "HCT:mock_token_signature", "expected_scope": "pkm.read"}
        )


@pytest.mark.asyncio
async def test_mcp_call_tool_validation_failure_missing_required():
    with patch("mcp_server.is_tool_allowed", return_value=True):
        # validate_token requires 'token'
        arguments = {"expected_scope": "pkm.read"}

        result = await call_tool("validate_token", arguments)
        assert len(result) == 1
        payload = json.loads(result[0].text)
        assert payload["status"] == "error"
        assert (
            "validation" in payload["error"].lower()
            or "missing" in payload["error"].lower()
            or "Field required" in payload["error"]
        )


@pytest.mark.asyncio
async def test_mcp_call_tool_validation_failure_invalid_wrapping_algorithm():
    with patch("mcp_server.is_tool_allowed", return_value=True):
        # request_consent takes connector_wrapping_alg, which must be "X25519-AES256-GCM"
        arguments = {
            "user_id": "user-123",
            "connector_public_key": "base64key",
            "connector_key_id": "key-id-abc",
            "connector_wrapping_alg": "AES-128",  # Invalid
        }

        result = await call_tool("request_consent", arguments)
        assert len(result) == 1
        payload = json.loads(result[0].text)
        assert payload["status"] == "error"
        assert "Unsupported wrapping algorithm" in payload["error"]


@pytest.mark.asyncio
async def test_mcp_call_tool_validation_offer_constraints():
    with patch("mcp_server.is_tool_allowed", return_value=True):
        # request_consent takes an optional offer payload.
        # offer.bid_amount must be positive and currency must be 3-character string.
        arguments = {
            "user_id": "user-123",
            "connector_public_key": "base64key",
            "connector_key_id": "key-id-abc",
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "offer": {
                "bid_amount": -10.0,  # Invalid negative bid
                "currency": "USD",
            },
        }

        result = await call_tool("request_consent", arguments)
        assert len(result) == 1
        payload = json.loads(result[0].text)
        assert payload["status"] == "error"
        assert "validation" in payload["error"].lower() or "greater than 0" in payload["error"]


@pytest.mark.asyncio
async def test_mcp_call_tool_kai_analyze_stock_identifier_rule():
    mock_handler = AsyncMock(return_value=[TextContent(type="text", text="ok")])
    with (
        patch("mcp_server.HANDLERS", {"kai_analyze_stock": mock_handler}),
        patch("mcp_server.is_tool_allowed", return_value=True),
    ):
        # kai_analyze_stock requires at least one identifier key (symbol, ticker, target, query)
        # Passing valid symbol:
        result_valid = await call_tool("kai_analyze_stock", {"symbol": "AAPL"})
        assert len(result_valid) == 1
        assert result_valid[0].text == "ok"

        # Passing no identifiers:
        result_invalid = await call_tool("kai_analyze_stock", {"analysis_type": "full"})
        assert len(result_invalid) == 1
        payload = json.loads(result_invalid[0].text)
        assert payload["status"] == "error"
        assert "Must provide at least one of" in payload["error"]
