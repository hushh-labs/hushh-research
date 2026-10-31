"""Compatibility exports for the retired Live-context module name.

Active command and typed-chat callers import ``agent_context``. This module
keeps historical imports and tests working without restoring a Live transport.
"""

from api.routes.one.agent_context import *  # noqa: F403
from api.routes.one.agent_context import (
    AGENT_CAPABILITY_CAP,
    AGENT_CONTEXT_ARRAY_CAP,
    AGENT_CONTEXT_STRING_CAP,
    AGENT_MODULE_CAP,
    AGENT_SCREEN_STATE_CAP,
    AGENT_SCREEN_STATE_KEY_CAP,
    sanitize_agent_context,
)

# Stable compatibility symbols for integrations that have not yet moved to the
# command-neutral API. No active runtime path imports these names.
LIVE_CONTEXT_STRING_CAP = AGENT_CONTEXT_STRING_CAP
LIVE_CONTEXT_ARRAY_CAP = AGENT_CONTEXT_ARRAY_CAP
LIVE_MODULE_CAP = AGENT_MODULE_CAP
LIVE_SCREEN_STATE_CAP = AGENT_SCREEN_STATE_CAP
LIVE_SCREEN_STATE_KEY_CAP = AGENT_SCREEN_STATE_KEY_CAP
LIVE_CAPABILITY_CAP = AGENT_CAPABILITY_CAP
sanitize_live_context = sanitize_agent_context
