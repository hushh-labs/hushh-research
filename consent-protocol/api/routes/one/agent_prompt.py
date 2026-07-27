"""Runtime prompt-sync read endpoint for per-user personal agents.

A running agent pod fetches its current system prompt here at startup and on a
periodic refresh, so prompts roll forward or back by flipping an ``active`` row
(migration 901) with no redeploy. The response carries the prompt, its version,
a freshly recomputed SHA-256, and an HMAC signature the pod verifies before
adopting it. Conditional GET is supported (``ETag`` / ``If-None-Match``) so a pod
re-pulls only when the prompt actually changed.

Requires an internal prompt-sync capability token (``cap.agent.prompt.sync``) --
an internal-only scope that is never external-requestable and never a data
authority (SECURITY-REVIEW.md M1). The agent whose prompt is served is the
caller's OWN authenticated identity, taken from the token and never a
client-supplied value, so a pod can only ever fetch its own prompt -- there is no
client ``agent_id`` parameter to enumerate other agents' prompts. Auth resolves
before the kill-switch check, so an unauthenticated caller gets 401 regardless of
the flag, and once authenticated the surface returns 404 while
``PERSONAL_AGENT_ENABLED`` is off. Read-only; no user data is touched.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response

from api.middleware import require_consent_scope
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.personal_agent_prompt_repo import PersonalAgentPromptRepo
from hushh_mcp.services.personal_agent_prompt_service import (
    DEFAULT_CHANNEL,
    PersonalAgentPromptService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/agent-prompt", tags=["personal-agent"])

# Captured once so tests can override the exact dependency object; every pod fetch
# must present a valid cap.agent.prompt.sync token (internal-only, no data access).
_require_prompt_sync = require_consent_scope(ConsentScope.CAP_AGENT_PROMPT_SYNC)


def _require_enabled() -> None:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")


def _service() -> PersonalAgentPromptService:
    return PersonalAgentPromptService(repo=PersonalAgentPromptRepo())


def _etag_matches(if_none_match: str, etag: str) -> bool:
    candidates = [c.strip() for c in str(if_none_match).split(",") if c.strip()]
    if "*" in candidates:
        return True
    # Tolerate the weak-validator ``W/`` prefix per RFC 7232.
    normalized = {c[2:] if c.startswith("W/") else c for c in candidates}
    return etag in normalized


@router.get("")
async def get_agent_prompt(
    response: Response,
    channel: str = Query(DEFAULT_CHANNEL, max_length=64),
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
    token_data: dict = Depends(_require_prompt_sync),
):
    """Return the caller-agent's OWN active system prompt (signed), or 304/404."""
    _require_enabled()

    # The served agent is the caller's authenticated identity, never a query param.
    agent_id = str(token_data.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(
            status_code=403,
            detail={"code": "AGENT_IDENTITY_MISSING", "message": "Token has no agent identity."},
        )

    try:
        resolved = await _service().get_active_prompt(agent_id=agent_id, channel=channel)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PROMPT_QUERY", "message": str(exc)},
        ) from exc

    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROMPT_NOT_FOUND",
                "message": "No active prompt for this agent and channel.",
            },
        )

    etag = f'"{resolved.prompt_sha256}"'
    if if_none_match and _etag_matches(if_none_match, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return {
        "agentId": resolved.agent_id,
        "channel": resolved.channel,
        "version": resolved.version,
        "prompt": resolved.prompt_text,
        "promptSha256": resolved.prompt_sha256,
        "signature": resolved.signature,
        "status": resolved.status,
    }
