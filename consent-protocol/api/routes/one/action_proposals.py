"""Proposal API endpoints for Agent One's restricted semantic interpretation path.

These endpoints support the flow described in the integration plan:

1. Search capabilities (semantic retrieval, no execution)
2. One submits a proposal via AG-UI with a restricted tool set
3. Admit: validate draft, resolve inputs, revalidate contract
4. Confirm: validate exact action + user confirmation
5. Settle: record correlated handler result
6. Cancel: prevent future execution of an unexecuted draft

No mutation is allowed during proposal creation or search.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from api.middleware import require_vault_owner_token
from hushh_mcp.one_adk.action_retrieval import is_retrieval_available, search_actions
from hushh_mcp.services.action_gateway import get_action_gateway_action

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent One Proposals"])

# ---------------------------------------------------------------------------
# In-memory proposal state (request-scoped per worker).
# A production deployment should use Redis or the existing Postgres table.
# ---------------------------------------------------------------------------

_proposal_store: dict[str, dict[str, Any]] = {}
_PROPOSAL_TTL = timedelta(minutes=5)
_MAX_PROPOSALS_PER_OWNER = 100
_PROTOCOL_VERSION = "one.action_proposal.v1"


class _ProposalDraft(BaseModel):
    proposal_id: str
    request_id: str
    owner_id: str
    action_id: str
    slots: dict[str, Any]
    entity_mentions: list[dict[str, Any]] = []
    missing_slots: list[str] = []
    catalog_revision: str = ""
    context_revision: str = ""
    confirmation_required: bool = True
    status: str = "needs_resolution"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime = Field(default_factory=lambda: datetime.now(UTC) + _PROPOSAL_TTL)


def _now() -> datetime:
    return datetime.now(UTC)


def _evict_expired() -> None:
    now = _now()
    expired = [pid for pid, p in _proposal_store.items() if p["expires_at"] < now]
    for pid in expired:
        del _proposal_store[pid]


def _evict_owner_overflow(owner_id: str) -> None:
    owner_proposals = [(pid, p) for pid, p in _proposal_store.items() if p["owner_id"] == owner_id]
    if len(owner_proposals) <= _MAX_PROPOSALS_PER_OWNER:
        return
    owner_proposals.sort(key=lambda x: x[1]["created_at"])
    to_remove = [
        pid for pid, _ in owner_proposals[: len(owner_proposals) - _MAX_PROPOSALS_PER_OWNER]
    ]
    for pid in to_remove:
        del _proposal_store[pid]


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4096)
    context: dict[str, Any] | None = None
    limit: int = Field(default=10, ge=1, le=20)


class ProposalRequest(BaseModel):
    """One submits a proposed action via the AG-UI transport.

    The server validates the action exists in the current catalog and creates
    a server-issued binding.  No mutation happens.
    """

    action_id: str = Field(min_length=1)
    slots: dict[str, Any] = Field(default_factory=dict)
    request_id: str = Field(min_length=1)
    context: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Helper: load gateway from action_gateway
# ---------------------------------------------------------------------------


def _context_revision(context: dict[str, Any] | None) -> str:
    """A stable fingerprint of the context a proposal was made against.

    Was ``str(context).__hash__()``, which is an int (not the declared str) and
    is randomised per process by PYTHONHASHSEED -- so two workers derived
    different revisions for identical context, and a proposal minted on one
    could never be matched on another.
    """
    if not context:
        return ""
    canonical = json.dumps(context, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _load_gateway() -> dict[str, Any]:
    from hushh_mcp.services.action_gateway import get_action_gateway

    return cast(dict[str, Any], get_action_gateway())


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/api/one/actions/search")
async def search_capabilities(
    payload: SearchRequest,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """Return semantically-ranked capabilities for a natural-language query.

    This endpoint never executes an action.  It returns candidates for One to
    assess.
    """
    _evict_expired()
    try:
        gateway = _load_gateway()
    except Exception:
        logger.exception("action_search_gateway_load_failed")
        return JSONResponse(
            {"results": [], "ranking": "unavailable", "error": "catalog_unavailable"}
        )

    try:
        results = search_actions(payload.query, gateway, limit=payload.limit or 10)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        logger.exception("action_search_failed")
        return JSONResponse({"results": [], "ranking": "error"})

    # search_actions returns RetrievedAction dataclasses. This read them as
    # dicts, so every call to this endpoint raised AttributeError before it
    # could answer -- and the ranking flag below tested the *function object*
    # `search_actions`, which is always truthy, so it always claimed "semantic"
    # even on the lexical fallback. Both are why the endpoint never worked.
    return JSONResponse(
        {
            "results": [
                {
                    "action_id": r.action_id,
                    "label": r.label,
                    "meaning": r.meaning,
                    "policy": r.policy,
                    "availability": r.availability,
                    **({"use_tool": r.use_tool} if r.use_tool else {}),
                    **(
                        {"semantic_boundaries": r.semantic_boundaries}
                        if r.semantic_boundaries
                        else {}
                    ),
                }
                for r in results
            ],
            "ranking": "semantic" if is_retrieval_available() else "lexical_only",
        }
    )


@router.post("/api/one/agent-chat/proposals")
async def submit_proposal(
    payload: ProposalRequest,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """One submits a proposed action.

    Validates the action exists in the current catalog, creates a server-issued
    binding, and returns a proposal draft.  This endpoint never executes anything.
    """
    _evict_expired()
    owner_id = str(token.get("user_id", ""))
    if not owner_id:
        raise HTTPException(status_code=401, detail="Missing owner identity.")

    # Validate the action exists and is wired.
    gateway = _load_gateway()
    entry = get_action_gateway_action(payload.action_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Action '{payload.action_id}' not found.")
    if (entry.get("execution_target") or {}).get("status") != "wired":
        raise HTTPException(
            status_code=400, detail=f"Action '{payload.action_id}' is not executable."
        )

    # Check owner overflow.
    _evict_owner_overflow(owner_id)

    # Build catalog digest.
    from hushh_mcp.one_adk.action_retrieval import _catalog_digest

    catalog_digest = _catalog_digest(gateway)

    # Determine confirmation requirement from the action's execution policy.
    execution_policy = str(entry.get("execution_policy") or "allow_direct")
    confirmation_required = execution_policy != "allow_direct"

    # Build the proposal.
    proposal_id = f"prop_{secrets.token_urlsafe(16)}"
    now = _now()
    draft = _ProposalDraft(
        proposal_id=proposal_id,
        request_id=payload.request_id,
        owner_id=owner_id,
        action_id=payload.action_id,
        slots=dict(payload.slots),
        catalog_revision=catalog_digest,
        context_revision=_context_revision(payload.context),
        confirmation_required=confirmation_required,
        status="needs_resolution",
        created_at=now,
        expires_at=now + _PROPOSAL_TTL,
    )
    _proposal_store[proposal_id] = draft.model_dump()

    logger.info(
        "one_action_proposal_created proposal_id=%s action=%s owner=%s",
        proposal_id,
        payload.action_id,
        owner_id,
    )

    return JSONResponse(
        {
            "schemaVersion": _PROTOCOL_VERSION,
            "requestId": payload.request_id,
            "proposalId": proposal_id,
            "status": "needs_resolution" if not draft.missing_slots else "needs_clarification",
            "actionId": payload.action_id,
            "slots": dict(draft.slots),
            "entityMentions": draft.entity_mentions,
            "missingSlots": draft.missing_slots,
            "catalogRevision": catalog_digest,
            "contextRevision": draft.context_revision,
            "confirmationRequired": confirmation_required,
        }
    )


@router.post("/api/one/action-proposals/{proposal_id}/admit")
async def admit_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """Validate the issued draft, resolve/bind eligible inputs, and revalidate."""
    _evict_expired()
    owner_id = str(token.get("user_id", ""))

    draft = _proposal_store.get(proposal_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")

    if draft["owner_id"] != owner_id:
        raise HTTPException(
            status_code=403, detail="Proposal does not belong to the current owner."
        )

    if draft["status"] not in ("needs_resolution", "needs_clarification"):
        raise HTTPException(
            status_code=400,
            detail=f"Proposal is in state '{draft['status']}' and cannot be admitted.",
        )

    # Revalidate against current catalog.
    gateway = _load_gateway()
    from hushh_mcp.one_adk.action_retrieval import _catalog_digest

    current_digest = _catalog_digest(gateway)
    if draft["catalog_revision"] != current_digest:
        draft["status"] = "blocked"
        return JSONResponse(
            {
                "status": "blocked",
                "reason": "catalog_changed",
                "detail": "The action catalog has changed. Please retry.",
            }
        )

    # Check if all required slots are filled.
    entry = get_action_gateway_action(draft["action_id"])
    missing: list[str] = []
    if entry:
        goal = entry.get("goal") or {}
        for spec in goal.get("required_inputs") or []:
            if not isinstance(spec, dict):
                continue
            slot_name = str(spec.get("slot") or spec.get("name") or "").strip()
            if not slot_name:
                continue
            if not spec.get("required"):
                continue
            if draft["slots"].get(slot_name) in (None, ""):
                if spec.get("default_value") in (None, ""):
                    missing.append(slot_name)

    if missing:
        draft["status"] = "needs_clarification"
        draft["missing_slots"] = missing
        return JSONResponse(
            {
                "status": "needs_clarification",
                "proposalId": proposal_id,
                "missingSlots": missing,
                "slots": draft["slots"],
            }
        )

    draft["status"] = "ready_for_review"
    return JSONResponse(
        {
            "status": "ready_for_review",
            "proposalId": proposal_id,
            "actionId": draft["action_id"],
            "slots": draft["slots"],
            "confirmationRequired": draft["confirmation_required"],
        }
    )


@router.post("/api/one/action-proposals/{proposal_id}/confirm")
async def confirm_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """Validate the exact prepared action and user's confirmation.

    Returns execution permission for the bound proposal.  Does not call
    any service — the caller must invoke the action after receiving this response.
    """
    _evict_expired()
    owner_id = str(token.get("user_id", ""))

    draft = _proposal_store.get(proposal_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")

    if draft["owner_id"] != owner_id:
        raise HTTPException(
            status_code=403, detail="Proposal does not belong to the current owner."
        )

    if draft["status"] != "ready_for_review":
        raise HTTPException(
            status_code=400, detail=f"Proposal is in state '{draft['status']}'. Admit first."
        )

    # Atomically mark as confirmed.
    draft["status"] = "confirmed"
    _proposal_store[proposal_id] = draft

    logger.info(
        "one_action_proposal_confirmed proposal_id=%s action=%s", proposal_id, draft["action_id"]
    )

    return JSONResponse(
        {
            "status": "confirmed",
            "proposalId": proposal_id,
            "actionId": draft["action_id"],
            "slots": draft["slots"],
            "executionGrant": {
                "action_id": draft["action_id"],
                "slots": draft["slots"],
                "use_tool": _resolve_use_tool(draft["action_id"]),
            },
        }
    )


@router.post("/api/one/action-proposals/{proposal_id}/settle")
async def settle_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """Record the correlated handler result.

    Does not invent success.  The caller passes the actual handler outcome.
    """
    _evict_expired()
    owner_id = str(token.get("user_id", ""))

    draft = _proposal_store.get(proposal_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")

    if draft["owner_id"] != owner_id:
        raise HTTPException(
            status_code=403, detail="Proposal does not belong to the current owner."
        )

    if draft["status"] not in ("confirmed", "consumed"):
        raise HTTPException(
            status_code=400, detail=f"Proposal is in state '{draft['status']}'. Confirm first."
        )

    draft["status"] = "settled"
    _proposal_store[proposal_id] = draft

    return JSONResponse({"status": "settled", "proposalId": proposal_id})


@router.delete("/api/one/action-proposals/{proposal_id}")
async def cancel_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> JSONResponse:
    """Cancel an unexecuted draft.  Prevents future execution."""
    _evict_expired()
    owner_id = str(token.get("user_id", ""))

    draft = _proposal_store.get(proposal_id)
    if draft is None:
        return JSONResponse({"status": "cancelled", "proposalId": proposal_id})

    if draft["owner_id"] != owner_id:
        raise HTTPException(
            status_code=403, detail="Proposal does not belong to the current owner."
        )

    if draft["status"] in ("settled",):
        return JSONResponse({"status": "already_settled", "proposalId": proposal_id})

    draft["status"] = "cancelled"
    _proposal_store[proposal_id] = draft

    logger.info("one_action_proposal_cancelled proposal_id=%s", proposal_id)
    return JSONResponse({"status": "cancelled", "proposalId": proposal_id})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_use_tool(action_id: str) -> str | None:
    from hushh_mcp.one_adk.action_tools import _DELEGATE_TOOL_BY_AGENT_ID

    entry = get_action_gateway_action(action_id)
    if entry is None:
        return None
    delegate_id = str(entry.get("delegate_agent_id") or "").strip()
    delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(delegate_id)
    if delegate_tool:
        return delegate_tool
    # Check journey.
    goal = entry.get("goal") or {}
    steps = goal.get("workflow_steps") or []
    if (
        len(steps) >= 2
        and steps[0].get("type") == "action"
        and steps[0].get("action_id") == action_id
    ):
        initial = steps[0] if isinstance(steps[0], dict) else {}
        settlement_target = initial.get("settlement_target") or {}
        if settlement_target.get("route") and settlement_target.get("screen"):
            return "start_app_goal"
    return "run_app_action"


__all__ = ["router"]
