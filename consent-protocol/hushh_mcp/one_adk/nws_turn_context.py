"""Admit the bounded owner-supplied score projection for the finance head only."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hushh_mcp.one_adk.request_secrets import store_request_secret

STATE_NWS_REPORT = "temp:hussh:nws_report"


class _Factor(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    factor: Literal[
        "solvency", "liquidity_runway", "debt_and_credit", "savings_rate", "investment_mix"
    ]
    baseWeight: Literal[100, 150, 200, 250, 300]
    normalizedScore: float | None = Field(ge=0, le=1)
    pointsContributed: float = Field(ge=0, le=1000)


class _Report(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    policyVersion: Literal["plaid-nws-v1"]
    score: int | None = Field(ge=0, le=1000)
    netWorth: float | None
    history: Literal["unavailable", "provisional", "historical"]
    asOfTimestamp: datetime
    activeWeight: int = Field(ge=0, le=1000)
    completenessMultiplier: float | None = Field(ge=0.85, le=1)
    coverageReasons: list[
        Literal[
            "no_usable_usd_balance_evidence",
            "currency_unavailable",
            "balance_unavailable",
            "holdings_unavailable",
            "history_incomplete",
            "transaction_data_incomplete",
            "cash_only_coverage",
            "debt_details_unavailable",
            "product_consent_missing",
            "product_unsupported",
        ]
    ] = Field(max_length=10)
    factors: list[_Factor] = Field(max_length=5)


def admit_nws_report(forwarded: dict, *, owner_admitted: bool) -> str:
    raw = forwarded.pop("nwsReport", None)
    if not owner_admitted or not isinstance(raw, dict):
        return ""
    try:
        report = _Report.model_validate(raw)
    except ValidationError:
        return ""
    return store_request_secret(report.model_dump_json(), ttl_seconds=240)
