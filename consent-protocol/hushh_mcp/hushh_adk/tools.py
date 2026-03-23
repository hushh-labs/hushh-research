"""
Hushh ADK Tooling Decorators

Provides the @hushh_tool decorator to wrap python functions as ADK tools
while enforcing:
1. Active HushhContext existence
2. Scope validation against the current consent token
"""

import asyncio
import functools
import logging
from typing import Callable, Optional

from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
from hushh_mcp.consent.token import validate_token
from hushh_mcp.hushh_adk.context import HushhContext

logger = logging.getLogger(__name__)


def hushh_tool(scope: str, name: Optional[str] = None):
    """
    Decorator to mark a function as a Hushh Agent Tool.

    Enforces security protocols BEFORE the tool logic runs.
    Supports both sync and async functions.

    Args:
        scope: The required consent scope (e.g., 'attr.financial.holdings')
        name: Optional override for the tool name
    """

    def decorator(func: Callable):
        tool_name = name or func.__name__
        is_async = asyncio.iscoroutinefunction(func)

        def _validate_context_and_scope():
            """Common validation logic for both sync and async wrappers."""
            # 1. Get Active Context
            ctx = HushhContext.current()
            if not ctx:
                error_msg = (
                    f"Security Violation: Tool '{tool_name}' called without active HushhContext."
                )
                logger.critical(error_msg)
                raise PermissionError(error_msg)

            # 2. Validate Token Scope (resolve PKM scope string to enum)
            expected = resolve_scope_to_enum(scope) if isinstance(scope, str) else scope
            valid, reason, token_obj = validate_token(ctx.consent_token, expected_scope=expected)

            if not valid:
                error_msg = f"Consent Denied for '{tool_name}': {reason}"
                logger.warning(f"{error_msg} (User: {ctx.user_id})")
                raise PermissionError(error_msg)

            # 3. Verify User Identity integrity
            if token_obj.user_id != ctx.user_id:
                error_msg = "Identity Spoofing Detected: Token user does not match context user."
                logger.critical(error_msg)
                raise PermissionError(error_msg)

            return ctx

        if is_async:

            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs):
                ctx = _validate_context_and_scope()

                # Execute Tool (async)
                logger.info(f"Tool '{tool_name}' executing for {ctx.user_id} [Scope: {scope}]")
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    logger.error(f"Tool '{tool_name}' failed: {str(e)}")
                    raise e

            # Attach metadata for ADK compatibility
            async_wrapper._hushh_tool = True
            async_wrapper._scope = scope
            async_wrapper._name = tool_name
            async_wrapper._is_async = True

            return async_wrapper
        else:

            @functools.wraps(func)
            def sync_wrapper(*args, **kwargs):
                ctx = _validate_context_and_scope()

                # Execute Tool (sync)
                logger.info(f"Tool '{tool_name}' executing for {ctx.user_id} [Scope: {scope}]")
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    logger.error(f"Tool '{tool_name}' failed: {str(e)}")
                    raise e

            # Attach metadata for ADK compatibility
            sync_wrapper._hushh_tool = True
            sync_wrapper._scope = scope
            sync_wrapper._name = tool_name
            sync_wrapper._is_async = False

            return sync_wrapper

    return decorator
