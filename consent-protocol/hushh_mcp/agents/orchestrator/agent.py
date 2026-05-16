"""
Agent One Orchestrator (ADK Port)

Central routing agent that uses LLM semantic understanding to delegate tasks.
Keeps the legacy orchestrator package path while One becomes the product owner.
"""

import logging
import os
from typing import Any, Dict, Optional

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader

# Import tools for registration
from .tools import delegate_to_kai_agent, delegate_to_kyc_agent, delegate_to_nav_agent

logger = logging.getLogger(__name__)

# Typed errors – callers can catch these individually instead of bare Exception

class OrchestratorError(Exception):
    """Base class for all orchestrator failures."""

class OrchestratorConsentError(OrchestratorError):
    """Raised when the consent token is missing, expired, or lacks the required scope."""

class OrchestratorAgentError(OrchestratorError):
    """Raised when the underlying ADK agent or LLM call fails."""

class OrchestratorDelegationError(OrchestratorError):
    """Raised when a tool returned a delegation dict but the target agent is unknown."""

# Response type alias (avoids Dict[str, Any] everywhere)

OrchestratorResult = Dict[str, Any]

# Known delegation targets – extend this when new sub-agents are added.
_KNOWN_TARGETS = frozenset(
    {
        "agent_kai",
        "agent_nav",
        "agent_kyc",
    }
)


class OrchestratorAgent(HushhAgent):
    """
    Compatibility wrapper for Agent One.

    Routing logic
    1.  ``run()`` is called on the ADK agent.  The ADK runtime invokes whichever
        delegation tool the LLM picks.  Every tool in ``tools.py`` returns a
        dict with ``{"delegated": True, "target_agent": "<id>", ...}``.
    2.  ``run()`` (via ``HushhAgent``) returns the raw ADK response object.
        We inspect ``.tool_results`` (a list of dicts appended by
        ``HushhAgent``) to detect whether a delegation tool fired.
    3.  If a delegation result is present we surface it as ``delegation`` in the
        return value so the API layer can redirect the session.
    4.  If no tool fired the LLM answered directly; we return its text.
    """

    def __init__(self) -> None:
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        self.manifest = ManifestLoader.load(manifest_path)

        super().__init__(
            name=self.manifest.name,
            model=self.manifest.model,
            system_prompt=self.manifest.system_instruction,
            tools=[delegate_to_kai_agent, delegate_to_nav_agent, delegate_to_kyc_agent],
            required_scopes=self.manifest.required_scopes,
        )

    # Public API

    def handle_message(
        self,
        message: str,
        user_id: str,
        consent_token: str = "",
    ) -> OrchestratorResult:
        """
        Main entry point for routing.

        Args:
            message:        User input.
            user_id:        User identifier.
            consent_token:  Token carrying ``agent.one.orchestrate`` scope.

        Returns:
            A dict with the following guaranteed keys:

            ``response`` (str)
                Human-readable text from the LLM, or an explanatory message
                when a hard delegation occurred and no additional text was
                produced.

            ``delegation`` (dict | None)
                Present and non-None only when a delegation tool fired.
                Shape: ``{"delegated": True, "target_agent": str, "domain": str,
                           "message": str}``

            ``error`` (str | None)
                Set only on failure paths; always absent on success.

        Raises:
            OrchestratorConsentError:   Token validation failed before the LLM
                                        was even invoked (raised by HushhAgent).
            OrchestratorAgentError:     The ADK / LLM call itself failed.
            OrchestratorDelegationError: A tool returned an unrecognised target.
        """
        if not consent_token:
            # Surface missing token early with a typed error so the API route
            # can return 401 rather than a generic 500.
            raise OrchestratorConsentError(
                "consent_token is required for agent.one.orchestrate"
            )

        try:
            response = self.run(message, user_id=user_id, consent_token=consent_token)
        except PermissionError as exc:
            # HushhAgent raises PermissionError for invalid/missing scope – re-wrap
            # so callers get a typed OrchestratorConsentError, not a bare PermissionError.
            logger.warning(
                "Orchestrator consent denied for user=%s: %s",
                user_id,
                exc,
            )
            raise OrchestratorConsentError(str(exc)) from exc
        except Exception as exc:
            # Any other ADK / LLM failure: log the full traceback, then re-raise
            # as a typed error.  logger.exception() captures the traceback
            # automatically – no need to format the stack manually.
            logger.exception(
                "Orchestrator ADK call failed for user=%s message=%r",
                user_id,
                message[:120],
            )
            raise OrchestratorAgentError(
                f"ADK agent run failed: {exc}"
            ) from exc

        # Inspect tool results for delegation
        delegation: Optional[Dict[str, Any]] = self._extract_delegation(response)

        if delegation is not None:
            target = delegation.get("target_agent", "")
            if target not in _KNOWN_TARGETS:
                logger.error(
                    "Orchestrator received delegation to unknown target=%r "
                    "(user=%s).  Refusing to forward.",
                    target,
                    user_id,
                )
                raise OrchestratorDelegationError(
                    f"Unknown delegation target: {target!r}"
                )

            logger.info(
                "Orchestrator delegating user=%s to target=%s domain=%s",
                user_id,
                target,
                delegation.get("domain"),
            )

        # Extract LLM text response
        response_text: str = self._extract_text(response)

        return {
            "response": response_text,
            "delegation": delegation,
        }

    # Private helpers

    @staticmethod
    def _extract_delegation(response: Any) -> Optional[Dict[str, Any]]:
        """
        Pull the first delegation dict out of the ADK response's tool results.

        HushhAgent (and the underlying ADK LlmAgent) accumulates tool call
        results in ``response.tool_results`` as a list of dicts.  Each dict
        produced by our delegation tools has ``{"delegated": True, ...}``.

        Falls back gracefully when the attribute is absent (e.g. when running
        against the development stub in ``hushh_adk/core.py``).
        """
        tool_results = getattr(response, "tool_results", None) or []

        for result in tool_results:
            if isinstance(result, dict) and result.get("delegated") is True:
                return result

        return None

    @staticmethod
    def _extract_text(response: Any) -> str:
        """
        Return the LLM text from the ADK response object.

        Tries ``response.text`` first (standard ADK ``GenerateContentResponse``),
        then ``str(response)`` as a fallback so we never return an empty string
        silently.
        """
        text = getattr(response, "text", None)
        if isinstance(text, str) and text.strip():
            return text

        # ADK may return a Content object with .parts
        parts = getattr(response, "parts", None)
        if parts:
            joined = " ".join(
                getattr(p, "text", "") for p in parts if getattr(p, "text", None)
            )
            if joined.strip():
                return joined

        fallback = str(response)
        if fallback and fallback != "None":
            return fallback

        return ""

# Module-level singleton
_orchestrator: Optional[OrchestratorAgent] = None


def get_orchestrator() -> OrchestratorAgent:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = OrchestratorAgent()
    return _orchestrator