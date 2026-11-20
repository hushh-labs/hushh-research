"""Compatibility navigation for non-live private-agent sessions."""

from typing import Any

from google.adk.tools import ToolContext

from hushh_mcp.one_adk.state_keys import STATE_PENDING_DIRECTIVE, STATE_VOICE_CONTEXT
from hushh_mcp.services.crm_product_availability import crm_product_available

CRM_PRODUCT_AVAILABLE = crm_product_available()

# Governed navigation allowlist: screen id -> app route. Mirrors the /one
# roster plus core account surfaces. One can ONLY navigate here; anything
# else is refused by construction.
APP_ROUTES: dict[str, str] = {
    "home": "/one",
    "setup": "/one/setup",
    "finance": "/one/kai",
    "ria": "/ria",
    "email": "/one/email",
    "location": "/one/location",
    "personal_data": "/one/pkm",
    "consent": "/one/consent",
    "profile": "/profile",
}
if CRM_PRODUCT_AVAILABLE:
    APP_ROUTES["connected_systems"] = "/one/connected-systems"


async def open_screen(screen: str, tool_context: ToolContext) -> dict[str, Any]:
    """Legacy non-live navigation helper.

    Live One sessions must use a generated action currently published by the
    browser. Keeping this compatibility tool fail-closed in a live session
    prevents it from bypassing route, setup, and visible-control authority.
    """
    voice_context = tool_context.state.get(STATE_VOICE_CONTEXT)
    if isinstance(voice_context, dict) and voice_context.get("route_family"):
        return {
            "status": "action_required",
            "message": (
                "Use one of the generated actions available on the current screen; "
                "I cannot navigate around its controls directly."
            ),
        }
    key = str(screen or "").strip().lower().replace("-", "_").replace(" ", "_")
    route = APP_ROUTES.get(key)
    if not route:
        return {
            "status": "unknown_screen",
            "message": f"'{screen}' is not a screen I can open.",
            "valid_screens": sorted(APP_ROUTES),
        }
    tool_context.state[f"{STATE_PENDING_DIRECTIVE}:{key}"] = {
        "kind": "navigate",
        "payload": {"route": route, "screen": key},
    }
    return {
        "status": "ok",
        "message": f"Opening {key.replace('_', ' ')}.",
        "route": route,
        # Proactive-prompting: this text becomes the tool RESULT the model
        # reads on its next turn (there is no separate server-injected
        # system turn for tool results, unlike the greeting/screen-change
        # notes in adk_live.py). Nudging here means One offers a next step
        # after every screen it opens, not only after onboarding-tagged
        # screen changes.
        "next_step": "Wait for route settlement before describing the next step.",
    }
