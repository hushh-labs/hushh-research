"""One's private, nonpersisting review of an owner-approved portfolio summary."""

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class ReviewModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Allocation(ReviewModel):
    name: str = Field(min_length=1, max_length=60)
    percent: float = Field(gt=0, le=100)


class ReviewInput(ReviewModel):
    allow_model_processing: StrictBool
    position_count: int = Field(ge=0, le=1_000_000)
    top_positions: list[Allocation] = Field(max_length=5)
    allocation: list[Allocation] = Field(max_length=8)
    history_available: StrictBool
    persona: Literal["exploring", "mixed", "careful", "balanced", "growth"]
    horizon: Literal["short_term", "medium_term", "long_term"] | None
    loss_capacity: Literal["essentials", "delay_goal", "flexible"] | None
    assessable: StrictBool


class PortfolioReview(ReviewModel):
    score: int | None = Field(ge=0, le=100)
    takeaway: str = Field(min_length=1, max_length=160)
    reason: str = Field(min_length=1, max_length=240)
    next_step: str = Field(min_length=1, max_length=200)
    advisor_reason: str | None = Field(min_length=1, max_length=160)


async def run_portfolio_review(
    summary: ReviewInput, *, user_id: str, consent_token: str
) -> PortfolioReview:
    if not summary.allow_model_processing:
        raise PermissionError("Portfolio review was not approved")

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/one/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "one_portfolio_review")
    if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
        raise ValueError("invalid portfolio review boundary")
    result = await run_single_turn(
        build_single_turn_agent(gene, output_schema=PortfolioReview),
        prompt_parts=json.dumps(
            {"saved_portfolio_summary": summary.model_dump(exclude={"allow_model_processing"})}
        ),
        user_id=user_id,
        consent_token=consent_token,
        timeout_seconds=25,
    )
    review = PortfolioReview.model_validate(result)
    if (review.score is not None and not summary.assessable) or (
        review.score is None and not review.advisor_reason
    ):
        raise ValueError("inconsistent portfolio review")
    return review
