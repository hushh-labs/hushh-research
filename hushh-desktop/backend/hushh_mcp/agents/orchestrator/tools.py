"""
Orchestrator Tools

Delegation functions for One, the top personal agent.
These tools are used by the LLM to route requests to specialized agents.
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


@hushh_tool(scope="agent.one.orchestrate", name="delegate_to_food_agent")
def delegate_to_food_agent() -> Dict[str, Any]:
    """Deprecated compatibility delegate for older roadmap experiments."""
    ctx = HushhContext.current()
    return _create_delegation_response("food_dining", "agent_food_dining", ctx)


@hushh_tool(scope="agent.one.orchestrate", name="delegate_to_professional_agent")
def delegate_to_professional_agent() -> Dict[str, Any]:
    """Deprecated compatibility delegate for older roadmap experiments."""
    ctx = HushhContext.current()
    return _create_delegation_response("professional_profile", "agent_professional_profile", ctx)


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
