"""
Agent One Orchestrator (ADK Port)

Central routing agent that uses LLM semantic understanding to delegate tasks.
Keeps the legacy orchestrator package path while One becomes the product owner.
"""

import logging
import os
from typing import Any, Dict

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

# Import tools for registration
from .tools import (
    _create_delegation_response,
    classify_specialist_domain,
    delegate_to_kai_agent,
    delegate_to_kyc_agent,
    delegate_to_nav_agent,
)

logger = logging.getLogger(__name__)

# Feature flag: ADK-native delegation (LLM tool loop / transfer_to_agent) for
# One stays OFF by default until the Phase 4 realtime/agent benchmark justifies
# adopting the ADK runtime over the deterministic classifier. When disabled, the
# deterministic, fail-closed classifier is the sole router, which is the proven,
# testable path. Set AGENT_ONE_ADK_DELEGATION=1 (or true/on/yes) to opt in.
_ADK_DELEGATION_ENABLED_VALUES = {"1", "true", "on", "yes", "enabled"}


def adk_delegation_enabled() -> bool:
    return (
        os.getenv("AGENT_ONE_ADK_DELEGATION", "").strip().lower() in _ADK_DELEGATION_ENABLED_VALUES
    )


class OrchestratorAgent(HushhAgent):
    """
    Compatibility wrapper for Agent One.
    """

    # Pydantic field (ADK 2.x LlmAgent is a pydantic model with extra="forbid");
    # plain attribute assignment before super().__init__ raises there.
    manifest: Any = None

    def __init__(self):
        # Load manifest
        manifest_path = os.path.join(os.path.dirname(__file__), "..", "one", "agent.yaml")
        manifest = ManifestLoader.load(manifest_path)

        # Initialize ADK Agent with tools. ADK 2.x requires `name` to be a
        # valid Python identifier; the manifest id ("agent_one") qualifies,
        # while the display name ("Agent One") does not.
        super().__init__(
            name=manifest.name if manifest.name.isidentifier() else "agent_one",
            model=manifest.model,
            system_prompt=manifest.system_instruction,
            tools=[delegate_to_kai_agent, delegate_to_nav_agent, delegate_to_kyc_agent],
            required_scopes=manifest.required_scopes,
        )
        self.manifest = manifest

    def handle_message(
        self,
        message: str,
        user_id: str,
        consent_token: str = "",
        persona: str = "investor",
    ) -> Dict[str, Any]:
        """
        Main entry point for routing.

        Resolution order:
        1. Fail-closed: require a token carrying ``cap.one.invoke``.
        2. Classify intent into a specialist domain (finance/privacy/identity).
        3. If a specialist is selected, validate the specialist-specific A2A
           consent scope before surfacing the delegation handoff.
        4. Otherwise One answers general requests directly.

        The Google ADK LLM tool loop remains the primary router when ADK is
        installed; the deterministic classifier is the fail-closed fallback so
        delegation resolves reliably (and testably) without a live model.

        Args:
            message: User input
            user_id: User identifier
            consent_token: Invocation token with `cap.one.invoke`

        Returns:
            Dict containing response text and optional delegation info.
        """
        token = consent_token

        # 1. Fail-closed invocation gate. This permits task routing only; every
        # specialist and data operation enforces its own attenuated authority.
        valid, reason, _ = validate_token(token, expected_scope=ConsentScope.CAP_ONE_INVOKE)
        if not valid:
            logger.warning("orchestrator.access_denied reason=%s", reason)
            return {
                "response": "I can't route that request without an active session. Please sign in and try again.",
                "delegation": None,
                "error": f"invoke_scope_denied: {reason}",
            }

        # 2. Deterministic intent classification.
        classification = classify_specialist_domain(message)
        if classification is None:
            return {
                "response": self._direct_response(message, persona=persona),
                "delegation": None,
            }

        domain, target_agent = classification

        # 3. Surface the delegation handoff.
        #
        # Token model note: a Hushh consent token carries a single scope, so the
        # orchestrate-scoped token above authorizes One to *decide* a handoff.
        # The least-privilege specialist A2A scope is enforced at the specialist
        # boundary itself (see adk_bridge.kai_agent.validate_a2a_consent_token),
        # not re-checked here, which keeps each agent's gate independent.
        delegation = _create_delegation_response(domain, target_agent, None)
        logger.info("orchestrator.delegated target=%s domain=%s", target_agent, domain)
        return {
            "response": delegation["message"],
            "delegation": delegation,
        }

    @staticmethod
    def _direct_response(message: str, persona: str = "investor") -> str:
        """Lightweight first-line reply for general (non-specialist) requests.

        The persona lens keeps One's framing consistent with the realtime-voice
        persona composer (investor vs RIA) from Phase 3.
        """
        from hushh_mcp.services.agent_persona import normalize_persona

        normalized = normalize_persona(persona)
        practice = "your practice" if normalized == "ria" else "your money"
        return (
            "Hi, I'm One, your personal agent in Hussh. I can bring in finance (Kai) "
            f"for {practice}, privacy and consent (Nav), or identity (KYC) specialists "
            "when you need them. What would you like to do?"
        )


# Singleton
_orchestrator = None


def get_orchestrator():
    global _orchestrator
    if not _orchestrator:
        _orchestrator = OrchestratorAgent()
    return _orchestrator
