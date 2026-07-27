"""DB read adapter for the versioned agent-prompt store (migration 901).

Read-only in Phase 0: resolves the single ``active`` prompt row for an
``(agent_id, channel)`` pair from ``agent_prompt_versions``. The "flip active"
contract (at most one active row per agent/channel) is enforced by the migration's
partial unique index, so a plain ``status = 'active'`` lookup is unambiguous.

The client is injectable so the repo is hermetically testable with a fake; in
production it resolves the shared ``db.db_client.get_db()`` client lazily. Mirrors
the access pattern of ``PersonalAgentRegistryRepo``.
"""

from __future__ import annotations

from typing import Any, Optional

from db.db_client import get_db

_TABLE = "agent_prompt_versions"


class PersonalAgentPromptRepo:
    """Read-only CRUD over the versioned agent-prompt store."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def get_active(self, agent_id: str, channel: str) -> Optional[dict]:
        """Return the single active prompt row for ``(agent_id, channel)``, or None."""
        response = (
            self._db()
            .table(_TABLE)
            .select("*")
            .eq("agent_id", agent_id)
            .eq("channel", channel)
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        rows = response.data or []
        return rows[0] if rows else None
