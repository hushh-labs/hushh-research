# tests/test_investors_tickers_marketplace_bounds_cwe400.py
"""
Comprehensive bounds validation tests for investor, ticker, and marketplace models (CWE-400).

Tests validate that all string and list fields in investor/ticker/marketplace request/response
models enforce max_length constraints, preventing resource exhaustion attacks through
unbounded input fields or service output manipulation.
"""

import pytest
from pydantic import ValidationError

from api.routes.investors import (
    InvestorCreateRequest,
    InvestorProfile,
    InvestorSearchResult,
)
from api.routes.marketplace import (
    MarketplaceContactLookup,
    MarketplaceContactMatchRequest,
    MarketplaceInvestorActionRequest,
)
from api.routes.tickers import SyncHoldingsRequest


class TestInvestorSearchResultBounds:
    """Tests for InvestorSearchResult field bounds (CWE-400)."""

    def test_name_max_length_256(self):
        """Test that name enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorSearchResult(id=1, name="a" * 257)

    def test_firm_max_length_256(self):
        """Test that firm enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorSearchResult(id=1, name="Valid", firm="a" * 257)

    def test_title_max_length_256(self):
        """Test that title enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorSearchResult(id=1, name="Valid", title="a" * 257)

    def test_investor_type_max_length_128(self):
        """Test that investor_type enforces max_length=128."""
        with pytest.raises(ValidationError):
            InvestorSearchResult(id=1, name="Valid", investor_type="a" * 129)

    def test_investment_style_list_bounded_20(self):
        """Test that investment_style list enforces max_length=20."""
        with pytest.raises(ValidationError):
            InvestorSearchResult(
                id=1,
                name="Valid",
                investment_style=["style" + str(i) for i in range(21)],
            )

    def test_valid_search_result(self):
        """Test that valid search result passes."""
        result = InvestorSearchResult(
            id=1, name="Warren Buffett", firm="Berkshire", investor_type="fund_manager"
        )
        assert result.id == 1
        assert result.name == "Warren Buffett"


class TestInvestorProfileBounds:
    """Tests for InvestorProfile field bounds (CWE-400)."""

    def test_name_max_length_256(self):
        """Test that name enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorProfile(id=1, name="a" * 257)

    def test_firm_max_length_256(self):
        """Test that firm enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorProfile(id=1, name="Valid", firm="a" * 257)

    def test_biography_max_length_10000(self):
        """Test that biography enforces max_length=10000."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1, name="Valid", biography="a" * 10001
            )

    def test_photo_url_max_length_1024(self):
        """Test that photo_url enforces max_length=1024."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1, name="Valid", photo_url="https://" + "a" * 1024
            )

    def test_education_list_bounded_50(self):
        """Test that education list enforces max_length=50."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1,
                name="Valid",
                education=["school" + str(i) for i in range(51)],
            )

    def test_recent_buys_list_bounded_100(self):
        """Test that recent_buys list enforces max_length=100."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1,
                name="Valid",
                recent_buys=["symbol" + str(i) for i in range(101)],
            )

    def test_recent_sells_list_bounded_100(self):
        """Test that recent_sells list enforces max_length=100."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1,
                name="Valid",
                recent_sells=["symbol" + str(i) for i in range(101)],
            )

    def test_top_holdings_list_bounded_500(self):
        """Test that top_holdings list enforces max_length=500."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1,
                name="Valid",
                top_holdings=[{"symbol": f"SYM{i}"} for i in range(501)],
            )

    def test_board_memberships_list_bounded_50(self):
        """Test that board_memberships list enforces max_length=50."""
        with pytest.raises(ValidationError):
            InvestorProfile(
                id=1,
                name="Valid",
                board_memberships=["board" + str(i) for i in range(51)],
            )

    def test_valid_profile(self):
        """Test that valid profile passes."""
        profile = InvestorProfile(
            id=1,
            name="Warren Buffett",
            firm="Berkshire",
            biography="One of the world's greatest investors",
        )
        assert profile.id == 1
        assert profile.name == "Warren Buffett"


class TestInvestorCreateRequestBounds:
    """Tests for InvestorCreateRequest field bounds (CWE-400)."""

    def test_name_max_length_256(self):
        """Test that name enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="a" * 257)

    def test_firm_max_length_256(self):
        """Test that firm enforces max_length=256."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="Valid", firm="a" * 257)

    def test_biography_max_length_10000(self):
        """Test that biography enforces max_length=10000."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Valid", biography="a" * 10001
            )

    def test_education_list_bounded_50(self):
        """Test that education list enforces max_length=50."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Valid",
                education=["school" + str(i) for i in range(51)],
            )

    def test_recent_buys_list_bounded_100(self):
        """Test that recent_buys list enforces max_length=100."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Valid",
                recent_buys=["symbol" + str(i) for i in range(101)],
            )

    def test_peer_investors_list_bounded_100(self):
        """Test that peer_investors list enforces max_length=100."""
        with pytest.raises(ValidationError):
            InvestorCreateRequest(
                name="Valid",
                peer_investors=["peer" + str(i) for i in range(101)],
            )

    def test_valid_create_request(self):
        """Test that valid create request passes."""
        req = InvestorCreateRequest(
            name="John Smith",
            firm="Capital Partners",
            biography="Experienced investor",
        )
        assert req.name == "John Smith"
        assert req.firm == "Capital Partners"


class TestSyncHoldingsRequestBounds:
    """Tests for SyncHoldingsRequest field bounds (CWE-400)."""

    def test_holdings_list_bounded_10000(self):
        """Test that holdings list enforces max_length=10000."""
        with pytest.raises(ValidationError):
            SyncHoldingsRequest(
                holdings=[{"symbol": f"SYM{i}"} for i in range(10001)],
            )

    def test_max_symbols_bounded_1000(self):
        """Test that max_symbols enforces le=1000."""
        with pytest.raises(ValidationError):
            SyncHoldingsRequest(max_symbols=1001)

    def test_max_symbols_minimum_1(self):
        """Test that max_symbols enforces ge=1."""
        with pytest.raises(ValidationError):
            SyncHoldingsRequest(max_symbols=0)

    def test_valid_sync_request(self):
        """Test that valid sync request passes."""
        req = SyncHoldingsRequest(
            holdings=[{"symbol": "AAPL"}, {"symbol": "MSFT"}],
            max_symbols=500,
        )
        assert len(req.holdings) == 2
        assert req.max_symbols == 500


class TestMarketplaceContactLookupBounds:
    """Tests for MarketplaceContactLookup field bounds (CWE-400)."""

    def test_hash_exactly_64_chars(self):
        """Test that hash enforces exact length of 64."""
        with pytest.raises(ValidationError):
            MarketplaceContactLookup(
                hash="a" * 65, last4="1234"
            )

    def test_hash_pattern_hex_validation(self):
        """Test that hash enforces hexadecimal pattern."""
        with pytest.raises(ValidationError):
            MarketplaceContactLookup(
                hash="z" * 64, last4="1234"
            )

    def test_last4_length_validation(self):
        """Test that last4 enforces length between 2 and 4."""
        with pytest.raises(ValidationError):
            MarketplaceContactLookup(
                hash="a" * 64, last4="12345"
            )

    def test_valid_contact_lookup(self):
        """Test that valid contact lookup passes."""
        lookup = MarketplaceContactLookup(
            hash="a" * 64, last4="1234"
        )
        assert len(lookup.hash) == 64


class TestMarketplaceContactMatchRequestBounds:
    """Tests for MarketplaceContactMatchRequest field bounds (CWE-400)."""

    def test_phone_lookups_list_bounded_1000(self):
        """Test that phone_lookups list enforces max_length=1000."""
        with pytest.raises(ValidationError):
            lookups = [
                MarketplaceContactLookup(hash="a" * 64, last4="1234")
                for _ in range(1001)
            ]
            MarketplaceContactMatchRequest(phone_lookups=lookups)

    def test_limit_maximum_100(self):
        """Test that limit enforces le=100."""
        with pytest.raises(ValidationError):
            MarketplaceContactMatchRequest(limit=101)

    def test_limit_minimum_1(self):
        """Test that limit enforces ge=1."""
        with pytest.raises(ValidationError):
            MarketplaceContactMatchRequest(limit=0)

    def test_valid_match_request(self):
        """Test that valid match request passes."""
        lookups = [
            MarketplaceContactLookup(hash="a" * 64, last4="1234"),
            MarketplaceContactLookup(hash="b" * 64, last4="5678"),
        ]
        req = MarketplaceContactMatchRequest(
            phone_lookups=lookups, limit=50
        )
        assert len(req.phone_lookups) == 2
        assert req.limit == 50


class TestMarketplaceInvestorActionRequestBounds:
    """Tests for MarketplaceInvestorActionRequest field bounds (CWE-400)."""

    def test_action_max_length_32(self):
        """Test that action enforces max_length=32."""
        with pytest.raises(ValidationError):
            MarketplaceInvestorActionRequest(action="a" * 33)

    def test_source_type_max_length_32(self):
        """Test that source_type enforces max_length=32."""
        with pytest.raises(ValidationError):
            MarketplaceInvestorActionRequest(
                action="view", source_type="a" * 33
            )

    def test_target_user_id_max_length_256(self):
        """Test that target_user_id enforces max_length=256."""
        with pytest.raises(ValidationError):
            MarketplaceInvestorActionRequest(
                action="connect", target_user_id="a" * 257
            )

    def test_valid_action_request(self):
        """Test that valid action request passes."""
        req = MarketplaceInvestorActionRequest(
            action="view",
            source_type="profile",
            target_user_id="user123",
        )
        assert req.action == "view"
        assert req.source_type == "profile"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
