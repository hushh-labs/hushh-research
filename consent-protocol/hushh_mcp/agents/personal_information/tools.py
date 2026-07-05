"""ADK tools for the One Personal Information Agent (marketplace chatbot).

Slice 1 = read-only query tools. They let the owner ask, in chat, what data
they have published to the marketplace and what it is worth. Persistence and
pricing live in MarketplaceInformationService; scope checks live in @hushh_tool.

Every tool reads ONLY the current user's own published-slice metadata and the
deterministic pricing engine — never raw PKM values, never another user's data.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.services.marketplace_information_service import (
    MarketplaceInformationService,
)
from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService


def _ctx() -> HushhContext:
    context = HushhContext.current()
    if not context:
        raise PermissionError("No active context - marketplace consent required")
    return context


def _service() -> MarketplaceInformationService:
    return MarketplaceInformationService()


def _requests() -> MarketplaceRequestService:
    return MarketplaceRequestService()


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW, name="list_published_slices")
async def list_published_slices() -> dict[str, Any]:
    """List the data slices the user has published to the marketplace (every scope
    set to 'Available'). Read-only; returns labels + public metadata, never raw
    data. Call this to answer 'what have I published / what data is on the market'.
    """
    context = _ctx()
    slices = await _service().list_published_slices(user_id=context.user_id)
    return {"publishedSlices": slices, "count": len(slices)}


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW, name="get_earnings_summary")
async def get_earnings_summary(
    power: str = "affluent",
    mood: str = "affinity",
) -> dict[str, Any]:
    """Summarize buyer demand + potential monthly earnings for published slices.

    Read-only. Reports REAL buyer demand (pendingRequestCount, approvedBuyerCount,
    interestedBuyerCount) alongside each slice's potential monthly price. But
    payments are NOT enabled yet (payoutsEnabled is False, accruedCents is always
    0). Use this to answer 'how much have I made / what are my slices worth / who
    wants my data'. Be honest: cite real buyer interest if any, but always say
    payments are coming soon and nothing has been paid out yet.
    """
    context = _ctx()
    return await _service().earnings_summary(user_id=context.user_id, power=power, mood=mood)


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_MANAGE, name="list_access_requests")
async def list_access_requests() -> dict[str, Any]:
    """List the owner's pending marketplace access requests (durable, server-side).
    Call this FIRST to get a real request id before approving or denying — never
    guess an id. Read-only.
    """
    context = _ctx()
    pending = await _requests().list_requests(owner_user_id=context.user_id, status="pending")
    return {"pendingRequests": pending, "count": len(pending)}


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_MANAGE, name="approve_access_request")
async def approve_access_request(request_id: str) -> dict[str, Any]:
    """Approve a pending marketplace access request server-side, on the owner's
    explicit instruction. request_id MUST come from list_access_requests. This is
    the owner exercising their own consent; only the safe summary is ever shared.
    """
    context = _ctx()
    rid = str(request_id or "").strip()
    if not rid:
        raise ValueError("request_id is required; call list_access_requests first.")
    result = await _requests().approve_request(owner_user_id=context.user_id, request_id=rid)
    if not result.get("ok"):
        raise ValueError(
            "That request could not be approved (not found or already resolved). "
            "Call list_access_requests to get current pending ids."
        )
    return result


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_MANAGE, name="deny_access_request")
async def deny_access_request(request_id: str) -> dict[str, Any]:
    """Deny a pending marketplace access request server-side, on the owner's
    explicit instruction. request_id MUST come from list_access_requests. Nothing
    is shared.
    """
    context = _ctx()
    rid = str(request_id or "").strip()
    if not rid:
        raise ValueError("request_id is required; call list_access_requests first.")
    result = await _requests().deny_request(owner_user_id=context.user_id, request_id=rid)
    if not result.get("ok"):
        raise ValueError(
            "That request could not be denied (not found or already resolved). "
            "Call list_access_requests to get current pending ids."
        )
    return result


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW, name="propose_publish")
async def propose_publish(topic: str | None = None) -> dict[str, Any]:
    """Propose unpublished, offer-worthy slices the owner could publish for offers,
    as a publish card the UI renders. Pass a `topic` (e.g. 'financial', 'travel')
    to tailor the suggestions to what the conversation is about. Read-only — does
    NOT publish anything; the owner taps Publish in the card, which runs the normal
    consent-first publish. Call this whenever the talk is about putting data on the
    marketplace / earning from data and there is something not yet published.
    """
    context = _ctx()
    slices = await _service().list_publishable_slices(
        user_id=context.user_id, topic=(topic or None)
    )
    return {"proposed": "publish_slices", "topic": (topic or None), "slices": slices}


# Read-only query tools available to the marketplace chatbot (slice 1).
PERSONAL_INFORMATION_QUERY_TOOLS = [
    list_published_slices,
    get_earnings_summary,
    propose_publish,
]

# Manage tools: list + approve/deny pending access requests (durable, server-side).
PERSONAL_INFORMATION_MANAGE_TOOLS = [
    list_access_requests,
    approve_access_request,
    deny_access_request,
]

# Tool set the marketplace chatbot runs with (query + manage).
PERSONAL_INFORMATION_CHAT_TOOLS = [
    *PERSONAL_INFORMATION_QUERY_TOOLS,
    *PERSONAL_INFORMATION_MANAGE_TOOLS,
]

# Full tool set for the agent.
PERSONAL_INFORMATION_AGENT_TOOLS = list(PERSONAL_INFORMATION_CHAT_TOOLS)
