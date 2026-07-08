"""One ADK runtime: the real agent tree powering One's orchestration.

One is the head agent (relationship layer). Every product agent on the /one
home grid is a subagent wrapped as an ADK tool, so delegation is a single
LLM function-calling decision inside ADK's own flow instead of a parallel
client-side ranker. Google Search grounding gives One real web access.
"""

from hushh_mcp.one_adk.agent_tree import build_one_root_agent, get_one_runner

__all__ = ["build_one_root_agent", "get_one_runner"]
