"""Session/UI tools: open a screen by its gateway route action."""

from __future__ import annotations

import uuid
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
    "person_profile": "route.person_profile",
}

# The signed-in person's own profile screens. Someone else's profile is
# person_profile; a user_id here is refused, never silently redirected.
_OWNER_ONLY_SCREENS = frozenset({"profile", "profile_privacy", "profile_voice_preferences"})

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
    "person_profile",
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
    public_person_ref: str | None = None


def _profile_ref(value: str | None) -> str | None:
    """The person's public profile ref in canonical UUID form, or None."""
    if not value:
        return None
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return None


async def open_screen(ctx: ToolContext, args: OpenScreenInput) -> ToolResult:
    action_id = OPENABLE_SCREENS.get(args.screen)
    if action_id is None:
        return Rejected(reason_code="unknown_screen", spoken_facts=["I can't open that screen."])
    if args.screen in _OWNER_ONLY_SCREENS and args.user_id and args.user_id != ctx.user_id:
        return Rejected(
            reason_code="owner_only_screen",
            spoken_facts=[
                f"{args.screen} is the person's own profile. To open someone else's "
                "profile, use person_profile with their confirmed user_id."
            ],
        )
    if args.screen == "person_profile" and not args.user_id:
        return Rejected(
            reason_code="person_required",
            needs="repeat_name",
            spoken_facts=["Whose profile? Say their name."],
        )
    person = ctx.entities.person(args.user_id) if args.user_id else None
    if args.user_id and person is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
    if args.screen == "person_profile":
        ref = _profile_ref(person.public_person_ref if person is not None else None)
        if ref is None:
            return Rejected(
                reason_code="no_profile_ref",
                spoken_facts=["I can't open their profile from here."],
            )
        return OpenScreenResult(
            status="navigation_dispatched",
            screen=args.screen,
            gateway_action_id=action_id,
            user_id=args.user_id,
            public_person_ref=ref,
            spoken_facts=["Opening their profile."],
        )
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
            "'open Save My Soul', 'start location setup'. 'Open Priya's profile' is "
            "person_profile with the confirmed user_id; 'profile' is your own profile."
        ),
        handler=open_screen,
    ),
)
