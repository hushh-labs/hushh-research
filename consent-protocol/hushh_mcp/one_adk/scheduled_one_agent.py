"""One's authored brain and roster, using the pinned native ADK task mode."""

from __future__ import annotations

from typing import Any

from google.adk.agents import LlmAgent

from hushh_mcp.services.pod_scheduled_authority import scheduled_tool_context
from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledOneResult


def build_scheduled_one_agent(*, model: Any, consent_bundle_lookup=None) -> LlmAgent:
    # Keep import-time registration and route composition independent of this
    # optional task execution head. The ordinary constructor owns every tool,
    # instruction and callback; task mode omits unbound client-only receipt tools.
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent

    return build_one_text_agent(
        model=model,
        allow_private_mcp=True,
        execution_mode="task",
        output_schema=ScheduledOneResult,
        consent_bundle_lookup=consent_bundle_lookup,
    )


def admitted_scheduled_surface(context: Any) -> bool:
    return bool(
        context.state.get("temp:one_execution_surface") == "scheduled_task"
    ) and scheduled_tool_context(context)


def scheduled_finish_tool(tool: Any, context: Any) -> bool:
    if not admitted_scheduled_surface(context) or getattr(context, "agent_name", None) != "one":
        return False
    # Pinned ADK 2.9 installs this tool during native task construction. A tool
    # named finish_task, or a child task's terminal, cannot bypass the read wall.
    from google.adk.agents.llm.task._finish_task_tool import FinishTaskTool

    return (
        isinstance(tool, FinishTaskTool)
        and tool._task_agent_name == "one"
        and tool.output_schema is ScheduledOneResult
    )
