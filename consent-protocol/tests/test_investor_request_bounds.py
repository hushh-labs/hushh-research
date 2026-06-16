# tests/test_investor_request_bounds.py
"""
Canonical attach point:
  api.routes.investors.create_investor -> POST /api/investors/

Proves that sending a list field with more than the allowed maximum items
returns a 422 Unprocessable Entity validation error rather than being
accepted and forwarded to the database.
"""

import pytest
from pydantic import ValidationError

from api.routes.investors import InvestorCreateRequest


class TestInvestorRequestListBounds:
    """List fields on InvestorCreateRequest must enforce max_length."""

    def test_investment_style_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                investment_style=["GROWTH"] * 1000,
            )

    def test_recent_buys_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                recent_buys=["AAPL"] * 1000,
            )

    def test_recent_sells_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                recent_sells=["TSLA"] * 1000,
            )

    def test_education_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                education=["Harvard"] * 1000,
            )

    def test_board_memberships_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                board_memberships=["Board A"] * 1000,
            )

    def test_peer_investors_rejects_1000_items(self):
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Test Investor",
                peer_investors=["Investor X"] * 1000,
            )

    def test_valid_list_within_bounds_accepted(self):
        req = InvestorCreateRequest(
            name="Valid Investor",
            investment_style=["GROWTH", "VALUE"],
            recent_buys=["AAPL", "MSFT"],
            peer_investors=["Buffett"],
        )
        assert req.name == "Valid Investor"
        assert len(req.investment_style) == 2
