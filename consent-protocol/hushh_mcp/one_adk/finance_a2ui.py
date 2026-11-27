# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Compose Finance offers for native Chat without accepting model-authored layouts."""

from __future__ import annotations

import os
import re
from typing import Any, Literal
from uuid import uuid4

from google.adk.tools import ToolContext

from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.native_chat_output import STATE_NATIVE_VISUAL_CHAT
from hushh_mcp.one_adk.state_keys import STATE_USER_ID

STATE_DEV_FINANCE_VISUALS = "temp:one_dev_finance_visuals"

FinanceComponent = Literal[
    "SavedPortfolio",
    "MarketSnapshot",
    "FinanceStockPreview",
    "FinancePortfolioUpload",
    "FinancePortfolioPicker",
    "FinancePlaidConnection",
    "FinanceShareProposal",
]

_CHOICE_FIELDS = {
    "SavedPortfolio": ("section", frozenset({"holdings", "allocation", "performance", "sources"})),
    "MarketSnapshot": ("view", frozenset({"gainers", "losers", "movers"})),
    "FinancePortfolioPicker": ("mode", frozenset({"switch", "delete"})),
    "FinanceShareProposal": ("audience", frozenset({"connection", "verified_advisor"})),
}
_EMPTY_OFFERS = frozenset({"FinancePortfolioUpload", "FinancePlaidConnection"})
_TICKER = re.compile(r"[A-Z0-9][A-Z0-9.-]{0,15}")


def dev_finance_presentation_enabled() -> bool:
    """Use the closed Finance presenter only in the Dev runtime."""
    return os.getenv("HUSHH_DEPLOY_ENV", "").strip().lower() == "dev"


def send_a2ui_json_to_client(
    component: FinanceComponent,
    tool_context: ToolContext,
    section: Literal["holdings", "allocation", "performance", "sources"] | None = None,
    view: Literal["gainers", "losers", "movers"] | None = None,
    ticker: str | None = None,
    mode: Literal["switch", "delete"] | None = None,
    audience: Literal["connection", "verified_advisor"] | None = None,
) -> dict[str, Any]:
    """Show one Finance surface. Supply only the field required by the named component.

    SavedPortfolio needs section, MarketSnapshot needs view, FinanceStockPreview needs
    ticker, FinancePortfolioPicker needs mode, and FinanceShareProposal needs audience.
    FinancePortfolioUpload and FinancePlaidConnection take no additional fields.
    Interactive surfaces only offer the app's review or picker.
    """
    state = tool_context.state
    if (
        tool_context.agent_name != "one"
        or state.get(STATE_NATIVE_VISUAL_CHAT) is not True
        or state.get(STATE_DEV_FINANCE_VISUALS) is not True
        or state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
        or not state.get(STATE_USER_ID)
        or not state.get("hussh:consent_token")
    ):
        return {"status": "unavailable"}

    if not isinstance(component, str):
        return {"status": "invalid_finance_surface"}

    fields = {
        key: value
        for key, value in {
            "section": section,
            "view": view,
            "ticker": ticker,
            "mode": mode,
            "audience": audience,
        }.items()
        if value is not None
    }
    if component in _CHOICE_FIELDS:
        key, choices = _CHOICE_FIELDS[component]
        selection = fields.get(key)
        valid = fields.keys() == {key} and isinstance(selection, str) and selection in choices
    elif component == "FinanceStockPreview":
        valid = (
            fields.keys() == {"ticker"}
            and isinstance(ticker, str)
            and bool(_TICKER.fullmatch(ticker))
        )
    else:
        valid = component in _EMPTY_OFFERS and not fields
    if not valid:
        return {"status": "invalid_finance_surface"}

    # Use the existing A2UI wire name so the settled ADK projector and encrypted
    # history scrubber treat these offers exactly like other A2UI receipts.
    return {
        "status": "card_offered",
        "validated_a2ui_json": [
            {
                "version": "1.0",
                "createSurface": {
                    "surfaceId": uuid4().hex,
                    "catalogId": "hussh.ai:morphy-one/v1",
                    "components": [{"id": "root", "component": component, **fields}],
                },
            }
        ],
    }
