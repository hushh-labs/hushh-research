"""Offer a Location review to the current Chat without committing an action."""

from __future__ import annotations

from typing import Literal

from hushh_mcp.one_adk.location_chat_proposal import (
    TOOL_NAME,
    VOICE_LOCATION_CHAT_FEATURE,
    LocationChatIntent,
    LocationChatProposal,
    OfferedLocationChatAction,
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
        "create_check_in",
        "revoke_public_link",
        "trigger_save_my_soul",
        "stop_save_my_soul",
        "add_emergency_contact",
        "remove_emergency_contact",
        "turn_sharing_on",
        "turn_sharing_off",
        "set_precision",
        "set_auto_approve",
        "hide_on_map",
        "show_on_map",
        "resume_device_location_updates",
        "pause_device_location_updates",
        "start_location_setup",
        "accept_location_setup_consent",
        "advance_location_setup",
        "create_circle",
        "rename_circle",
        "set_circle_kind",
        "delete_circle",
        "add_circle_member",
        "add_circle_members",
        "add_all_connections",
        "remove_circle_member",
        "leave_circle",
        "respond_circle_invite",
        "cancel_circle_invite",
        "create_circle_invite_link",
    }
)


class ReviewLocationInput(LocationChatIntent, ToolInput):
    action: OfferedLocationChatAction


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
            "Open an inline Location review for sharing, device and account settings, "
            "check-in, Circles, links, or Save My Soul. The tool does not read or change Location."
        ),
        handler=review_location,
    ),
)
