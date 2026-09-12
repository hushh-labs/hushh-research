"""Bounded consumer finance delegation through the existing owner pod.

This adapter deliberately uses the already approved ``cap.one.invoke`` task
seam. It does not call Kai in the MCP gateway, select a provider, create a
queue, or add a second finance router. One remains responsible for specialist
selection and the owner pod remains the execution target.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.consumer_mcp_tasks import ConsumerMcpTask

MAX_TICKER_CHARS = 20
MAX_RISK_PROFILE_CHARS = 32
MAX_CONVERSATION_ID_CHARS = 128
_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")
_RISK_PROFILES = frozenset({"conservative", "balanced", "aggressive"})


class ConsumerFinanceInvalid(ValueError):
    """The external client supplied an invalid finance request."""


@dataclass(frozen=True)
class ConsumerFinanceRequest:
    ticker: str
    risk_profile: str
    conversation_id: str
    timezone: str | None


def validate_finance_request(arguments: dict[str, Any]) -> ConsumerFinanceRequest:
    """Validate a small, provider-neutral finance request."""
    if not isinstance(arguments, dict):
        raise ConsumerFinanceInvalid("finance arguments must be an object")
    allowed = {"ticker", "risk_profile", "conversation_id", "timezone"}
    unexpected = set(arguments) - allowed
    if unexpected:
        raise ConsumerFinanceInvalid(
            "only ticker, risk_profile, conversation_id and timezone are accepted"
        )

    ticker = arguments.get("ticker")
    if not isinstance(ticker, str):
        raise ConsumerFinanceInvalid("ticker is required")
    ticker = ticker.strip().upper()
    if len(ticker) > MAX_TICKER_CHARS or not _TICKER_RE.fullmatch(ticker):
        raise ConsumerFinanceInvalid("ticker must be a valid 1-6 character market symbol")

    risk_profile = arguments.get("risk_profile", "balanced")
    if not isinstance(risk_profile, str):
        raise ConsumerFinanceInvalid("risk_profile is invalid")
    risk_profile = risk_profile.strip().lower() or "balanced"
    if len(risk_profile) > MAX_RISK_PROFILE_CHARS or risk_profile not in _RISK_PROFILES:
        raise ConsumerFinanceInvalid("risk_profile must be conservative, balanced or aggressive")

    conversation_id = arguments.get("conversation_id", "consumer-finance")
    if not isinstance(conversation_id, str):
        raise ConsumerFinanceInvalid("conversation_id is invalid")
    conversation_id = conversation_id.strip()
    if not conversation_id or len(conversation_id) > MAX_CONVERSATION_ID_CHARS:
        raise ConsumerFinanceInvalid("conversation_id is invalid")

    timezone = arguments.get("timezone")
    if timezone is not None:
        if not isinstance(timezone, str) or len(timezone.strip()) > 64:
            raise ConsumerFinanceInvalid("timezone is invalid")
        timezone = timezone.strip() or None

    return ConsumerFinanceRequest(ticker, risk_profile, conversation_id, timezone)


class ConsumerMcpFinance:
    """Execute one fixed finance operation through the owner-pod task seam."""

    def __init__(self, *, task: ConsumerMcpTask | None = None) -> None:
        self._task = task or ConsumerMcpTask()

    async def execute(self, principal: Any, *, arguments: dict[str, Any]) -> dict[str, Any]:
        request = validate_finance_request(arguments)
        # The ticker and risk profile were validated above, so the operation
        # prompt cannot carry arbitrary external instructions. The owner pod
        # still owns One's normal consent, specialist and provider checks.
        message = (
            "Run the private-agent finance analysis operation for ticker "
            f"{request.ticker} using the {request.risk_profile} risk profile. "
            "Use the existing Kai finance specialist and current approved data. "
            "Return analysis only; do not trade, send messages, or mutate connected services."
        )
        result = await self._task.execute(
            principal,
            arguments={
                "message": message,
                "conversation_id": request.conversation_id,
                "timezone": request.timezone,
            },
        )
        return {
            **result,
            "operation": "stock_analysis",
            "ticker": request.ticker,
            "risk_profile": request.risk_profile,
        }


__all__ = [
    "ConsumerFinanceInvalid",
    "ConsumerFinanceRequest",
    "ConsumerMcpFinance",
    "validate_finance_request",
]
