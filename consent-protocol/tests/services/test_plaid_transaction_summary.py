"""Unit tests for PlaidPortfolioService._summarize_transactions.

Regression coverage for real bugs found while testing against live Plaid
sandbox investment transaction payloads:

1. Plaid's ``amount`` sign convention is inverted from what we want to
   report: positive = cash left the account (buy), negative = cash entered
   (sell, dividend, interest, cash contribution/deposit). The old code added
   these raw amounts directly, producing negative "income" and negative
   "net contributions" for perfectly normal activity.
2. Standalone fee transactions (``type == "fee"``, e.g. account maintenance
   fees) carry their charge in ``amount``, not in the per-trade ``fees``
   field (which is 0 for these rows). The old code only summed ``fees`` and
   silently dropped every standalone account fee.
"""

from hushh_mcp.services.plaid_portfolio_service import PlaidPortfolioService


def _service() -> PlaidPortfolioService:
    return PlaidPortfolioService()


def test_dividend_amount_is_reported_as_positive_income():
    svc = _service()
    transactions = [
        {"type": "cash", "subtype": "dividend", "amount": -8.72, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["dividends_taxable"] == 8.72
    assert summary["total_income"] == 8.72


def test_interest_amount_is_reported_as_positive_income():
    svc = _service()
    transactions = [
        {"type": "cash", "subtype": "interest", "amount": -0.1, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["interest_income"] == 0.1


def test_standalone_fee_transaction_is_counted_from_amount():
    svc = _service()
    transactions = [
        {"type": "fee", "subtype": "account fee", "amount": 3.0, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["total_fees"] == 3.0


def test_per_trade_fee_field_still_counted_alongside_standalone_fees():
    svc = _service()
    transactions = [
        {"type": "buy", "subtype": "buy", "amount": 466.71, "fees": 1.95},
        {"type": "fee", "subtype": "account fee", "amount": 3.0, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["total_fees"] == 4.95


def test_contribution_amount_is_reported_as_positive_net_contribution():
    svc = _service()
    transactions = [
        {"type": "cash", "subtype": "contribution", "amount": -1200.0, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["net_contributions"] == 1200.0


def test_withdrawal_reduces_net_contributions():
    svc = _service()
    transactions = [
        {"type": "cash", "subtype": "contribution", "amount": -1000.0, "fees": 0},
        {"type": "cash", "subtype": "withdrawal", "amount": 200.0, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["net_contributions"] == 800.0


def test_buy_and_sell_gross_amounts_are_absolute():
    svc = _service()
    transactions = [
        {"type": "buy", "subtype": "buy", "amount": 100.0, "fees": 0},
        {"type": "sell", "subtype": "sell", "amount": -50.0, "fees": 0},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["gross_buys"] == 100.0
    assert summary["gross_sells"] == 50.0


def test_realistic_sandbox_batch_matches_expected_totals():
    """End-to-end regression against a shape matching real Plaid sandbox data."""
    svc = _service()
    transactions = [
        {"type": "cash", "subtype": "dividend", "amount": -8.72, "fees": 0},
        {"type": "cash", "subtype": "interest", "amount": -0.1, "fees": 0},
        {"type": "fee", "subtype": "account fee", "amount": 3.0, "fees": 0},
        {"type": "cash", "subtype": "contribution", "amount": -1200.0, "fees": 0},
        {"type": "buy", "subtype": "buy", "amount": 466.71, "fees": 1.95},
        {"type": "sell", "subtype": "sell", "amount": -1289.01, "fees": 7.99},
    ]
    summary = svc._summarize_transactions(transactions)
    assert summary["dividends_taxable"] == 8.72
    assert summary["interest_income"] == 0.1
    assert summary["total_income"] == 8.82
    assert summary["total_fees"] == 12.94
    assert summary["net_contributions"] == 1200.0
    assert summary["gross_buys"] == 466.71
    assert summary["gross_sells"] == 1289.01
