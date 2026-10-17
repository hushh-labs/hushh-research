"""Public paid MCP projections preserve human confirmation and ciphertext delivery."""

from __future__ import annotations

import json

import jsonschema
import pytest

from mcp_modules.flat_projection import project_flat_result
from mcp_modules.public_contract import get_public_contract
from mcp_modules.tools import public_tools_v3 as tools
from tests.mcp_public_contract_harness import (
    _hosted_crypto as _hosted_crypto,
)
from tests.mcp_public_contract_harness import (
    _install_client as _install_client,
)
from tests.mcp_public_contract_harness import (
    _payload as _payload,
)


@pytest.mark.asyncio
async def test_paid_consent_projects_human_confirmation_without_grant_or_private_fields(
    monkeypatch,
):
    calls: list[dict] = []
    _install_client(
        monkeypatch,
        {
            "status": "pending",
            "request_ref": "req_" + "0" * 28,
            "quote_ref": "sq_" + "1" * 32,
            "price_cents": 1,
            "currency": "usd",
            "consent_state": "approved",
            "payment_state": "awaiting_payment",
            "access_state": "inactive",
            "human_action_url": "https://uat.one.hushh.ai/one/consent?commerceRequestId=req_"
            + "0" * 28,
            "payer_user_id": "must-not-pass-through",
            "consent_token": "must-not-pass-through",
        },
        calls,
    )
    monkeypatch.setattr(tools, "is_local_stdio_transport", lambda: False)
    payload = _payload(
        await tools.handle_request_consent(
            {
                "user_identifier": "private@example.com",
                "scope": "attr.financial.portfolio.*",
                "purpose": "Review approved portfolio information.",
                "offer_amount": 0.01,
                "settlement_ref": "unverified-receipt",
            }
        )
    )
    assert payload["status"] == "pending"
    assert payload["price_cents"] == 1
    assert "grant_ref" not in payload
    assert "must-not-pass-through" not in json.dumps(payload)
    assert calls[0]["json"]["offer"]["settlement_ref"] == "unverified-receipt"
    flat = project_flat_result("request_consent", payload)
    output_schema = next(
        tool["outputSchema"]
        for tool in get_public_contract()["tools"]
        if tool["name"] == "request-consent"
    )
    jsonschema.validate(flat, output_schema)


@pytest.mark.asyncio
async def test_paid_status_does_not_advertise_grant_before_activation(monkeypatch):
    _install_client(
        monkeypatch,
        {
            "status": "granted",
            "grant_ref": "req_" + "0" * 28,
            "quote_ref": "sq_" + "1" * 32,
            "price_cents": 1,
            "access_state": "armed",
            "consent_state": "approved",
            "payment_state": "consumed",
        },
        [],
    )
    result = _payload(await tools.handle_check_consent_status({"request_ref": "req_" + "0" * 28}))
    assert result["status"] == "pending"
    assert result["grant_ref"] is None
    assert result["poll_after_seconds"] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("paid", [False, True])
async def test_local_stdio_uses_transport_specific_decryption(monkeypatch, paid) -> None:
    calls: list[dict] = []
    _install_client(
        monkeypatch,
        {
            "status": "success",
            "granted_scope": "attr.financial.portfolio.*",
            "expires_at": 9999999999999,
            "export_revision": 2,
            "encrypted_data": "ZmFrZQ==",
            "commercial_required": paid,
            **_hosted_crypto(),
        },
        calls,
    )
    monkeypatch.setattr(tools, "is_local_stdio_transport", lambda: True)

    async def _decrypted_response(*_args, **_kwargs):
        assert not paid, "Paid information must not enter MCP model context"
        return {"data": {"summary": "approved"}}, None

    monkeypatch.setattr(tools, "_try_build_local_decrypted_response", _decrypted_response)
    result = _payload(
        await tools.handle_get_encrypted_scoped_export(
            {
                "grant_ref": "req_0123456789abcdef0123456789ab",
                "expected_scope": "attr.financial.portfolio.*",
            }
        )
    )
    assert result["delivery"] == ("encrypted_inline" if paid else "decrypted_local")
    assert result["ciphertext"] == ("ZmFrZQ==" if paid else None)
    assert result["information"] == (None if paid else {"summary": "approved"})
