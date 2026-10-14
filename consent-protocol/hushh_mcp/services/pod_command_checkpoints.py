"""Voice and typed command checkpoints held by the owner's own agent.

The hub's ``CommandCheckpointStore`` keeps a command's plan digest and progress in
the hub database. For an owner whose agent runs in their own cloud the plan, its
query and the screen it came from must not reach the hub, so the agent validates
the plan and holds its checkpoint here instead. The app then performs each step
through the same typed effect a button tap sends.

Production composition injects bounded encrypted object recovery. The default
memory adapter remains for isolated fixtures. A restart never authorizes replay
of an effect whose dispatch or settlement is uncertain.

Contract (the subset of ``CommandCheckpointStore`` the pod routes use):

* **Owner-bound.** Keyed by (owner, command id); another owner reads nothing.
* **Compare-and-set.** ``update`` names the revision it read; a stale revision is a
  ``CommandCheckpointConflict``, never a silent overwrite.
* **Bounded.** At most ``MAX_PER_OWNER`` live checkpoints; expired ones are purged
  before a create is refused.
"""

from __future__ import annotations

import copy
import math
import threading
import time
from collections.abc import Callable
from typing import Any

from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict
from hushh_mcp.services.pod_action_checkpoints import PodActionCheckpointStorage
from hushh_mcp.services.pod_commit_log import PodLogTampered

TTL_SECONDS = 24 * 60 * 60
MAX_PER_OWNER = 32


class PodCommandCheckpointStore:
    def __init__(
        self, *, clock: Any = time.time, storage: PodActionCheckpointStorage | None = None
    ) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._storage = storage
        self._rows: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}

    async def _operate(self, user_id: str, operation: Callable, *, write: bool = False):
        def apply(values):
            rows = {}
            for command, row in values.items():
                if (
                    not isinstance(command, str)
                    or not isinstance(row, (list, tuple))
                    or len(row) != 2
                    or type(row[0]) not in (int, float)
                    or not math.isfinite(row[0])
                    or not isinstance(row[1], dict)
                    or type(row[1].get("revision")) is not int
                    or row[1]["revision"] < 1
                ):
                    raise PodLogTampered("Pod command recovery is invalid.")
                if self._clock() - row[0] <= TTL_SECONDS:
                    rows[command] = copy.deepcopy(row)
            result = operation(rows)
            values.clear()
            values.update(rows)
            return result

        if self._storage is not None:
            if user_id != self._storage.owner:
                raise CommandCheckpointConflict("Command owner changed.")
            if write:
                return await self._storage.change(apply)
            values, _ = await self._storage.read()
            return apply(values)
        with self._lock:
            values = {
                command: copy.deepcopy(row)
                for (owner, command), row in self._rows.items()
                if owner == user_id
            }
            result = apply(values)
            for key in [key for key in self._rows if key[0] == user_id]:
                self._rows.pop(key)
            self._rows.update({(user_id, command): row for command, row in values.items()})
            return result

    @staticmethod
    def _public(command_id: str, state: dict[str, Any]) -> dict[str, Any]:
        return {**copy.deepcopy(state), "command_id": command_id}

    async def create(self, user_id: str, command_id: str, state: dict[str, Any]) -> dict[str, Any]:
        def create(rows):
            if command_id in rows:
                raise CommandCheckpointConflict("This command already has a checkpoint.")
            if len(rows) >= MAX_PER_OWNER:
                raise CommandCheckpointConflict("Too many unfinished commands. Finish one first.")
            row = {**copy.deepcopy(state), "revision": 1}
            rows[command_id] = (self._clock(), row)
            return self._public(command_id, row)

        return await self._operate(user_id, create, write=True)

    async def get(self, user_id: str, command_id: str) -> dict[str, Any] | None:
        def get(rows):
            found = rows.get(command_id)
            return self._public(command_id, found[1]) if found else None

        return await self._operate(user_id, get)

    async def list_owned(self, user_id: str) -> list[dict[str, Any]]:
        return await self._operate(
            user_id, lambda rows: [self._public(command, row) for command, (_, row) in rows.items()]
        )

    async def update(
        self, user_id: str, command_id: str, revision: int, state: dict[str, Any]
    ) -> dict[str, Any]:
        def update(rows):
            found = rows.get(command_id)
            if found is None:
                raise CommandCheckpointConflict("Command not found or expired.")
            created_at, current = found
            if current["revision"] != revision:
                raise CommandCheckpointConflict("The command changed. Refresh its checkpoint.")
            row = {
                **copy.deepcopy({k: v for k, v in state.items() if k != "command_id"}),
                "revision": revision + 1,
            }
            rows[command_id] = (created_at, row)
            return self._public(command_id, row)

        return await self._operate(user_id, update, write=True)

    async def delete(self, user_id: str, command_id: str, *, revision: int | None = None) -> bool:
        def delete(rows):
            found = rows.get(command_id)
            if found is None:
                return False
            state = found[1]
            if state.get("status") == "dispatching" or (
                revision is not None and state["revision"] != revision
            ):
                raise CommandCheckpointConflict("Command dispatch or cancellation is unconfirmed.")
            rows.pop(command_id)
            return True

        return await self._operate(user_id, delete, write=True)


__all__ = ["MAX_PER_OWNER", "PodCommandCheckpointStore", "TTL_SECONDS"]
