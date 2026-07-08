"""
Hushh ADK Base Agent

The base class for all HUSHH-compliant agents.
It wraps the Google ADK patterns but injects our strict security loop.
"""

import logging
from typing import Any, Dict, List, Optional

from hushh_mcp.consent.token import validate_token
from hushh_mcp.hushh_adk.context import HushhContext

logger = logging.getLogger(__name__)


# INTENTIONAL STUB: this legacy base powers the Kai debate agents
# (fundamental/sentiment/valuation/orchestrator/portfolio_import), which were
# built against stub semantics: plain attribute assignment before
# super().__init__ and display names with spaces. ADK 2.x's pydantic LlmAgent
# (extra="forbid", identifier-validated names) rejects both, and these agents
# never invoke ADK's model loop (DebateEngine calls their methods directly).
# Real ADK agents live in the One orchestration runtime, not here.
class LlmAgent:
    def __init__(self, **kwargs):
        pass

    def run(self, **kwargs):
        pass


class HushhAgent(LlmAgent):
    """
    Secure Wrapper around Google ADK LlmAgent.

    Enforces:
    1. Consent Token Validation at Entry
    2. Context Injection for Tools
    3. Structured Logging
    """

    def __init__(
        self,
        name: str,
        model: Any,  # ModelClient or string
        tools: Optional[List[Any]] = None,
        system_prompt: str = "",
        required_scopes: Optional[List[str]] = None,
    ):
        """
        Initialize Secure Agent.

        Args:
            name: Agent identifier
            model: The LLM client (ADK ModelClient)
            tools: List of @hushh_tool decorated functions
            system_prompt: Core instruction
            required_scopes: List of scopes this agent MUST have to even start
        """
        self.hushh_name = name
        self.required_scopes = required_scopes or []
        tools = tools or []

        # Initialize parent ADK agent with correct parameters
        super().__init__(
            model=model,
            tools=tools,
            system_instruction=system_prompt,  # ADK uses 'system_instruction' not 'prompt'
        )

    def run(
        self,
        prompt: str,
        user_id: str,
        consent_token: str,
        vault_keys: Optional[Dict[str, str]] = None,
    ) -> Any:
        """
        Secure Execution Entry Point.

        Replaces standard .run() with one that requires Auth.
        """
        logger.info("🤖 Agent '%s' invoked (user=[redacted])", self.hushh_name)

        # 1. Base Validation
        # Check if token allows accessing THIS agent
        is_valid = False
        last_reason = "No scopes defined"

        if not self.required_scopes:
            is_valid = True  # No specific agent-level scope needed, relying on tools
        else:
            for scope in self.required_scopes:
                valid, reason, _ = validate_token(consent_token, expected_scope=scope)
                if valid:
                    is_valid = True
                    break
                last_reason = reason

        if not is_valid:
            error_msg = f"⛔ Agent Access Denied: {last_reason}"
            logger.warning(error_msg)
            raise PermissionError(error_msg)

        # 2. Context Injection
        # We start a context block. All tools called by the LLM within super().run()
        # will be able to access this context via HushhContext.current()

        with HushhContext(
            user_id=user_id,
            consent_token=consent_token,
            vault_keys=vault_keys or {},
        ):
            try:
                # 3. Delegate to ADK LlmAgent with proper parameter passing
                response = super().run(input=prompt)
                return response
            except Exception as e:
                logger.error(f"💥 Agent Failure: {str(e)}")
                raise e
