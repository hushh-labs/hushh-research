"""Owner-bound presentation of the explicitly enabled Shared recovery mode.

This pure observation never selects hosting, clears setup, or grants content access.
The existing placement reader remains authoritative for all execution and custody.
"""

from __future__ import annotations

import asyncio

from hushh_mcp.runtime_settings import shared_experience_recovery_enabled
from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode


async def shared_recovery_for_owner(owner: str) -> bool:
    if not owner or not shared_experience_recovery_enabled():
        return False
    try:
        mode = await asyncio.wait_for(get_owner_hosting_mode(owner), timeout=2)
    except Exception:  # Unknown placement retains its existing recovery path.
        return False
    return mode in {"shared", "unplaced"}
