"""Session/UI tools: open a screen by its gateway route action."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)

# Only navigation actions are openable by voice; the list is checked against the
# generated gateway at import time by the registry test (path == "route").
OPENABLE_SCREENS: dict[str, str] = {
    "location_home": "location.open_now",
    "location_people": "location.open_people",
    "location_links": "location.open_links",
    "location_circles": "location.open_circles",
    "location_share": "location.open_share",
    "location_ask": "location.open_ask",
    "location_invite": "location.open_invite",
    "location_create_circle": "location.open_create_circle",
    "location_join_circle": "location.open_join_circle",
    "location_check_in": "location.open_check_in",
    "location_sos": "location.open_sos",
    "location_emergency_contacts": "location.open_sms_contacts",
    "location_settings": "location.open_settings",
    "location_active_shares": "location.open_active_shares",
    "location_shared_with_me": "location.open_shared_with_me",
    "location_needs_review": "location.open_needs_review",
    "location_map": "location.open_map",
    "location_ratings": "location.open_ratings",
    "location_setup": "location.setup.start",
    "connections": "location.add_connections",
    "profile": "route.profile",
    "profile_privacy": "route.profile_privacy",
    "profile_voice_preferences": "route.voice_settings",
}

ScreenId = Literal[
    "location_home",
    "location_people",
    "location_links",
    "location_circles",
    "location_share",
    "location_ask",
    "location_invite",
    "location_create_circle",
    "location_join_circle",
    "location_check_in",
    "location_sos",
    "location_emergency_contacts",
    "location_settings",
    "location_active_shares",
    "location_shared_with_me",
    "location_needs_review",
    "location_map",
    "location_ratings",
    "location_setup",
    "connections",
    "profile",
    "profile_privacy",
    "profile_voice_preferences",
]


class OpenScreenInput(ToolInput):
    screen: ScreenId = Field(description="The screen to open. Only these ids exist.")
    # Optional canonical ids the screen may focus (never names).
    circle_id: str | None = Field(default=None, max_length=36)
    user_id: str | None = Field(default=None, max_length=128)


class OpenScreenResult(ToolResult):
    status: Literal["navigation_dispatched", "rejected"]
    screen: str | None = None
    gateway_action_id: str | None = None
    circle_id: str | None = None
    user_id: str | None = None


async def open_screen(ctx: ToolContext, args: OpenScreenInput) -> ToolResult:
    action_id = OPENABLE_SCREENS.get(args.screen)
    if action_id is None:
        return Rejected(reason_code="unknown_screen", spoken_facts=["I can't open that screen."])
    if args.user_id and ctx.entities.person(args.user_id) is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
    if args.circle_id and ctx.entities.circle(args.circle_id) is None:
        return Rejected(reason_code="circle_not_confirmed", needs="disambiguation")
    return OpenScreenResult(
        status="navigation_dispatched",
        screen=args.screen,
        gateway_action_id=action_id,
        circle_id=args.circle_id,
        user_id=args.user_id,
        spoken_facts=["Opening it now."],
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="open_screen",
        gateway_action_id="route.one_location",
        policy=ToolPolicy.direct,
        input_model=OpenScreenInput,
        output_model=OpenScreenResult,
        description=(
            "Open a screen in the app. Navigation only; it changes nothing. Use it for "
            "'show my map', 'open Location settings', 'show my people', 'open my profile', "
            "'open Save My Soul', 'start location setup'."
        ),
        handler=open_screen,
    ),
)
