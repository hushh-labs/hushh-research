"""Hermes tools exposed to One's authenticated text head.

The functions receive only the authenticated user id from ephemeral ADK state.
The Hermes credential stays inside ``hermes_bridge_service`` and never reaches a
tool result. Every failure is returned as a named boundary status with a
concrete next step, so One can tell the owner what to do instead of retrying.
"""

from __future__ import annotations

from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services import hermes_bridge_service
from hushh_mcp.services.hermes_bridge_service import HermesBridgeError

_STATE_USER_ID = "hussh:user_id"

#: Bounded so a machine with many jobs cannot flood a model turn.
_MAX_JOBS_REPORTED = 25


def _require_user(tool_context: ToolContext) -> str:
    user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if not user_id:
        raise HermesBridgeError("Sign in to reach your Hermes machine.", status="hermes_not_linked")
    return user_id


def _boundary(exc: HermesBridgeError) -> dict[str, Any]:
    """Render a bridge failure as a named boundary One can speak to."""
    next_step = {
        "hermes_bridge_disabled": (
            "Tell the owner the Hermes bridge is not enabled in this environment."
        ),
        "hermes_offline": (
            "Tell the owner their Hermes machine is not answering and ask them to start it."
        ),
        "hermes_unauthorized": (
            "Tell the owner the bridge credential was rejected and needs to be refreshed."
        ),
        "hermes_not_linked": (
            "Tell the owner to run `/hussh-one connect` in Hermes to link the machine."
        ),
    }.get(exc.status, "Report the failure to the owner without retrying.")

    return {"status": exc.status, "message": str(exc), "next_step": next_step}


async def hermes_status(tool_context: ToolContext) -> dict[str, Any]:
    """Report whether the owner's Hermes machine is linked and awake right now."""
    try:
        _require_user(tool_context)
        status = await hermes_bridge_service.get_status()
    except HermesBridgeError as exc:
        return _boundary(exc)

    platforms = status.get("platforms") if isinstance(status.get("platforms"), dict) else {}
    readiness = status.get("readiness") if isinstance(status.get("readiness"), dict) else {}

    return {
        "status": "ok",
        "online": True,
        "version": status.get("version"),
        "gateway_state": status.get("gateway_state"),
        "readiness": readiness.get("status") or status.get("status"),
        "active_agents": status.get("active_agents"),
        "connected_channels": sorted(
            name
            for name, link in platforms.items()
            if isinstance(link, dict) and link.get("state") == "connected"
        ),
    }


async def hermes_jobs(tool_context: ToolContext) -> dict[str, Any]:
    """List the scheduled jobs configured on the owner's Hermes machine."""
    try:
        _require_user(tool_context)
        jobs = await hermes_bridge_service.list_jobs()
    except HermesBridgeError as exc:
        return _boundary(exc)

    reported = jobs[:_MAX_JOBS_REPORTED]
    return {
        "status": "ok",
        "count": len(jobs),
        "truncated": len(jobs) > len(reported),
        "jobs": [
            {
                "id": job.get("id"),
                "name": job.get("name"),
                "schedule": job.get("schedule_display") or job.get("schedule"),
                "enabled": bool(job.get("enabled")),
                "last_status": job.get("last_status"),
            }
            for job in reported
        ],
    }


async def hermes_relay(tool_context: ToolContext, instruction: str) -> dict[str, Any]:
    """Send one natural-language instruction to the owner's Hermes machine.

    Use this only when the owner asked for something to be done or answered on
    their own machine. Pass their intent through faithfully in one instruction.
    """
    try:
        _require_user(tool_context)
        result = await hermes_bridge_service.relay_turn(instruction)
    except HermesBridgeError as exc:
        return _boundary(exc)

    if result.get("failed"):
        return {
            "status": "hermes_relay_failed",
            "message": result.get("error") or "Hermes could not complete the request.",
            "next_step": (
                "Report that the machine reported a failure, and name the reason "
                "exactly as given. Do not present it as a normal answer."
            ),
        }

    return {
        "status": "ok",
        "answer": result.get("content") or "",
        "model": result.get("model"),
    }
