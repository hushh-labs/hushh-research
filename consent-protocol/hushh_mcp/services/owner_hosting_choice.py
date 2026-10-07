"""The person's explicit Hussh Shared choice, recorded in their pre-vault state.

Shared is a choice, never a default (founder direction, 2026-10-06). This is the one
writer and reader of that choice (``vault_keys.one_hosting_choice``, migration 955).
It records a tier word and a time, nothing else; ``personal_agent_hosting`` compares
the time with the person's last detach.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

SHARED_TIER = "shared"

_READ = """
SELECT one_hosting_choice AS tier, one_hosting_choice_at AS chosen_at
FROM vault_keys WHERE user_id = :owner
"""

_RECORD = """
UPDATE vault_keys
SET one_hosting_choice = 'shared', one_hosting_choice_at = now()
WHERE user_id = :owner
RETURNING one_hosting_choice AS tier, one_hosting_choice_at AS chosen_at
"""


class HostingChoiceUnavailable(RuntimeError):
    """The choice could not be recorded; the person's placement is unchanged."""


class HostingChoiceRepo:
    """Read and record the explicit Shared choice on the person's pre-vault row."""

    def __init__(self, client: Any = None, vault_keys: Any = None) -> None:
        self._client = client
        self._vault_keys = vault_keys

    def _db(self) -> Any:
        if self._client is not None:
            return self._client
        from db.db_client import get_db

        return get_db()

    async def get(self, user_id: str) -> Optional[dict]:
        """The recorded choice, or None. Raises when it cannot be read (never Shared)."""
        response = await asyncio.to_thread(self._db().execute_raw, _READ, {"owner": user_id})
        rows = list(response.data or [])
        if not rows or rows[0].get("tier") != SHARED_TIER or rows[0].get("chosen_at") is None:
            return None
        return {"tier": SHARED_TIER, "chosen_at": rows[0]["chosen_at"]}

    async def record_shared(self, user_id: str) -> dict:
        """Record Shared now. The pre-vault row is created first when it does not exist."""
        service = self._vault_keys
        if service is None:
            from hushh_mcp.services.vault_keys_service import VaultKeysService

            service = VaultKeysService()
        await service.get_pre_vault_state(user_id)  # ensures the row
        response = await asyncio.to_thread(self._db().execute_raw, _RECORD, {"owner": user_id})
        rows = list(response.data or [])
        if not rows:
            raise HostingChoiceUnavailable("the pre-vault row was not available")
        logger.info("owner_hosting_choice.recorded tier=shared")
        return {"tier": SHARED_TIER, "chosen_at": rows[0].get("chosen_at")}


async def write_cloud_setup_marker(user_id: str) -> None:
    """Record that this person finished the "where does my agent live" step.

    Server-written, never client-asserted: a marker that can exist without a real,
    recorded decision is a gate that does nothing. Every door (Shared, Hussh Pods,
    a recorded own cloud) satisfies the setup hub's one ``cloud`` capability marker
    through this same write, so the frontend never needs a second gating rule.
    Never raises: the choice is recorded elsewhere and the marker can be retried.
    """
    try:
        from hushh_mcp.onboarding_contract import normalize_setup_capability_ids
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        service = VaultKeysService()
        state = await service.get_pre_vault_state(user_id)
        current = list(state.get("setupCapabilityIds") or [])
        if "cloud" not in current:
            await service.update_pre_vault_state(
                user_id=user_id,
                setup_capability_ids=normalize_setup_capability_ids([*current, "cloud"]),
            )
    except Exception:  # noqa: BLE001 - the choice is recorded; the marker can be retried
        logger.warning("one_cloud_choice.marker_write_failed", exc_info=True)


__all__ = [
    "HostingChoiceRepo",
    "HostingChoiceUnavailable",
    "SHARED_TIER",
    "write_cloud_setup_marker",
]
