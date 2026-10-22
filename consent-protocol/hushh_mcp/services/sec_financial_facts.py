"""Pure US-GAAP annual facts extraction; reporting periods precede tag priority."""

from __future__ import annotations

import math
from datetime import date
from typing import Any

FLOW_TAGS = {
    "revenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
    ),
    "net_income": ("NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"),
    "operating_cash_flow": ("NetCashProvidedByUsedInOperatingActivities",),
    "capital_expenditures": (
        "PaymentsToAcquireProductiveAssets",
        "PaymentsToAcquirePropertyPlantAndEquipment",
    ),
    "operating_income": ("OperatingIncomeLoss",),
    "research_and_development": (
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
    ),
}
INSTANT_TAGS = {
    "total_assets": ("Assets",),
    "total_liabilities": ("Liabilities",),
    "current_assets": ("AssetsCurrent",),
    "current_liabilities": ("LiabilitiesCurrent",),
    "long_term_debt": ("LongTermDebtNoncurrent", "LongTermDebt"),
    "current_debt": ("LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"),
    "short_term_borrowings": ("ShortTermBorrowings",),
    "equity": (
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ),
}


def annual_rows(gaap: dict[str, Any], tags: tuple[str, ...], *, flow: bool) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for priority, tag in enumerate(tags):
        for row in gaap.get(tag, {}).get("units", {}).get("USD", []):
            if row.get("form") not in {"10-K", "10-K/A"}:
                continue
            value = row.get("val")
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                continue
            try:
                end = date.fromisoformat(row["end"])
                if flow:
                    duration = (end - date.fromisoformat(row["start"])).days
                    if row.get("fp") != "FY" or not 350 <= duration <= 380:
                        continue
            except (ValueError, KeyError, TypeError):
                continue
            candidate = {**row, "tag": tag, "priority": priority}
            previous = selected.get(end.isoformat())
            # Same period: authored tag priority, then most recent amendment.
            if previous is None or (-priority, row.get("filed", "")) > (
                -previous["priority"],
                previous.get("filed", ""),
            ):
                selected[end.isoformat()] = candidate
    return [selected[end] for end in sorted(selected)]


def extract_annual_facts(payload: dict[str, Any], *, today: date | None = None) -> dict[str, Any]:
    gaap = payload.get("facts", {}).get("us-gaap", {})
    rows = {name: annual_rows(gaap, tags, flow=True) for name, tags in FLOW_TAGS.items()}
    rows.update({name: annual_rows(gaap, tags, flow=False) for name, tags in INSTANT_TAGS.items()})
    # Annual headlines must describe one period; never combine new revenue with old debt.
    revenue_rows = rows["revenue"]
    period = revenue_rows[-1]["end"] if revenue_rows else None
    stale = period is None or ((today or date.today()) - date.fromisoformat(period)).days > 550
    result: dict[str, Any] = {
        "period_end": period,
        "headline_stale": stale,
        "metric_provenance": {},
    }
    for name, candidates in rows.items():
        row = next((r for r in reversed(candidates) if r["end"] == period), None)
        result[name] = row["val"] if row is not None and not stale else None
        if row is not None:
            result["metric_provenance"][name] = {
                key: row.get(key) for key in ("tag", "end", "filed", "accn", "start")
            }
    ocf, capex = result["operating_cash_flow"], result["capital_expenditures"]
    result["free_cash_flow"] = ocf - capex if ocf is not None and capex is not None else None
    result["debt_basis"] = "Reported noncurrent long-term debt; excludes unknown current borrowings"
    for name, output in (
        ("revenue", "revenue_trend"),
        ("net_income", "net_income_trend"),
        ("operating_cash_flow", "ocf_trend"),
        ("research_and_development", "rnd_trend"),
    ):
        # A restatement of a prior period replaces that period, not its fiscal label.
        trend = rows[name][-4:]
        consecutive = []
        for row in reversed(trend):
            if consecutive:
                days = (
                    date.fromisoformat(consecutive[-1]["end"]) - date.fromisoformat(row["end"])
                ).days
                if not 350 <= days <= 380:
                    break
            consecutive.append(
                {"year": int(row["end"][:4]), "end": row["end"], "value": row["val"]}
            )
        result[output] = list(reversed(consecutive))
    return result
