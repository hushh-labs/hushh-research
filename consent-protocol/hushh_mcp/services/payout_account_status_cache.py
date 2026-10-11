"""Bounded, process-local display metadata; never payout authorization or vault state."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from time import monotonic
from typing import Any

# Owner, mode, provider configuration fingerprint, connected account binding.
StatusKey = tuple[str, str, str, str]


class StatusReadInvalidated(Exception):
    """The caller must resolve the current account binding before trying again."""


@dataclass
class _Entry:
    task: asyncio.Task[dict[str, Any]] | None = None
    expires_at: float = 0
    invalidated: bool = False


class PayoutAccountStatusCache:
    def __init__(self, *, ttl: float = 30, max_entries: int = 256) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._entries: OrderedDict[StatusKey, _Entry] = OrderedDict()

    def invalidate(self, *, user_id: str, mode: str) -> None:
        # Removing the generation also fences an older in-flight result. No
        # ever-growing owner/generation registry is retained after invalidation.
        for key in list(self._entries):
            if key[:2] == (user_id, mode):
                entry = self._entries.pop(key)
                entry.invalidated = True

    async def get(
        self, key: StatusKey, load: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        # Rebinding is observed through the service's fresh mapping read.
        for prior in list(self._entries):
            if prior[:3] == key[:3] and prior[3] != key[3]:
                self._entries.pop(prior).invalidated = True
        entry = self._entries.get(key)
        if (
            entry
            and entry.task
            and (
                entry.task.get_loop() is not loop
                or (entry.task.done() and entry.expires_at <= monotonic())
            )
        ):
            self._entries.pop(key)
            entry.invalidated = True
            entry = None
        if entry is None:
            entry = _Entry()
            self._entries[key] = entry
            while len(self._entries) > self.max_entries:
                _, evicted = self._entries.popitem(last=False)
                evicted.invalidated = True

            async def populate() -> dict[str, Any]:
                try:
                    value = await load()
                    entry.expires_at = monotonic() + self.ttl
                    return value
                except BaseException:
                    if self._entries.get(key) is entry:
                        self._entries.pop(key)
                    raise

            entry.task = asyncio.create_task(populate())
            # A disconnected HTTP caller must not cancel other readers. Consume
            # background failures even when every waiting caller disconnects.
            entry.task.add_done_callback(
                lambda task: None if task.cancelled() else task.exception()
            )
        else:
            self._entries.move_to_end(key)
        if entry.task is None:
            raise RuntimeError("Payout status load was not started")
        value = await asyncio.shield(entry.task)
        if entry.invalidated:
            raise StatusReadInvalidated
        return deepcopy(value)


account_status_cache = PayoutAccountStatusCache()


def invalidate_payout_account_status(*, user_id: str, mode: str) -> None:
    """Call only after verified mutations, or an authenticated explicit refresh."""
    account_status_cache.invalidate(user_id=user_id, mode=mode)
