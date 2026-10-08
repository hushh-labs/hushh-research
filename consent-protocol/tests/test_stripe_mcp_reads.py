"""Closed Stripe read/profile contracts using synthetic provider receipts."""

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpError
from tests.test_governed_mcp_toolset import _owner_context, _tool
from tests.test_governed_mcp_toolset import native_ok as native_ok
from tests.test_stripe_mcp_admission import _stripe_toolset


def _account_read_catalog():
    """Synthetic reviewed profile, not evidence of the hosted provider schema."""
    from hushh_mcp.services.stripe_mcp_reads import (
        ACCOUNT_TOOL,
        BALANCE_TOOL,
        stripe_read_arguments,
    )

    tools = []
    for name in (ACCOUNT_TOOL, BALANCE_TOOL):
        arguments = stripe_read_arguments(name, "acct_synthetic")
        tool = _tool(name, SimpleNamespace(readOnlyHint=True))
        tool.inputSchema = {
            "type": "object",
            "properties": {key: {} for key in arguments},
            "required": list(arguments),
            "additionalProperties": False,
        }
        tools.append(tool)
    return tools


def _account_receipts():
    return [
        {
            "object": "account",
            "id": "acct_synthetic",
            "country": "US",
            "default_currency": "usd",
            "charges_enabled": True,
            "payouts_enabled": True,
            "email": "private@example.invalid",
        },
        {
            "object": "balance",
            "livemode": False,
            "available": [{"currency": "usd", "amount": 123}],
            "pending": [{"currency": "usd", "amount": -5}],
            "secret": "must-not-project",
        },
    ]


@pytest.fixture
def pinned_stripe(monkeypatch):
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "acct_synthetic")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_LIVEMODE", "false")


@pytest.mark.parametrize("text_receipt", [False, True])
async def test_explicit_verification_requires_paired_current_reads_and_projects_only_safe_fields(
    pinned_stripe,
    native_ok,
    text_receipt,
):
    from hushh_mcp.one_adk.stripe_mcp_verification import verify_stripe_account

    payloads = _account_receipts()
    native_ok.side_effect = [
        {"content": [{"type": "text", "text": json.dumps(payload)}]}
        if text_receipt
        else {"content": [], "structuredContent": payload}
        for payload in payloads
    ]
    toolset, approval, _ = _stripe_toolset(
        _account_read_catalog(), headers={"Authorization": "Bearer oauth-fixture-token"}
    )
    try:
        await toolset.get_tools(_owner_context())
        native_ok.assert_not_awaited()  # Discovery never verifies an account.
        result = await verify_stripe_account(toolset, _owner_context())
        assert result["account"] == {
            "accountId": "acct_synthetic",
            "country": "US",
            "defaultCurrency": "usd",
            "chargesEnabled": True,
            "payoutsEnabled": True,
        }
        assert result["balance"] == {
            "currency": "usd",
            "livemode": False,
            "availableCents": 123,
            "pendingCents": -5,
        }
        assert result["catalogFingerprint"] == toolset._catalog_digest
        assert toolset.stripe_proof and result["verifiedAt"]
        assert "private@example" not in repr(result) and "must-not-project" not in repr(result)
        calls = native_ok.await_args_list
        assert len(calls) == 2
        assert calls[1].kwargs["args"] == {
            "stripe_context": "acct_synthetic",
            "livemode": False,
            "stripe_api_operation_id": "GetBalance",
            "parameters": {},
        }
        approval.assert_not_awaited()
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    "extra",
    [
        {"stripe_api_operation_id": "GetCustomers"},
        {"parameters": {"expand": ["data"]}},
        {"stripe_context": "acct_other"},
        {"livemode": True},
        {"headers": {}},
        {"path": "/v1/customers"},
        {"method": "POST"},
    ],
)
async def test_balance_read_rejects_all_nonliteral_arguments_before_dispatch(
    pinned_stripe, native_ok, extra
):
    from hushh_mcp.services.stripe_mcp_reads import BALANCE_TOOL, stripe_read_arguments

    toolset, _, _ = _stripe_toolset(
        _account_read_catalog(), headers={"Authorization": "Bearer oauth-fixture-token"}
    )
    try:
        tools = await toolset.get_tools(_owner_context())
        balance = next(tool for tool in tools if tool.descriptor["name"] == BALANCE_TOOL)
        result = await balance.run_async(
            args={**stripe_read_arguments(BALANCE_TOOL, "acct_synthetic"), **extra},
            tool_context=_owner_context(),
        )
        assert result.get("status") != "ok" and result.get("error")
        assert toolset.stripe_proof is None
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    "mutation", ["account", "live", "bool_amount", "duplicate_usd", "missing_usd", "error"]
)
async def test_unverifiable_provider_receipts_never_mint_account_proof(
    pinned_stripe, native_ok, mutation
):
    from hushh_mcp.one_adk.stripe_mcp_verification import verify_stripe_account

    payloads = _account_receipts()
    if mutation == "account":
        payloads[0]["id"] = "acct_other"
    elif mutation == "live":
        payloads[1]["livemode"] = True
    elif mutation == "bool_amount":
        payloads[1]["available"][0]["amount"] = True
    elif mutation == "duplicate_usd":
        payloads[1]["available"] *= 2
    elif mutation == "missing_usd":
        payloads[1]["available"] = []
    receipts = [{"content": [], "structuredContent": payload} for payload in payloads]
    if mutation == "error":
        receipts[0]["isError"] = True
    native_ok.side_effect = receipts
    toolset, _, _ = _stripe_toolset(
        _account_read_catalog(), headers={"Authorization": "Bearer oauth-fixture-token"}
    )
    try:
        with pytest.raises(ExternalMcpError):
            await verify_stripe_account(toolset, _owner_context())
        assert toolset.stripe_proof is None
    finally:
        await toolset.close()


@pytest.mark.parametrize("mutation", ["credential", "catalog", "environment", "review"])
async def test_verification_cannot_survive_authority_changes_or_bypass_review(
    pinned_stripe, native_ok, monkeypatch, mutation
):
    from hushh_mcp.one_adk.stripe_mcp_verification import verify_stripe_account

    toolset, approval, session = _stripe_toolset(
        _account_read_catalog(), headers={"Authorization": "Bearer oauth-fixture-token"}
    )
    if mutation == "review":
        toolset.review_policy = "always"
        toolset.resolve_connection.return_value = replace(
            toolset.resolve_connection.return_value, review_policy="always"
        )

    async def provider(**_):
        if mutation == "credential":
            toolset.resolve_connection.return_value = replace(
                toolset.resolve_connection.return_value,
                headers={"Authorization": "Bearer rotated-synthetic"},
            )
        elif mutation == "catalog":
            session.list_tools.return_value.tools[0].inputSchema["description"] = "changed"
        elif mutation == "environment":
            monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_LIVEMODE", "true")
        return {"content": [], "structuredContent": _account_receipts()[0]}

    native_ok.side_effect = provider
    try:
        with pytest.raises(ExternalMcpError):
            await verify_stripe_account(toolset, _owner_context())
        assert toolset.stripe_proof is None
        assert native_ok.await_count == (0 if mutation == "review" else 1)
        approval.assert_not_awaited()
    finally:
        await toolset.close()


@pytest.mark.parametrize("forced_companion", [False, True])
async def test_exact_approved_read_does_not_authorize_a_required_companion(
    pinned_stripe, native_ok, forced_companion
):
    from hushh_mcp.services.stripe_mcp_reads import (
        ACCOUNT_TOOL,
        BALANCE_TOOL,
        stripe_read_arguments,
    )

    toolset, approval, _ = _stripe_toolset(
        _account_read_catalog(), headers={"Authorization": "Bearer oauth-fixture-token"}
    )
    try:
        tools = await toolset.get_tools(_owner_context())
        account = next(tool for tool in tools if tool.descriptor["name"] == ACCOUNT_TOOL)
        balance = next(tool for tool in tools if tool.descriptor["name"] == BALANCE_TOOL)
        forced = frozenset({account.name, balance.name} if forced_companion else {account.name})
        toolset.forced_review_tool_ids = forced
        toolset.resolve_connection.return_value = replace(
            toolset.resolve_connection.return_value, forced_review_tool_ids=forced
        )
        approval.return_value = None  # Existing exact-call receipt admitted and consumed.
        native_ok.side_effect = [
            {"content": [], "structuredContent": payload} for payload in _account_receipts()
        ]
        result = await account.run_async(
            args=stripe_read_arguments(ACCOUNT_TOOL, "acct_synthetic"),
            tool_context=_owner_context(),
        )
        approval.assert_awaited_once()
        if forced_companion:
            assert result["error"] == "MCP_STRIPE_REVIEW_REQUIRED"
            assert toolset.stripe_proof is None
            native_ok.assert_not_awaited()
        else:
            assert result["status"] == "ok" and result["stripeReadiness"]["accountVerified"]
            assert native_ok.await_count == 2
    finally:
        await toolset.close()
