from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from hussh_sdk.agent import HusshAgent


class HusshAdkImportError(ImportError):
    """Raised when ADK integration is requested without Google ADK installed."""


def create_personal_agent(
    *,
    name: str,
    model: Any,
    instruction: str,
    hussh_agent: HusshAgent | None = None,
    extra_tools: Sequence[Callable[..., Any]] | None = None,
    **kwargs: Any,
) -> Any:
    """Create a Google ADK personal agent with Hussh consent tools installed."""
    if hussh_agent is None:
        from hussh_sdk.factory import create_agent

        agent = create_agent(
            name=name,
            runtime="google_adk",
            model=model if isinstance(model, str) else None,
        )
    else:
        agent = hussh_agent
    return _build_adk_agent(
        agent,
        name=name,
        model=model,
        instruction=instruction,
        extra_tools=extra_tools,
        **kwargs,
    )


def _hussh_adk_tools(agent: HusshAgent) -> list[Callable[..., Any]]:
    """Return Google ADK-compatible tools backed by Hussh consent methods."""

    async def hussh_know(
        domain: str, reason: str, fields: list[str] | None = None
    ) -> dict[str, Any]:
        """
        Request consented personal context from Hussh before using it.

        Args:
            domain: The Hussh vault domain to request.
            reason: The consent justification shown to the user.
            fields: The minimum fields needed from the domain.
        """
        context = await agent.know(domain=domain, reason=reason, fields=fields or [])
        if context is None:
            return {"status": "declined", "context": None}
        return {"status": "approved", "context": context}

    async def hussh_do(action: str, preview: str, confirm: bool = True) -> dict[str, Any]:
        """
        Request user confirmation before taking an action.

        Args:
            action: The action the personal agent wants to take.
            preview: The human-readable action preview.
            confirm: Whether explicit confirmation is required.
        """
        approved = await agent.do(action=action, preview=preview, confirm=confirm)
        return {"status": "approved" if approved else "declined"}

    async def hussh_remember(content: str, domain: str) -> dict[str, Any]:
        """
        Request consent before writing an insight back to the user's vault.

        Args:
            content: The insight or memory to store.
            domain: The Hussh vault domain where the insight belongs.
        """
        stored = await agent.remember(content=content, domain=domain)
        return {"status": "stored" if stored else "declined"}

    return [hussh_know, hussh_do, hussh_remember]


def _build_adk_agent(
    hussh_agent: HusshAgent,
    *,
    name: str,
    model: Any,
    instruction: str,
    extra_tools: Sequence[Callable[..., Any]] | None = None,
    **kwargs: Any,
) -> Any:
    """Build a Google ADK agent with Hussh consent tools installed.

    The model argument is passed through unchanged so BYOK callers can provide
    a Gemini model string, a LiteLLM-backed model, or any ADK-supported model.
    """
    agent_class = _load_adk_agent_class()
    tools = [*_hussh_adk_tools(hussh_agent), *(extra_tools or [])]
    return agent_class(
        name=name,
        model=model,
        instruction=instruction,
        tools=tools,
        **kwargs,
    )


def _load_adk_agent_class() -> type[Any]:
    try:
        from google.adk.agents import Agent

        return Agent
    except ImportError:
        try:
            from google.adk import Agent

            return Agent
        except ImportError as exc:
            raise HusshAdkImportError(
                "Google ADK is not installed. Install the Hussh SDK with the 'adk' extra "
                "before calling create_personal_agent()."
            ) from exc
