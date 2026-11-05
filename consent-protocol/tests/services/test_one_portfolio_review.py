import pytest
from pydantic import ValidationError

from hushh_mcp.services import one_portfolio_review


def test_portfolio_review_accepts_only_bounded_summaries():
    body = {
        "allow_model_processing": True,
        "position_count": 1,
        "top_positions": [{"name": "Synthetic holding", "percent": 50}],
        "allocation": [{"name": "Cash", "percent": 50}],
        "history_available": False,
        "persona": "careful",
        "horizon": "short_term",
        "loss_capacity": None,
        "assessable": False,
    }
    assert not one_portfolio_review.ReviewInput.model_validate(body).assessable
    with pytest.raises(ValidationError):
        one_portfolio_review.ReviewInput.model_validate({**body, "account_number": "synthetic"})
    with pytest.raises(ValidationError):
        one_portfolio_review.ReviewInput.model_validate(
            {**body, "top_positions": [{"name": "Invalid", "percent": 110}]}
        )


def test_portfolio_review_rejects_out_of_range_scores():
    result = {
        "score": 75,
        "takeaway": "Half of this snapshot is in cash.",
        "reason": "Cash can help cover a planned withdrawal.",
        "next_step": "Estimate your first withdrawal.",
        "advisor_reason": None,
    }
    assert one_portfolio_review.PortfolioReview.model_validate(result).score == 75
    with pytest.raises(ValidationError):
        one_portfolio_review.PortfolioReview.model_validate({**result, "score": 101})


@pytest.mark.asyncio
async def test_portfolio_review_without_owner_approval_never_dispatches():
    summary = one_portfolio_review.ReviewInput(
        allow_model_processing=False,
        position_count=0,
        top_positions=[],
        allocation=[],
        history_available=False,
        persona="exploring",
        horizon=None,
        loss_capacity=None,
        assessable=False,
    )
    with pytest.raises(PermissionError, match="was not approved"):
        await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=""
        )
