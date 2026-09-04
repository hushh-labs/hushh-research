"""Retired compatibility tool definitions for the legacy One package.

Canonical One tool ownership lives in ``hushh_mcp.one_adk.agent_tree``.  This
module remains only for import compatibility with older integrations; it
contains explicit delegation descriptors but no message classifier.
"""

from typing import Any, Dict

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
