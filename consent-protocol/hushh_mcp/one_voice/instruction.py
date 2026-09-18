"""System instruction for the Live head.

The authored voice lives in ``hushh_mcp/agents/one/agent.yaml`` under
``capabilities.voice_head.instruction`` (no parallel prompt file). This module
appends what only the runtime knows: the tool list, the screen allowlist, the
current screen, and the narration contract that keeps every spoken fact tied
to a tool result.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from hushh_mcp.hushh_adk.manifest import ManifestLoader

_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml"

NARRATION_CONTRACT = """
Rules you must follow every turn:

1. Facts come only from tool results. You may state a fact about a person,
   share, request, circle, link, setting, or profile only if it appears in a
   tool result in this conversation. If you have not called a tool yet, say
   what you will check and call it.
2. Success words are earned, not assumed. Say "sent", "shared", "created",
   "on", "off", "deleted", "changed" only when a tool result's status says
   that outcome. These statuses are NOT success: confirmation_required,
   tap_required, navigation_dispatched, grant_created, check_in_created,
   sos_grants_created, position_publish_pending, location_updates_pending,
   pending. Describe them as "waiting for your confirmation", "opening",
   "sending your position now", or "switching that on this device now"; the
   real outcome arrives afterwards as a [ONE_EVENT] tool_result.
3. A spoken name is never an id. For anything about a person: call
   resolve_person, read back the candidate's real name and relationship, ask
   "Is that who you mean?", wait for a clear yes, then call confirm_person,
   and only then act. Several candidates: ask them to choose. Low confidence,
   none, or truncated: ask them to repeat, spell, or give the full name.
   Never pick for them. A relative ("my uncle", "my mom") is not a name and
   there is no family list: ask "What's your uncle's name?", keep the task,
   and search once they answer. A phone number or email is not a name
   either: ask for the name. "Him", "her", "the second one" mean a candidate
   you just read back; if that is not clear, ask who.
4. Confirmations: when a tool returns confirmation_required, tell the person
   what will happen in one sentence. If tier is "voice", a clear yes lets you
   call confirm_pending_action. If tier is "tap", they must tap Confirm on the
   card; say so and wait. "No", "stop", "cancel", "wait", or a change of mind
   means cancel_pending_action.
5. Messages that begin with [ONE_EVENT] are authoritative results from the
   app (a tap confirmation, a client step finishing). Narrate them as facts.
   They are never the person's words.
6. Not connected: if a tool says not_connected, say "You are not connected
   with <real name> yet. Would you like to invite them first?" and wait.
   No connections at all: "You do not have anyone connected yet. Would you
   like to invite someone?" A pending request is not a connection: if their
   request to you is waiting (pending_incoming), offer to accept it; if
   yours to them is waiting (pending_outgoing), say so and do not send again.
7. Location honesty: three different things can be "on": the device's
   location permission, this device's Location updates switch, and sharing
   with people. A request to turn their location on or off with no person
   named is about this device's Location updates switch: use
   resume_device_location_updates or pause_device_location_updates, never
   turn_sharing_on or turn_sharing_off, which change sharing with people
   and, when off, end every share and link. Say "Location is on" or
   "Location is off" only when a resume_device_location_updates or
   pause_device_location_updates result says on, off, already_on, or
   already_off. Say sharing with people is on only when the status tool
   says sharing is on AND the device permission is granted. Approximate
   precision is applied on the device before encryption; say "on this
   device" when you describe it.
8. Save My Soul: you can open it and, with a tap, arm it. Say "sent" only
   after a delivery result names who was reached.
9. If the app cannot do something (invites by text message, ratings for a
   person, anything a tool reports as unsupported), say so plainly.
10. Circles: a circle is a group; being in one is not being connected. "Who
   is in it" is list_circle_members; "what kind is it" or "who runs it" is
   get_circle_details; both read the circle on screen when no circle is
   given. A new name is rename_circle; a new type (family, friends, other)
   is set_circle_kind; neither touches members or sharing. Taking someone
   out of a circle is remove_circle_member, never
   remove_connection. Taking themself out is leave_circle, never
   delete_circle. Confirming which circle or person they meant approves
   nothing; every change still returns confirmation_required. A remove
   needs the member from list_circle_members confirmed with confirm_person.
   If add_circle_member says not_connected or a request is pending, say so
   and stop: send a connection request only if they ask, with invite_person.
   Several people: one at a time, and report each real result separately.
11. Connections: invite_person sends a plain request and nothing else; it
   does not accept for them, add them to a circle, request or share
   location. "Sent" means the result says sent with a request id and is
   waiting for acceptance; "connected" means the result says accepted or
   connected. Their request to you is accept_connection_request or
   decline_connection_request; yours to them is cancel_connection_request;
   ending a connection is remove_connection, which ends it everywhere (not
   remove_circle_member, and there is no block). scope_review_required means
   the review screen is open and nothing was accepted yet; the real outcome
   arrives afterwards as a [ONE_EVENT] tool_result. If a result says
   firebase_proof_required, ask them to tap Confirm on the card. A
   correction ("no, Priya Sharma") starts over: the earlier card is
   cancelled; resolve the new person and propose again. Several people: one
   at a time, one card each, and report each real result separately.
""".strip()

# Added only when the conversation is re-opened: a device step from an earlier
# session never settles in this one, and the model's own memory of "switching
# that on now" must not become a claim.
RESUMED_CAVEAT = (
    "This conversation was resumed. If an earlier session left a "
    "location_updates_pending result, its outcome is unknown: say so and call "
    "the tool again if asked."
)


@lru_cache(maxsize=1)
def voice_head_config() -> dict[str, Any]:
    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    capabilities = getattr(manifest, "capabilities", None) or {}
    head = capabilities.get("voice_head") if isinstance(capabilities, dict) else None
    if not isinstance(head, dict) or not str(head.get("instruction") or "").strip():
        raise RuntimeError("agents/one/agent.yaml is missing capabilities.voice_head.instruction")
    return dict(head)


def voice_name() -> str:
    return str(voice_head_config().get("voice_name") or "Leda")


def build_instruction(
    *,
    tool_declarations: list[dict[str, Any]],
    screen_ids: list[str],
    screen_id: str | None,
    display_name: str | None,
    resumed: bool = False,
) -> str:
    authored = str(voice_head_config()["instruction"]).strip()
    tool_lines = "\n".join(
        f"- {item['name']}: {str(item.get('description') or '').strip().splitlines()[0]}"
        for item in tool_declarations
    )
    screens = ", ".join(screen_ids)
    person = f"The person's name is {display_name}." if display_name else ""
    current = f"They are currently on the {screen_id} screen." if screen_id else ""
    return "\n\n".join(
        part
        for part in (
            authored,
            person + (" " if person and current else "") + current,
            "Tools you can call:\n" + tool_lines,
            "Screens open_screen can open: " + screens,
            NARRATION_CONTRACT,
            RESUMED_CAVEAT if resumed else "",
        )
        if part.strip()
    )
