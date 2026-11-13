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


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", [None, "score", "takeaway", "next_step"])
async def test_portfolio_review_azure_request_keeps_original_output_validation(monkeypatch, defect):
    import json

    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.runtime_providers.json_schema import current_validated_output_schema
    from tests.services.test_azure_adk import message, model, response

    summary = one_portfolio_review.ReviewInput(
        allow_model_processing=True,
        position_count=2,
        top_positions=[{"name": "Synthetic fund", "percent": 60}],
        allocation=[{"name": "Equities", "percent": 60}, {"name": "Cash", "percent": 40}],
        history_available=False,
        persona="balanced",
        horizon="long_term",
        loss_capacity="flexible",
        assessable=True,
    )
    payload = {
        "score": 75,
        "takeaway": "This snapshot has a substantial cash allocation.",
        "reason": "Cash may reduce short-term swings but can affect long-term growth.",
        "next_step": "Review how much cash you need for planned spending.",
        "advisor_reason": None,
    }
    if defect == "score":
        payload["score"] = 101
    elif defect == "takeaway":
        payload["takeaway"] = ""
    elif defect == "next_step":
        payload["next_step"] = "x" * 201
    adapter, client, _, _ = model([response(message(json.dumps(payload)))])
    original_create = client.create

    async def azure_create(**kwargs):
        # Azure's native strict subset cannot express this contract's bounds.
        # Reject the broken request before returning the scripted model answer.
        wire = kwargs["text"]["format"]
        if wire["type"] == "json_schema":
            assert "maxLength" not in wire["schema"]["properties"]["next_step"]
        return await original_create(**kwargs)

    client.create = azure_create
    monkeypatch.setattr(
        single_turn, "build_managed_regional_gemini_adk_model", lambda *a, **k: adapter
    )

    async def run():
        return await one_portfolio_review.run_portfolio_review(
            summary, user_id="synthetic-owner", consent_token=""
        )

    if defect:
        with pytest.raises(ValidationError):
            await run()
    else:
        assert await run() == one_portfolio_review.PortfolioReview.model_validate(payload)
    assert client.requests[0]["text"]["format"] == {"type": "json_object"}
    instruction = client.requests[0]["instructions"]
    assert (
        json.loads(instruction.rsplit("\n", 1)[1])
        == one_portfolio_review.PortfolioReview.model_json_schema()
    )
    assert len(client.requests) == client.closed == 1
    assert current_validated_output_schema() is None
