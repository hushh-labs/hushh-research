from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from hushh_mcp.services import one_portfolio_review


@pytest.mark.asyncio
async def test_review_retries_only_malformed_json_once(monkeypatch):
    from hushh_mcp.hushh_adk import single_turn

    summary = one_portfolio_review.ReviewInput(
        allow_model_processing=True,
        position_count=0,
        top_positions=[],
        allocation=[],
        history_available=False,
        persona="exploring",
        horizon=None,
        loss_capacity=None,
        assessable=False,
    )
    good = {
        "score": None,
        "takeaway": "Details are limited.",
        "reason": "Information is missing.",
        "next_step": "Review the saved details.",
        "advisor_reason": "A review may help.",
    }
    run = AsyncMock(side_effect=[single_turn.SingleTurnInvalidJsonError("invalid JSON"), good])
    token = "synthetic"
    check_current = AsyncMock()
    monkeypatch.setattr(single_turn, "run_single_turn", run)
    monkeypatch.setattr(single_turn, "build_single_turn_agent", lambda *args, **kwargs: object())
    assert (
        await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=token, check_current=check_current
        )
    ).next_step == good["next_step"]
    assert run.await_count == 2

    run.reset_mock(side_effect=True)
    run.side_effect = [single_turn.SingleTurnInvalidJsonError("invalid JSON")] * 2
    with pytest.raises(single_turn.SingleTurnInvalidJsonError):
        await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=token, check_current=check_current
        )
    assert run.await_count == 2

    run.reset_mock(side_effect=True)
    run.side_effect = ValueError("invalid schema")
    with pytest.raises(ValueError, match="invalid schema"):
        await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=token, check_current=check_current
        )
    assert run.await_count == 1

    run.reset_mock(side_effect=True)
    run.side_effect = [single_turn.SingleTurnInvalidJsonError("invalid JSON"), good]
    check_current.side_effect = PermissionError("owner authority expired")
    with pytest.raises(PermissionError, match="owner authority expired"):
        await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=token, check_current=check_current
        )
    assert run.await_count == 1


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
            summary, user_id="synthetic-owner", consent_token="", check_current=AsyncMock()
        )
