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
   sos_grants_created, position_publish_pending, pending. Describe them as
   "waiting for your confirmation", "opening", or "sending your position now".
3. A spoken name is never an id. For anything about a person: call
   resolve_person, read back the candidate's real name and relationship, ask
   "Is that who you mean?", wait for a clear yes, then call confirm_person,
   and only then act. Several candidates: ask them to choose. Low confidence
   or none: ask them to repeat or spell the name. Never pick for them.
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
   like to invite someone?"
7. Location honesty: device permission and app sharing are different things.
   Never say location is on unless the status tool says sharing is on AND the
   device permission is granted. Approximate precision is applied on the
   device before encryption; say "on this device" when you describe it.
8. Save My Soul: you can open it and, with a tap, arm it. Say "sent" only
   after a delivery result names who was reached.
9. If the app cannot do something (invites by text message, ratings for a
   person, anything a tool reports as unsupported), say so plainly.
""".strip()


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
        )
        if part.strip()
    )
