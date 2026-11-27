"""Closed, read-only facts for one owner-authorized portfolio answer."""

from datetime import datetime
from math import isclose
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StringConstraints

PORTFOLIO_CONTEXT_TOOL = "read_portfolio_context"
STATE_PORTFOLIO_CONTEXT_ENABLED = "temp:one_portfolio_context_enabled"
STATE_PORTFOLIO_CONTEXT_PRIVATE = "hussh:portfolio_context_private_invocations"
STATE_NATIVE_PORTFOLIO_READ = "temp:one_native_portfolio_read"
PRIVATE_PORTFOLIO_ANSWER = (
    "A private portfolio answer was shown for that turn. Ask again to read the portfolio."
)


def portfolio_private_invocations(state: Any, events: list[Any]) -> set[str]:
    """Identify portfolio turns that cannot enter derived memory."""
    return set((state or {}).get(STATE_PORTFOLIO_CONTEXT_PRIVATE) or []) | {
        invocation
        for event in events
        for invocation in getattr(getattr(event, "actions", None), "state_delta", {}).get(
            STATE_PORTFOLIO_CONTEXT_PRIVATE, []
        )
    }


PORTFOLIO_CONTEXT_DESCRIPTION = (
    "Read the signed-in owner's saved portfolio facts on their device for this answer only. "
    "Use active for the current saved selection and last_card for a referenced portfolio card. "
    "Choose only the section needed; ticker optionally filters holdings to a named ticker."
)

PORTFOLIO_CONTEXT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "section": {"type": "string", "enum": ["holdings", "allocation", "performance"]},
        "source": {"type": "string", "enum": ["active", "last_card"]},
        "ticker": {"type": "string", "pattern": "^[A-Z0-9][A-Z0-9.\\-]{0,15}$"},
    },
    "required": ["section", "source"],
    "additionalProperties": False,
}

MAX_LEGACY_POSITIONS = 40
MAX_EXPANDED_POSITIONS = 64


def portfolio_context_version(forwarded: dict) -> int:
    legacy = forwarded.pop("portfolioContextContract", None)
    expanded = forwarded.pop("portfolioContextExpanded", None)
    if type(legacy) is not int or legacy != 1:
        return 0
    return 2 if expanded is True else 1


def portfolio_context_parameters(version: int) -> dict[str, Any]:
    if version != 2:
        return PORTFOLIO_CONTEXT_PARAMETERS
    return {
        **PORTFOLIO_CONTEXT_PARAMETERS,
        "properties": {
            **PORTFOLIO_CONTEXT_PARAMETERS["properties"],
            "detail": {"type": "string", "enum": ["expanded"]},
        },
        "required": [*PORTFOLIO_CONTEXT_PARAMETERS["required"], "detail"],
    }


Section = Literal["holdings", "allocation", "performance"]
Source = Literal["active", "last_card"]
Ticker = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9][A-Z0-9.\-]{0,15}$")]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
Label = Annotated[
    str, StringConstraints(min_length=1, max_length=100, pattern=r"^[^\x00-\x1f\x7f]+$")
]
SafeCount = Annotated[int, Field(ge=0, le=100000)]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class _Request(_Closed):
    section: Section
    source: Source
    ticker: Ticker | None = None
    detail: Literal["expanded"] | None = None


class _Holding(_Closed):
    ticker: Ticker | None
    name: Label
    currency: Currency | None
    market_value: FiniteFloat | None


class _Holdings(_Closed):
    positions: list[_Holding] = Field(max_length=MAX_EXPANDED_POSITIONS)
    total_count: SafeCount
    matched_count: SafeCount
    investment_rows: SafeCount | None = None
    unique_tickers: SafeCount | None = None


class _Allocation(_Closed):
    bucket: Literal["Cash", "Equities", "Fixed Income", "Real Assets", "Other", "Receivables"]
    percent: FiniteFloat
    value: Annotated[FiniteFloat, Field(gt=0)] | None = None


class _Performance(_Closed):
    value: FiniteFloat | None
    unrealized_gain: FiniteFloat | None
    unrealized_percent: FiniteFloat | None
    covered: SafeCount
    eligible: SafeCount
    history_available: bool


class _Available(_Closed):
    status: Literal["ok"]
    source: Literal["statement", "plaid"]
    selection: Source
    date_kind: Literal["statement_end", "last_synced", "unknown"]
    as_of: str | None = Field(max_length=30)
    currency: Currency | None
    holdings: _Holdings | None = None
    allocation: list[_Allocation] | None = Field(default=None, max_length=6)
    allocation_total: Annotated[FiniteFloat, Field(gt=0)] | None = None
    performance: _Performance | None = None


class _Unavailable(_Closed):
    status: Literal["unavailable"]
    reason: Literal[
        "source_unavailable", "card_unavailable", "section_unavailable", "portfolio_changed"
    ]


def validate_portfolio_context_request(value: object) -> dict:
    request = _Request.model_validate(value)
    if (
        isinstance(value, dict)
        and "ticker" in value
        and (request.section != "holdings" or request.ticker is None)
    ):
        raise ValueError("Ticker filters apply only to holdings.")
    if isinstance(value, dict) and "detail" in value and request.detail is None:
        raise ValueError("Portfolio detail is invalid.")
    return request.model_dump(exclude_none=True)


def validate_portfolio_context_result(
    request: dict, value: object, *, allow_allocation_values: bool = False
) -> dict:
    if isinstance(value, dict) and value.get("status") == "unavailable":
        return _Unavailable.model_validate(value).model_dump()
    result = _Available.model_validate(value)
    if result.selection != request["source"] or [
        section
        for section in ("holdings", "allocation", "performance")
        if getattr(result, section) is not None
    ] != [request["section"]]:
        raise ValueError("Portfolio context does not match the requested read.")
    has_allocation_values = "allocation_total" in result.model_fields_set or any(
        "value" in row.model_fields_set for row in result.allocation or ()
    )
    if has_allocation_values:
        total = result.allocation_total
        if not (
            allow_allocation_values
            and result.allocation
            and total is not None
            and result.currency is not None
        ):
            raise ValueError("Portfolio allocation values are outside the admitted read.")
        if any(
            row.value is None or not isclose(row.percent, row.value / total * 100, abs_tol=1e-6)
            for row in result.allocation
        ):
            raise ValueError("Portfolio allocation values disagree with the reported percentages.")
    expected_kind = "statement_end" if result.source == "statement" else "last_synced"
    if result.as_of is None:
        if result.date_kind != "unknown":
            raise ValueError("Portfolio observation date is missing.")
    elif result.date_kind != expected_kind:
        raise ValueError("Portfolio observation date has the wrong source.")
    else:
        datetime.fromisoformat(result.as_of.replace("Z", "+00:00"))
    if result.holdings and not (
        len(result.holdings.positions)
        <= result.holdings.matched_count
        <= result.holdings.total_count
    ):
        raise ValueError("Portfolio holding counts are inconsistent.")
    if result.holdings:
        holdings = result.holdings
        counts = {"investment_rows", "unique_tickers"}
        if request.get("detail") != "expanded":
            if len(holdings.positions) > MAX_LEGACY_POSITIONS or counts & holdings.model_fields_set:
                raise ValueError("Legacy portfolio results exceed the admitted detail.")
        elif (
            not counts <= holdings.model_fields_set
            or holdings.investment_rows is None
            or holdings.investment_rows < holdings.total_count
            or (
                holdings.unique_tickers is not None
                and holdings.unique_tickers > holdings.total_count
            )
            or len(holdings.positions) != min(holdings.matched_count, MAX_EXPANDED_POSITIONS)
        ):
            raise ValueError("Expanded portfolio counts are inconsistent.")
    if (
        result.holdings
        and request.get("ticker")
        and any(row.ticker != request["ticker"] for row in result.holdings.positions)
    ):
        raise ValueError("Portfolio holding does not match the requested ticker.")
    if result.performance and result.performance.covered > result.performance.eligible:
        raise ValueError("Portfolio performance coverage is inconsistent.")
    return result.model_dump(exclude_unset=True)
