"""Voice and typed command checkpoints held by the owner's own agent.

The hub's ``CommandCheckpointStore`` keeps a command's plan digest and progress in
the hub database. For an owner whose agent runs in their own cloud the plan, its
query and the screen it came from must not reach the hub, so the agent validates
the plan and holds its checkpoint here instead. The app then performs each step
through the same typed effect a button tap sends.

Process memory, by design: a checkpoint lives only as long as the command it
tracks (``TTL_SECONDS``), the pod has one owner, and a pod that restarts mid-command
returns "not found", which the app already handles by starting the command again.
Nothing is lost that the app cannot recompute, and nothing is persisted that a
later reader could recover.

Contract (the subset of ``CommandCheckpointStore`` the pod routes use):

* **Owner-bound.** Keyed by (owner, command id); another owner reads nothing.
* **Compare-and-set.** ``update`` names the revision it read; a stale revision is a
  ``CommandCheckpointConflict``, never a silent overwrite.
* **Bounded.** At most ``MAX_PER_OWNER`` live checkpoints; expired ones are purged
  before a create is refused.
"""

from __future__ import annotations

import copy
import threading
import time
from typing import Any

from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict

TTL_SECONDS = 24 * 60 * 60
MAX_PER_OWNER = 32


class PodCommandCheckpointStore:
    def __init__(self, *, clock: Any = time.time) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._rows: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}

    def _purge(self, user_id: str) -> None:
        now = self._clock()
        for key in [k for k, (at, _) in self._rows.items() if k[0] == user_id]:
            if now - self._rows[key][0] > TTL_SECONDS:
                self._rows.pop(key, None)

    @staticmethod
    def _public(command_id: str, state: dict[str, Any]) -> dict[str, Any]:
        return {**copy.deepcopy(state), "command_id": command_id}

    async def create(self, user_id: str, command_id: str, state: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._purge(user_id)
            if (user_id, command_id) in self._rows:
                raise CommandCheckpointConflict("This command already has a checkpoint.")
            if sum(1 for owner, _ in self._rows if owner == user_id) >= MAX_PER_OWNER:
                raise CommandCheckpointConflict("Too many unfinished commands. Finish one first.")
            row = {**copy.deepcopy(state), "revision": 1}
            self._rows[(user_id, command_id)] = (self._clock(), row)
            return self._public(command_id, row)

    async def get(self, user_id: str, command_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._purge(user_id)
            found = self._rows.get((user_id, command_id))
            return self._public(command_id, found[1]) if found else None

    async def list_owned(self, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._purge(user_id)
            return [
                self._public(command, row)
                for (owner, command), (_, row) in self._rows.items()
                if owner == user_id
            ]

    async def update(
        self, user_id: str, command_id: str, revision: int, state: dict[str, Any]
    ) -> dict[str, Any]:
        with self._lock:
            self._purge(user_id)
            found = self._rows.get((user_id, command_id))
            if found is None:
                raise CommandCheckpointConflict("Command not found or expired.")
            created_at, current = found
            if current["revision"] != revision:
                raise CommandCheckpointConflict("The command changed. Refresh its checkpoint.")
            row = {
                **copy.deepcopy({k: v for k, v in state.items() if k != "command_id"}),
                "revision": revision + 1,
            }
            self._rows[(user_id, command_id)] = (created_at, row)
            return self._public(command_id, row)

    async def delete(self, user_id: str, command_id: str) -> bool:
        with self._lock:
            return self._rows.pop((user_id, command_id), None) is not None


__all__ = ["MAX_PER_OWNER", "PodCommandCheckpointStore", "TTL_SECONDS"]
