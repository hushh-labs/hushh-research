from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.analyze import AnalyzeRequest
from api.routes.kai.consent import GrantConsentRequest
from api.routes.kai.losers import AnalyzeLosersRequest, PortfolioHolding, PortfolioLoser


def test_analyze_request_rejects_oversized_identity_and_ticker_fields():
    with pytest.raises(ValidationError):
        AnalyzeRequest(user_id="u" * 129, ticker="AAPL")

    with pytest.raises(ValidationError):
        AnalyzeRequest(user_id="user_1", ticker="X" * 21)

    with pytest.raises(ValidationError):
        AnalyzeRequest(user_id="user_1", ticker="AAPL", consent_token="t" * 2049)


def test_grant_consent_request_caps_scope_count():
    with pytest.raises(ValidationError):
        GrantConsentRequest(user_id="user_1", scopes=[f"scope.{index}" for index in range(21)])


def test_analyze_losers_request_caps_position_payloads():
    with pytest.raises(ValidationError):
        PortfolioLoser(symbol="X" * 21)

    with pytest.raises(ValidationError):
        PortfolioHolding(symbol="AAPL", sector="s" * 129)

    with pytest.raises(ValidationError):
        AnalyzeLosersRequest(
            user_id="user_1",
            losers=[PortfolioLoser(symbol=f"L{index}") for index in range(201)],
        )

    with pytest.raises(ValidationError):
        AnalyzeLosersRequest(
            user_id="user_1",
            holdings=[PortfolioHolding(symbol=f"H{index}") for index in range(1001)],
        )
