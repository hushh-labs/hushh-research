"""Compatibility containment for the retired One keyword router.

The canonical One text and Live heads in :mod:`hushh_mcp.one_adk` are the only
surfaces allowed to assess a person's meaning.  This module keeps the old
``hushh_mcp.agents.orchestrator`` import path alive for the bounded external
invocation-preview endpoint, but it intentionally cannot select or invoke a
specialist.  A ``cap.one.invoke`` grant authorizes that preview invocation; it
is not enough authority to infer a specialist or execute a protected task.
"""

import logging
from typing import Any, Dict

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope

logger = logging.getLogger(__name__)


class OrchestratorAgent:
    """
    Compatibility wrapper for Agent One.
    """

    def handle_message(
        self,
        message: str,
        user_id: str,
        consent_token: str = "",
        persona: str = "investor",
    ) -> Dict[str, Any]:
        """Return a bounded preview response without semantic routing.

        This is intentionally a containment boundary, not a degraded fallback
        router.  No message words are parsed and no specialist handoff is
        created here.  A caller that needs semantic One behavior must use the
        authenticated Agent Chat or Live transport, where the manifest-built
        One head receives the route, vault, authority, and confirmation state.
        """
        del message, user_id, persona
        valid, reason, _ = validate_token(consent_token, expected_scope=ConsentScope.CAP_ONE_INVOKE)
        if not valid:
            logger.warning("orchestrator.access_denied reason=%s", reason)
            return {
                "response": "I can't route that request without an active session. Please sign in and try again.",
                "delegation": None,
                "error": f"invoke_scope_denied: {reason}",
            }
        return {
            "response": (
                "This invocation preview confirmed your One access, but it cannot "
                "select a specialist or perform a protected task. Use Agent Chat or "
                "Live after unlocking the vault so One can assess the request with "
                "the current consent, route, and confirmation state."
            ),
            "delegation": None,
            "status": "semantic_runtime_required",
        }


# Singleton
_orchestrator = None


def get_orchestrator():
    global _orchestrator
    if not _orchestrator:
        _orchestrator = OrchestratorAgent()
    return _orchestrator
