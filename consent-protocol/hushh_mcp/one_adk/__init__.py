"""One ADK runtime: the real agent tree powering One's orchestration.

One is the head agent (relationship layer). Every product agent on the /one
home grid is a subagent wrapped as an ADK tool, so delegation is a single
LLM function-calling decision inside ADK's own flow instead of a parallel
client-side ranker. Google Search grounding gives One real web access.
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hushh_mcp.one_adk.agent_tree import build_one_root_agent, get_one_runner

__all__ = ["build_one_root_agent", "get_one_runner"]


def __getattr__(name: str) -> Any:
    # Credential and codec leaves are also used by Drive workers. Importing one
    # must not initialize the entire chat roster or its action contracts.
    if name not in __all__:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from hushh_mcp.one_adk import agent_tree

    value = getattr(agent_tree, name)
    globals()[name] = value
    return value
