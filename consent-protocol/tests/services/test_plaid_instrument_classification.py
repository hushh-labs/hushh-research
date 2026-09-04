"""Unit tests for PlaidPortfolioService security/instrument classification.

Regression coverage for a real bug found while testing against live Plaid
sandbox payloads: securities Plaid explicitly flags as ``is_cash_equivalent``
(e.g. cryptocurrency sweep vehicles, cash positions) were falling through to
"other" because the classifier only used string heuristics and ignored
Plaid's own authoritative flag.
"""

from hushh_mcp.services.plaid_portfolio_service import PlaidPortfolioService


def _service() -> PlaidPortfolioService:
    return PlaidPortfolioService()


def test_plaid_flagged_cash_equivalent_cryptocurrency_is_cash_equivalent():
    svc = _service()
    security = {"type": "cryptocurrency", "subtype": None, "is_cash_equivalent": True}
    assert svc._instrument_kind(security, symbol="BTC", name="Bitcoin") == "cash_equivalent"
    assert svc._is_cash_equivalent(security, symbol="BTC", name="Bitcoin") is True


def test_plaid_flagged_cash_equivalent_cash_type_is_cash_equivalent():
    svc = _service()
    security = {"type": "cash", "subtype": None, "is_cash_equivalent": True}
    assert svc._instrument_kind(security, symbol="USD", name="U S Dollar") == "cash_equivalent"


def test_unflagged_cryptocurrency_is_treated_as_real_asset():
    svc = _service()
    security = {"type": "cryptocurrency", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="ETH", name="Ethereum") == "real_asset"


def test_equity_security_is_equity():
    svc = _service()
    security = {"type": "equity", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="AAPL", name="Apple Inc.") == "equity"
    assert svc._is_equity_like(security) is True


def test_etf_security_is_equity_and_equity_like():
    svc = _service()
    security = {"type": "etf", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="SPY", name="SPDR S&P 500 ETF") == "equity"
    assert svc._is_equity_like(security) is True


def test_mutual_fund_is_equity_but_not_equity_like():
    svc = _service()
    security = {"type": "mutual fund", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="FUND", name="Some Fund") == "equity"
    assert svc._is_equity_like(security) is False


def test_fixed_income_security_is_fixed_income():
    svc = _service()
    security = {"type": "fixed income", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="BOND", name="US Treasury Bill") == "fixed_income"


def test_derivative_security_defaults_to_other():
    svc = _service()
    security = {"type": "derivative", "subtype": None, "is_cash_equivalent": False}
    assert svc._instrument_kind(security, symbol="OPT", name="Nflx Feb Call") == "other"
