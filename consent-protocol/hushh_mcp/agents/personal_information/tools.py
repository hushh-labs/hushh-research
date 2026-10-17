"""ADK tools for the One Personal Information Agent (marketplace chatbot).

Query tools read the current owner's published information metadata, hypothetical
research prices, and bounded recorded commerce metadata through the canonical
MarketplaceInformationService port. Scope checks live in @hushh_tool. Financial
actions require human review in the application; these reads carry no spending
or encrypted-export preparation authority and expose no raw PKM values.
"""

from __future__ import annotations

from typing import Any, Literal

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.one_adk.action_tools import read_my_pkm_domain_summary
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
    context = _ctx()
    if "marketplace_information" in context.service_ports:
        return context.service_ports["marketplace_information"]
    return MarketplaceInformationService()


def _requests() -> MarketplaceRequestService:
    context = _ctx()
    if "marketplace_requests" in context.service_ports:
        return context.service_ports["marketplace_requests"]
    return MarketplaceRequestService()


def _commerce():
    context = _ctx()
    if "marketplace_information" in context.service_ports:
        return context.service_ports["marketplace_information"]
    from hushh_mcp.runtime_settings import pod_mode

    if pod_mode():
        raise PermissionError("Commerce metadata port is unavailable for this runtime")
    return _service()


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
    """Read hypothetical research prices and buyer interest, never actual earnings.

    Compatibility fields in this estimate do not establish current payment
    availability. Use get_scope_commerce_summary for recorded financial facts.
    Suggested prices are separate from exact owner tariffs and accepted quotes.
    """
    context = _ctx()
    estimate = await _service().earnings_summary(user_id=context.user_id, power=power, mood=mood)
    return {
        **estimate,
        "isEstimate": True,
        "note": "Potential research prices and buyer interest only. Read get_scope_commerce_summary for payment readiness and recorded earnings.",
    }


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW, name="get_scope_commerce_summary")
async def get_scope_commerce_summary() -> dict[str, Any]:
    """Read the current owner's recorded earnings and payment setup readiness.

    Pending earnings are distinct from withdrawable earnings and bank payout.
    This tool never pays, funds, approves, prepares or stages information.
    """
    context = _ctx()
    return await _commerce().scope_commerce_summary(user_id=context.user_id)


@hushh_tool(scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW, name="get_scope_commerce_activity")
async def get_scope_commerce_activity(
    view: Literal["purchases", "sales", "transactions"] = "sales",
    cursor: str | None = None,
) -> dict[str, Any]:
    """Read a bounded page of the current owner's canonical commercial history.

    Only safe metadata appears. Follow a next_action link for authenticated
    human review; opening or reading it never confirms spending or fulfillment.
    """
    context = _ctx()
    return await _commerce().scope_commerce_activity(
        user_id=context.user_id, view=view, cursor=cursor
    )


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
    read_my_pkm_domain_summary,
    list_published_slices,
    get_earnings_summary,
    get_scope_commerce_summary,
    get_scope_commerce_activity,
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
