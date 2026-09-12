"""The consumer finance adapter remains bounded and owner-pod backed."""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.consumer_mcp_finance import (
    ConsumerFinanceInvalid,
    ConsumerMcpFinance,
    validate_finance_request,
)


def test_validate_finance_request_rejects_provider_and_unbounded_symbols() -> None:
    request = validate_finance_request({"ticker": " aapl ", "risk_profile": "BALANCED"})
    assert request.ticker == "AAPL"
    assert request.risk_profile == "balanced"
    assert request.conversation_id == "consumer-finance"

    with pytest.raises(ConsumerFinanceInvalid, match="only ticker"):
        validate_finance_request({"ticker": "AAPL", "runtime_provider": "puppy"})
    with pytest.raises(ConsumerFinanceInvalid, match="valid 1-6"):
        validate_finance_request({"ticker": "AAPL-TOO-LONG"})
    with pytest.raises(ConsumerFinanceInvalid, match="risk_profile"):
        validate_finance_request({"ticker": "AAPL", "risk_profile": "day-trader"})


@pytest.mark.asyncio
async def test_finance_delegates_fixed_operation_through_owner_task() -> None:
    calls: list[dict] = []

    class Task:
        async def execute(self, principal, *, arguments):
            calls.append({"principal": principal, "arguments": arguments})
            return {
                "state": "completed",
                "execution_target": "owner_pod",
                "deployment_id": "pod_a",
                "conversation_id": "mcp-conversation",
                "response": "A bounded analysis",
                "runtime_mode": "owner-pod",
                "provider": "pod",
                "model": "resident-model",
                "delegation": {"delegated": True},
            }

    principal = SimpleNamespace(subject_firebase_uid="owner_a")
    result = await ConsumerMcpFinance(task=Task()).execute(
        principal,
        arguments={"ticker": "MSFT", "risk_profile": "conservative", "conversation_id": "c1"},
    )

    assert result["operation"] == "stock_analysis"
    assert result["ticker"] == "MSFT"
    assert result["risk_profile"] == "conservative"
    assert result["execution_target"] == "owner_pod"
    assert calls[0]["arguments"]["conversation_id"] == "c1"
    assert "MSFT" in calls[0]["arguments"]["message"]
    assert "do not trade" in calls[0]["arguments"]["message"]
    assert "runtime_provider" not in calls[0]["arguments"]
