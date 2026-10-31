"""Compatibility exports for the retired Live task-context module name.

Active command and typed-agent callers import ``agent_task_context``. This
module preserves historical imports without restoring a Live transport.
"""

from hushh_mcp.services.agent_task_context import *  # noqa: F403
from hushh_mcp.services.agent_task_context import (
    clear_agent_task_context,
    publish_agent_task_context,
    read_agent_task_context,
)

clear_live_voice_context = clear_agent_task_context
publish_live_voice_context = publish_agent_task_context
read_live_voice_context = read_agent_task_context
