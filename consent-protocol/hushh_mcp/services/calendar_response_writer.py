"""Tool-free, ephemeral composition for an explicitly submitted attendance response."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class CalendarResponseText(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=500)
    subject: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1, max_length=6000)


@lru_cache(maxsize=1)
def _writer():
    manifest = ManifestLoader.load(str(Path(__file__).parents[1] / "agents/calendar/agent.yaml"))
    return next(
        child for child in manifest.subagents if child.id == "agent_calendar_response_writer"
    )


async def compose_calendar_response(
    *,
    user_id: str,
    operation_id: str,
    reason: str,
    title: str,
    organizer_name: str,
    offer_times: bool,
) -> CalendarResponseText:
    """Caller verifies selected provider grants before and after this no-tool call.

    The operation marker scopes ephemeral runtime context; it is not a vault
    token and grants no tool, Mail, PKM, or Calendar mutation authority.
    """
    try:
        agent = build_single_turn_agent(_writer(), output_schema=CalendarResponseText)
        result = await run_single_turn(
            agent,
            user_id=user_id,
            consent_token=f"calendar-response:{operation_id}",
            prompt_parts=json.dumps(
                {
                    "owner_reason": reason,
                    "meeting_title": title,
                    "organizer_name": organizer_name,
                    "offering_another_time": offer_times,
                }
            ),
            timeout_seconds=30,
        )
        return CalendarResponseText.model_validate(result)
    except Exception as exc:
        raise GoogleConnectionError(
            "Your email could not be drafted. Nothing was changed or sent. Please try again.",
            status_code=503,
            reason_code="calendar_response_drafting_unavailable",
        ) from exc
