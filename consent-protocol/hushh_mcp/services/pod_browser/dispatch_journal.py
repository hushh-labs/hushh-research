"""Browser dispatch receipts in the existing sealed owner log.

Only keyed commitments and execution identities are retained. UI dispatch and
network dispatch are separate lanes: a navigation's UI intent must not block
the broker requests needed to finish that same navigation.
"""

from __future__ import annotations

import asyncio
from typing import Literal

from pydantic import Field

from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogConflict

from .consent import private_commitment
from .contracts import BrowserBinding, BrowserRefused, StrictContract

KIND = "browser_dispatch_v1"
Lane = Literal["action", "network"]
State = Literal["pending", "settled", "uncertain"]


class DispatchRecord(StrictContract):
    binding: BrowserBinding
    lane: Lane
    commitment: str = Field(pattern=r"^[a-f0-9]{64}$")
    state: State

    @property
    def identity(self) -> tuple[BrowserBinding, Lane, str]:
        return self.binding, self.lane, self.commitment


class BrowserDispatchJournal:
    def __init__(self, log: PodCommitLog, *, key: bytes, owner_id: str, pod_id: str) -> None:
        private_commitment(key, {})
        self._log, self._key, self._owner, self._pod = log, key, owner_id, pod_id
        self._cursor = None
        self._records: dict[tuple[BrowserBinding, Lane, str], DispatchRecord] = {}
        self._lock = asyncio.Lock()

    def commitment(self, binding: BrowserBinding, lane: Lane, terms: dict) -> str:
        self._binding(binding)
        return private_commitment(
            self._key, {"binding": binding.model_dump(mode="json"), "lane": lane, "terms": terms}
        )

    def _binding(self, binding: BrowserBinding) -> None:
        if (binding.owner_id, binding.pod_id) != (self._owner, self._pod):
            raise BrowserRefused("BROWSER_BINDING_REFUSED")

    async def _refresh(self) -> None:
        records = []

        def collect(record: dict) -> None:
            if record["kind"] == KIND:
                records.append(record)
                if len(records) > 30000:
                    raise BrowserRefused("BROWSER_DISPATCH_HISTORY_LIMIT")

        cursor = await self._log.fold_since(self._cursor, collect)
        projection = dict(self._records)
        for row in reversed(records):
            try:
                item = DispatchRecord.model_validate(row["payload"])
                self._binding(item.binding)
                previous = projection.get(item.identity)
                if previous is None:
                    if item.state != "pending":
                        raise ValueError()
                elif previous.state != "pending" or item.state == "pending":
                    raise ValueError()
                projection[item.identity] = item
                if len(projection) > 10000:
                    raise BrowserRefused("BROWSER_DISPATCH_HISTORY_LIMIT")
            except (ValueError, KeyError, TypeError):
                raise BrowserRefused("BROWSER_DISPATCH_LOG_INVALID") from None
        # An incomplete/tampered replay never publishes a partial projection.
        self._records, self._cursor = projection, cursor

    def _require_settled(self, lane: Lane | None) -> None:
        if any(
            item.state != "settled" and (lane is None or item.lane == lane)
            for item in self._records.values()
        ):
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")

    async def require_settled(self, binding: BrowserBinding, *, lane: Lane | None = None) -> None:
        """Old incarnations' abandoned intents also block new work."""
        self._binding(binding)
        async with self._lock:
            await self._refresh()
            self._require_settled(lane)

    async def begin(self, binding: BrowserBinding, lane: Lane, commitment: str) -> None:
        self._binding(binding)
        item = DispatchRecord(binding=binding, lane=lane, commitment=commitment, state="pending")
        async with self._lock:
            for _ in range(3):
                await self._refresh()
                if item.identity in self._records:
                    raise BrowserRefused("BROWSER_ACTION_REPLAY")
                self._require_settled(lane)
                try:
                    await self._log.append(
                        KIND,
                        item.model_dump(mode="json"),
                        expected_seq=self._cursor.seq if self._cursor else 0,
                    )
                    return
                except PodLogConflict:
                    continue  # Recompute against the new verified log head.
        raise BrowserRefused("BROWSER_DISPATCH_BUSY")

    async def settle(
        self, binding: BrowserBinding, lane: Lane, commitment: str, *, uncertain: bool
    ) -> None:
        self._binding(binding)
        item = DispatchRecord(
            binding=binding,
            lane=lane,
            commitment=commitment,
            state="uncertain" if uncertain else "settled",
        )
        async with self._lock:
            for _ in range(3):
                await self._refresh()
                previous = self._records.get(item.identity)
                if previous is None:
                    raise BrowserRefused("BROWSER_DISPATCH_NOT_FOUND")
                if previous.state == item.state:
                    return  # Lost settlement response; never redispatch.
                if previous.state != "pending":
                    raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
                try:
                    await self._log.append(
                        KIND,
                        item.model_dump(mode="json"),
                        expected_seq=self._cursor.seq if self._cursor else 0,
                    )
                    return
                except PodLogConflict:
                    continue
        raise BrowserRefused("BROWSER_DISPATCH_BUSY")
