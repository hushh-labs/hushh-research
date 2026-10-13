"""Local analysis engine: exposes Hushh's existing deterministic financial-
math operons (hushh_mcp/operons/kai/calculators.py) as real MCP tools, so
any orchestrator -- Hermes's cloud brain, Kai, or any other MCP client --
can get a precise, non-hallucinated answer for tasks that are really just
math, rather than asking an LLM (local or cloud) to "reason" through it.

Deliberately a thin exposition layer, not a new math implementation: every
tool below calls the real function in
hushh_mcp/operons/kai/calculators.py, which stays the single source of
truth -- the same functions Kai's own agent loop already uses internally.
No consent/HCT gating here: these operons take plain numeric arrays, never
touch vault/PKM data (see calculators.py's own module docstring: "No
consent validation needed - these are just math!"), the same trust tier as
e.g. OneWindows.Daemon's daemon.status tool.

Runs on a fixed port (18183) for the same reason local_bridge does (18182)
and OneWindows.Daemon does (31070): one address an orchestrator configures
once. Loopback-only (FastMCP's default host below) -- never bind 0.0.0.0.
stateless_http=True: no session state to maintain, every call is
independent, matching OneWindows.Daemon's own stateless design.

Run with: python -m local_analysis_engine.server (from backend/, so
hushh_mcp resolves the same way every other backend entrypoint expects).
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from hushh_mcp.operons.kai.calculators import (
    calculate_annualized_return,
    calculate_annualized_volatility,
    calculate_compound_growth,
    calculate_return_and_risk_metrics,
    calculate_sharpe_ratio,
)

ANALYSIS_ENGINE_PORT = 18183

mcp = FastMCP(
    "Hushh Local Analysis Engine",
    host="127.0.0.1",
    port=ANALYSIS_ENGINE_PORT,
    stateless_http=True,
)


@mcp.custom_route("/health", methods=["GET"])
async def health_check(request: Request) -> JSONResponse:
    # A bare GET on the real /mcp endpoint returns 406 (streamable-http
    # requires an SSE Accept header, see MCP SDK's streamable_http.py) and,
    # even satisfied, would open a long-lived SSE stream -- unsuitable for
    # Electron's periodic wait-on/health-poll pattern (see daemon/index.js
    # and local_bridge's own /v1/models probe). This plain route is what
    # Electron's lifecycle module actually polls.
    return JSONResponse({"status": "ok"})


@mcp.tool()
def compound_growth(
    principal: float,
    annual_rate: float,
    years: float,
    contributions_per_year: float = 0.0,
    compounds_per_year: int = 1,
) -> dict[str, float]:
    """Project the future value of an investment under compound interest,
    with optional regular contributions. Use this for ANY multi-step
    compounding/growth-projection question (e.g. "$10,000 at 7% for 20
    years") instead of computing it via free-form reasoning -- this is
    exact, not an approximation.

    annual_rate is a decimal (0.07 for 7%, not 7). contributions_per_year
    is the TOTAL added per year (spread evenly across compounding
    periods). compounds_per_year: 1 = annual, 12 = monthly, 365 = daily.
    """
    return calculate_compound_growth(
        principal=principal,
        annual_rate=annual_rate,
        years=years,
        contributions_per_year=contributions_per_year,
        compounds_per_year=compounds_per_year,
    )


@mcp.tool()
def return_and_risk_metrics(prices: list[float], risk_free_rate: float = 0.05) -> dict[str, float]:
    """Compute annualized return, annualized volatility, and Sharpe ratio
    from a series of daily closing prices (oldest first). Use this for any
    "how has this performed" / risk-adjusted-return question instead of
    estimating it -- these are the exact formulas Kai's own portfolio
    analysis uses internally (AlphaAgents paper methodology).
    """
    return calculate_return_and_risk_metrics(prices, risk_free_rate)


@mcp.tool()
def annualized_return(prices: list[float]) -> float:
    """Annualized cumulative return from a series of daily closing prices
    (oldest first), as a decimal (0.12 = 12%)."""
    return calculate_annualized_return(prices)


@mcp.tool()
def annualized_volatility(prices: list[float]) -> float:
    """Annualized volatility (standard deviation of daily log returns) from
    a series of daily closing prices (oldest first), as a decimal (0.25 =
    25%)."""
    return calculate_annualized_volatility(prices)


@mcp.tool()
def sharpe_ratio(prices: list[float], risk_free_rate: float = 0.05) -> float:
    """Annualized Sharpe ratio from a series of daily closing prices
    (oldest first)."""
    return calculate_sharpe_ratio(prices, risk_free_rate)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
