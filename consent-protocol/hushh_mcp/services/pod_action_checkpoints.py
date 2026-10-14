"""Bounded mutable action recovery under the request's owner-held chat key.

This stores recovery state, never approval. Existing effect owners and the MCP
action ledger remain authoritative. Fixed slots and retained erasure markers
prevent a delayed write from resurrecting forgotten state.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from hushh_mcp.services.chat_key import ChatCipher, chat_aad
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict
from hushh_mcp.services.pod_commit_log import ObjectStore, PodLogTampered

COMMANDS_OBJECT = "checkpoints/commands-v1.bin"
MCP_OBJECT = "checkpoints/mcp-pending-v1.bin"
CLOSED_CHECKPOINT = b'{"closed":true,"kind":"pod-action-checkpoint-v1"}'
MAX_BYTES = 2 * 1024 * 1024
_T = TypeVar("_T")


class PodActionCheckpointStorage:
    """CAS one owner-bound slot; keys are resolved only during the request."""

    def __init__(
        self,
        *,
        owner: str,
        hushh_id: str,
        store: ObjectStore,
        require_access: Callable[[], Awaitable[None]],
        cipher: ChatCipher | None = None,
        slot: str = COMMANDS_OBJECT,
    ) -> None:
        if slot not in {COMMANDS_OBJECT, MCP_OBJECT}:
            raise ValueError("Unknown pod action checkpoint slot.")
        self.owner = owner
        self._slot = slot
        self._store = store
        self._access = require_access
        self._cipher = cipher or ChatCipher()
        self._aad = chat_aad("pod_action_checkpoints", "payload", f"{owner}/{hushh_id}/{slot}")

    async def read(self) -> tuple[dict[str, Any], str]:
        await self._access()
        # An empty slot does not authorize a locked request.
        self._cipher._key(self.owner)
        blob, version = await self._store.get_bounded_with_generation(
            self._slot, max_bytes=MAX_BYTES
        )
        if blob is None:
            await self._access()
            return {}, version
        if blob == CLOSED_CHECKPOINT:
            raise PodLogTampered("Pod action recovery is closed.")
        try:
            envelope = json.loads(blob)
            if not isinstance(envelope, dict) or set(envelope) != {
                "payload_ciphertext",
                "payload_iv",
                "payload_tag",
            }:
                raise ValueError()
            plain = self._cipher.open(envelope, "payload", owner_id=self.owner, aad=self._aad)
            value = json.loads(plain)
        except (TypeError, ValueError, KeyError):
            raise PodLogTampered("Pod action recovery is invalid.") from None
        if not isinstance(value, dict) or len(value) > 32:
            raise PodLogTampered("Pod action recovery exceeds its bound.")
        await self._access()
        return value, version

    async def change(self, mutate: Callable[[dict[str, Any]], _T]) -> _T:
        for _ in range(4):
            value, version = await self.read()
            result = mutate(value)
            if len(value) > 32:
                raise CommandCheckpointConflict("Too many unfinished commands. Finish one first.")
            plaintext = json.dumps(value, separators=(",", ":"), allow_nan=False)
            if len(plaintext.encode()) > MAX_BYTES // 2:
                raise CommandCheckpointConflict("Command recovery exceeds its bound.")
            sealed = self._cipher.seal(plaintext, owner_id=self.owner, aad=self._aad)
            blob = json.dumps(
                {
                    "payload_ciphertext": sealed.ciphertext,
                    "payload_iv": sealed.iv,
                    "payload_tag": sealed.tag,
                },
                separators=(",", ":"),
            ).encode()
            if len(blob) > MAX_BYTES:
                raise CommandCheckpointConflict("Command recovery exceeds its bound.")
            await self._access()
            written = await self._store.put_if_generation(self._slot, blob, version)
            await self._access()
            if written is not None:
                return result
            # Only a definite CAS conflict retries. Uncertain writes propagate.
        raise CommandCheckpointConflict("The command changed. Refresh its checkpoint.")
