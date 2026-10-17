"""Web search on One's head: Google Search grounding, which only a Gemini head has.

One's web search is ADK's ``GoogleSearchTool``, a Gemini built-in. ADK refuses it for
any other model ("Google search tool is not supported for model X"), so an Azure
OpenAI head (mode ``user_azure_mi``) or a Puppy head that held it would fail as a tool
error at the moment the person asked for something fresh. Such a head is never given
the tool, and its instruction says plainly that web search is not available on this
setup yet. Nothing stands in for it: no other search provider is added (founder rule,
no new provider API unasked).

The head declares its provider. Every non-Gemini head reaches One through
``ProviderAdkModel`` (built by ``text_runtime._runtime_model`` for ``puppy_relay``,
``user_azure_mi`` and the owner's sealed OpenAI key), which carries ``provider``. Any other head (the Gemini adapters, a
Gemini model id, a test double standing in for Gemini) keeps web search exactly as
before. The pod's capability report asks ``provider_supports_web_search`` too, so what
the pod says it can do and what its head can do are one decision.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool

from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.registry import is_known_provider, normalize_provider

#: The only provider whose head grounds on Google Search.
WEB_SEARCH_PROVIDER = "gemini"
#: The one short sentence One says when a request needs the web on any other head.
WEB_SEARCH_UNAVAILABLE_SENTENCE = "Web search is not available on this setup yet."
#: Appended to One's instruction on such a head. It overrides the identity text's
#: google_search guidance, because a call to a tool the head was not given is an error.
WEB_SEARCH_UNAVAILABLE_INSTRUCTION = (
    "\n\nWEB SEARCH: there is no google_search tool on this setup; ignore any earlier "
    "instruction to use it. When a request needs fresh public information from the "
    f'web, say in one short sentence: "{WEB_SEARCH_UNAVAILABLE_SENTENCE}" Then help '
    "from what you already know and say it may be out of date."
)


def provider_supports_web_search(provider: str | None) -> bool:
    """Whether a head on ``provider`` has web search. An unknown provider does not."""
    return is_known_provider(provider) and normalize_provider(provider) == WEB_SEARCH_PROVIDER


def head_provider(model: Any) -> str:
    """The provider One's head declares; a head that declares none is a Gemini head."""
    if isinstance(model, ProviderAdkModel):
        return str(model.provider or "").strip().lower()
    return WEB_SEARCH_PROVIDER


def head_supports_web_search(model: Any) -> bool:
    """Whether One's head on ``model`` may be given the Google Search tool."""
    return provider_supports_web_search(head_provider(model))


def instruction_for_head(model: Any, instruction: Callable[[Any], str]) -> Callable[[Any], str]:
    """One's ``instruction`` as is for a head with web search; plus the honest line otherwise.

    A Gemini head gets the very same callable back, so its instruction is unchanged.
    """
    if head_supports_web_search(model):
        return instruction

    def instruction_without_web_search(context: Any) -> str:
        return instruction(context) + WEB_SEARCH_UNAVAILABLE_INSTRUCTION

    return instruction_without_web_search


def web_search_tools(model: Any, *, manifest: Any) -> list[Any]:
    """One's search tool for a head on ``model``, or nothing when that head cannot search.

    The search runs as an isolated text agent on the head's own model: ADK executes
    Google Search grounding in that nested GenerateContent turn, and it must never
    inherit a native-audio Live model. ``manifest`` is One's, read at call time so an
    authored edit to the ``google_search`` child reaches the agent.
    """
    if not head_supports_web_search(model):
        return []
    child = next(item for item in manifest.subagents if item.id == "google_search")
    agent = LlmAgent(
        name=child.name,
        model=model,
        description=child.description,
        instruction=child.system_instruction,
        tools=[GoogleSearchTool()],
    )
    return [AgentTool(agent=agent, propagate_grounding_metadata=True)]


__all__ = [
    "WEB_SEARCH_PROVIDER",
    "WEB_SEARCH_UNAVAILABLE_INSTRUCTION",
    "WEB_SEARCH_UNAVAILABLE_SENTENCE",
    "head_provider",
    "head_supports_web_search",
    "instruction_for_head",
    "provider_supports_web_search",
    "web_search_tools",
]
