"""Offer a Location review to the current Chat without committing an action."""

from __future__ import annotations

from typing import Literal

from hushh_mcp.one_adk.location_chat_proposal import (
    TOOL_NAME,
    VOICE_LOCATION_CHAT_FEATURE,
    LocationChatIntent,
    LocationChatProposal,
    make_location_chat_proposal,
)
from hushh_mcp.one_voice.tools.base import (
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)

# In main Chat these decisions use the same review in text and voice.
REPLACED_TOOLS = frozenset(
    {
        "request_location",
        "list_requests",
        "respond_request",
        "share_with",
        "create_public_link",
        "list_shares",
        "stop_share",
        "change_share_duration",
    }
)


class ReviewLocationInput(LocationChatIntent, ToolInput):
    pass


class ReviewLocationResult(ToolResult):
    status: Literal["proposal_ready"] = "proposal_ready"
    proposal: LocationChatProposal

    def public(self) -> dict:
        return {**super().public(), "proposal": self.proposal.payload()}

    def model_public(self) -> dict:
        return {"status": self.status, "spoken_facts": self.spoken_facts}


async def review_location(ctx: ToolContext, args: ReviewLocationInput) -> ToolResult:
    if ctx.services.get(VOICE_LOCATION_CHAT_FEATURE) is not True:
        return Rejected(reason_code="location_chat_review_unavailable")
    return ReviewLocationResult(
        proposal=make_location_chat_proposal(args),
        spoken_facts=["You can review it here."],
    )


TOOLS = (
    ToolSpec(
        name=TOOL_NAME,
        gateway_action_id="location.chat.turn",
        policy=ToolPolicy.read,
        input_model=ReviewLocationInput,
        output_model=ReviewLocationResult,
        description=(
            "Offer Location sharing, request, or view review in this Chat. Reads and changes nothing."
        ),
        handler=review_location,
    ),
)
