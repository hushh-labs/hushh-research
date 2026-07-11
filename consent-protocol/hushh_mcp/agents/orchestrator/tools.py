"""
Orchestrator Tools

Delegation functions for One, the top personal agent.
These tools are used by the LLM to route requests to specialized agents.
"""

import re
from typing import Any, Dict, Optional

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool


# Helper to standard delegation response
def _create_delegation_response(
    domain: str, target_agent: str, context: HushhContext
) -> Dict[str, Any]:
    return {
        "delegated": True,
        "target_agent": target_agent,
        "domain": domain,
        "message": f"I'm connecting you with our {domain} specialist.",
    }


# Deterministic intent classification for the One orchestrator.
#
# The Google ADK LLM tool loop is the primary router when ADK is installed.
# This keyword map is the fail-closed fallback so delegation still resolves
# deterministically (and testably) without a live model. Each entry maps a
# specialist to its delegation domain/target plus the cues that route to it.
_SPECIALIST_ROUTES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    # Information Marketplace must precede finance (kai claims the generic
    # "market"/"earnings" cues). Cues are QUALIFIED — bare "marketplace" is left
    # unrouted on purpose so One can ask which marketplace the user means
    # (Information Marketplace vs Kai Market Home).
    (
        "information_marketplace",
        "agent_personal_information",
        (
            "information marketplace",
            "data marketplace",
            "slice",
            "slices",
            "made available",
            "available to buyers",
            "available for buyers",
            "publish my data",
            "sell my data",
            "sell my information",
            "what have i published",
            "what data have i published",
            "subscription available on marketplace",
            "subscriptions available on marketplace",
            "subscriptions have i put available",
            "listings have i put available",
            "listing available on marketplace",
            "listings available on marketplace",
            "available on marketplace",
            "put available on marketplace",
            "my data worth",
            "from my data",
            "for my data",
            "access request",
            "my request for",
            "approve my request",
            "deny my request",
            "approve the request",
            "pending request",
        ),
    ),
    (
        "connected_systems_crm",
        "agent_connected_systems",
        (
            "crm",
            "salesforce",
            "connected system",
            "connected systems",
            "mulesoft",
            "contact record",
            "crm record",
        ),
    ),
    (
        "finance",
        "agent_kai",
        (
            "portfolio",
            "invest",
            "stock",
            "ticker",
            "market",
            "valuation",
            "dividend",
            "buy",
            "sell",
            "ria",
            "advisory",
            "fund",
            "retirement",
            "brokerage",
            "earnings",
        ),
    ),
    (
        "privacy_consent",
        "agent_nav",
        (
            "consent",
            "scope",
            "vault",
            "privacy",
            "delete my",
            "deletion",
            "revoke",
            "who has access",
            "suspicious",
            "data access",
        ),
    ),
    (
        "kyc_identity_workflow",
        "agent_kyc",
        (
            "kyc",
            "identity",
            "verify my identity",
            "passport",
            "driver",
            "document upload",
            "missing document",
            "accreditation",
        ),
    ),
    (
        "connections",
        "agent_connections",
        (
            "trusted connection",
            "trusted connections",
            "who do i trust",
            "people i trust",
            # broader conversational cues — all require a connection/request
            # qualifier so bare "accept"/"remove"/"connect" alone can't match
            "connect me with",
            "connect with",
            "add a connection",
            "my connections",
            "who are my connections",
            "list my connections",
            "remove connection",
            "remove from my connections",
            "connection request",
            "connection requests",
            "accept request",
            "reject request",
            "decline request",
            "pending connection",
        ),
    ),
    (
        "location",
        "agent_location",
        (
            "location",
            "where is",
            "where am i",
            "who can see me",
            "who can see my location",
            "share my location",
            "live location",
        ),
    ),
    (
        "email",
        "agent_email",
        (
            "needs a reply",
            "my inbox",
            "check my inbox",
            "my email",
            "my emails",
            "unread email",
            "emails from",
            "gmail",
        ),
    ),
)


def classify_specialist_domain(message: str) -> Optional[tuple[str, str]]:
    """Return ``(domain, target_agent)`` for a message, or ``None`` if general.

    This is the deterministic fallback router. It only delegates on a positive
    keyword match, so ambiguous or general chit-chat stays with One instead of
    being silently handed to a specialist (fail-closed delegation).
    """
    text = (message or "").strip().lower()
    if not text:
        return None
    for domain, target_agent, cues in _SPECIALIST_ROUTES:
        for cue in cues:
            if re.search(rf"(?<!\w){re.escape(cue)}(?!\w)", text):
                return domain, target_agent
    return None


@hushh_tool(scope="agent.kai.analyze", name="delegate_to_kai_agent")
def delegate_to_kai_agent() -> Dict[str, Any]:
    """Delegate current conversation to Kai, the finance specialist."""
    ctx = HushhContext.current()
    return _create_delegation_response("finance", "agent_kai", ctx)


@hushh_tool(scope="agent.nav.review", name="delegate_to_nav_agent")
def delegate_to_nav_agent() -> Dict[str, Any]:
    """Delegate current conversation to Nav, the privacy and consent guardian."""
    ctx = HushhContext.current()
    return _create_delegation_response("privacy_consent", "agent_nav", ctx)


@hushh_tool(scope="agent.kyc.process", name="delegate_to_kyc_agent")
def delegate_to_kyc_agent() -> Dict[str, Any]:
    """Delegate current conversation to KYC, the identity workflow specialist."""
    ctx = HushhContext.current()
    return _create_delegation_response("kyc_identity_workflow", "agent_kyc", ctx)


@hushh_tool(scope="agent.one.orchestrate", name="delegate_to_connections_agent")
def delegate_to_connections_agent() -> Dict[str, Any]:
    """Delegate current conversation to the trusted-connections specialist."""
    ctx = HushhContext.current()
    return _create_delegation_response("connections", "agent_connections", ctx)
