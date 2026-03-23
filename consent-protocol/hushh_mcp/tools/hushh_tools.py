"""
Hushh ADK Tooling Decorators

Provides the @hushh_tool decorator to wrap python functions as ADK tools
while enforcing:
1. Active HushhContext existence
2. Scope validation against the current consent token
"""

import functools
import logging
from typing import Callable, Optional

from hushh_mcp.consent.token import validate_token
from hushh_mcp.hushh_adk.context import HushhContext

logger = logging.getLogger(__name__)


def hushh_tool(scope: str, name: Optional[str] = None):
    """
    Decorator to mark a function as a Hushh Agent Tool.

    Enforces security protocols BEFORE the tool logic runs.

    Args:
        scope: The required consent scope (e.g. attr.food.* or pkm.read)
        name: Optional override for the tool name
    """

    def decorator(func: Callable):
        tool_name = name or func.__name__

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # 1. Get Active Context
            ctx = HushhContext.current()
            if not ctx:
                error_msg = (
                    f"❌ Security Violation: Tool '{tool_name}' called without active HushhContext."
                )
                logger.critical(error_msg)
                raise PermissionError(error_msg)

            # 2. Validate Token Scope
            # We validate that the token CARRIED by the context allows this specific tool action
            valid, reason, token_obj = validate_token(ctx.consent_token, expected_scope=scope)

            if not valid:
                error_msg = f"⛔ Consent Denied for '{tool_name}': {reason}"
                logger.warning(f"{error_msg} (User: {ctx.user_id})")
                raise PermissionError(error_msg)

            # 3. Verify User Identity integrity
            if token_obj.user_id != ctx.user_id:
                error_msg = "❌ Identity Spoofing Detected: Token user does not match context user."
                logger.critical(error_msg)
                raise PermissionError(error_msg)

            # 4. Execute Tool
            logger.info(f"🔧 Tool '{tool_name}' executing for {ctx.user_id} [Scope: {scope}]")
            try:
                return func(*args, **kwargs)
            except Exception as e:
                logger.error(f"⚠️ Tool '{tool_name}' failed: {str(e)}")
                raise e

        # Attach metadata for ADK compatibility
        wrapper._hushh_tool = True
        wrapper._scope = scope
        wrapper._name = tool_name

        return wrapper

    return decorator
