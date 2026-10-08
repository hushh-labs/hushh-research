"""The hub's standby sync: read both heads, ferry a sealed range, prove equal heads.

Design: ``docs/future/personal-agent/STANDBY-SYNC.md`` ("Sync protocol", E4 to E8).
One attempt, :meth:`StandbySyncService.sync_once`, in order:

1. take the single-flight sync lease on the person's standby row (fenced on the
   observed placement epoch and standby key);
2. read the primary from the registry row and BOTH pods' own heads
   (``POST /pod/sync/head``); each pod must report the keys, role and an epoch no
   lower than the registry's;
3. equal heads: record ``synced`` with no transfer (E7);
4. otherwise ask the primary for the records after the standby's head, sealed to the
   standby and signed by the primary (E5); ferry the ciphertext unread; import it;
5. re-read the standby's head and record ``synced`` only when it equals the head the
   primary exported; anything else records a typed failure. The pod's import refuses
   a fork or gap before any append (E8), so a failure leaves the standby as it was.

The sweep (:meth:`StandbySyncService.sweep_due`) runs a small batch per reconcile
pass, every :data:`SYNC_INTERVAL` per person, least recently attempted first so a
failing standby can never starve the others.

WHAT THIS MODULE MAY NOT DO
---------------------------
Decrypt. It holds no key for either pod, imports no bundle code, and compares
hashes the pods published (asserted structurally in
``tests/test_pod_migration_transport.py``). It names no provider: both addresses are
recorded https URLs reached through the same two-token transport on every cloud.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from hushh_mcp.services.pod_standby_sync_checks import (
    STATUS_SKIPPED,
    STATUS_SYNCED,
    Head,
    StandbySyncOutcome,
    SyncStop,
    check_pod_head,
    check_range_coordinates,
    heads_prove_fork,
    outcome,
    parse_head,
    transport_reason,
)

logger = logging.getLogger(__name__)

#: How often each person's standby is brought level (founder: "every few hours").
SYNC_INTERVAL = timedelta(hours=4)
#: Standbys synced per reconcile pass. Each sync can take minutes (cold starts, a long
#: first range), and the pass also runs the fleet's other sweeps.
SWEEP_BATCH = 4
#: A failed standby is retried no sooner than this; success waits a full interval.
SWEEP_RETRY_COOLDOWN_SECONDS = 1800
#: The owner's "sync now" may not be repeated faster than this.
ON_DEMAND_COOLDOWN_SECONDS = 60

#: Export 409: the standby's head is not in the primary's chain (a fork). The pod also
#: answers 409 when it cannot read its own log; refused bodies are never read, so that
#: rare case is recorded as diverged too, and the next pass re-decides from fresh heads.
_EXPORT_REFUSALS = {"POD_REFUSED_409": "refused_fork"}
#: Import 400: the standby refused the range (origin, decryption or continuity);
#: import 409: the standby's log moved under the import (safe to retry).
_IMPORT_REFUSALS = {"POD_REFUSED_400": "refused_bundle", "POD_REFUSED_409": "import_conflict"}

_STANDBY_TABLE_PROBE = (
    "SELECT to_regclass('public.personal_agent_standby_placements') IS NOT NULL AS ready"
)


@dataclass(frozen=True)
class SweepReport:
    attempted: int
    synced: int
    failed: int
    skipped: int


@dataclass(frozen=True)
class _Pair:
    """The two placements of one claimed sync, as the hub recorded them."""

    hushh_id: str
    epoch: int
    primary_url: str
    standby_url: str
    primary: Mapping[str, Any]
    standby: Mapping[str, Any]


async def _default_table_ready() -> bool:
    """True where the parked standby table exists (dev-only migration 950)."""
    from db.db_client import get_db  # noqa: PLC0415

    response = await asyncio.to_thread(get_db().execute_raw, _STANDBY_TABLE_PROBE, {})
    rows = getattr(response, "data", None) or []
    return bool(rows and dict(rows[0]).get("ready"))


class StandbySyncService:
    """Sync one person's standby, or a bounded batch of due standbys."""

    def __init__(
        self,
        *,
        store: Any = None,
        registry: Any = None,
        transport: Any = None,
        token_minter: Any = None,
        table_ready: Optional[Callable[[], Awaitable[bool]]] = None,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        if store is None:
            from hushh_mcp.services.personal_agent_standby_store import (  # noqa: PLC0415
                PersonalAgentStandbyStore,
            )

            store = PersonalAgentStandbyStore()
        if registry is None:
            from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
                PersonalAgentRegistryRepo,
            )

            registry = PersonalAgentRegistryRepo()
        if transport is None:
            from hushh_mcp.services import pod_sync_transport as transport  # noqa: PLC0415
        self._store = store
        self._registry = registry
        self._transport = transport
        self._token_minter = token_minter
        self._table_ready = table_ready or _default_table_ready
        self._clock = clock

    # -- entry points ----------------------------------------------------------------

    async def sync_once(
        self, user_id: str, *, cooldown_seconds: int = ON_DEMAND_COOLDOWN_SECONDS
    ) -> StandbySyncOutcome:
        """One sync attempt for ``user_id``'s standby. Never raises; always typed."""
        try:
            if not await self._table_ready():
                return outcome("no_standby")
            standby = await self._store.read_standby(user_id)
        except Exception as exc:  # noqa: BLE001 - an unreadable store is a typed skip
            logger.warning("pod_standby_sync.store_unavailable error=%s", type(exc).__name__)
            return outcome("store_unavailable")
        if not standby:
            return outcome("no_standby")
        return await self._sync_claimed(user_id, standby, cooldown_seconds)

    async def sweep_due(self) -> SweepReport:
        """Sync at most :data:`SWEEP_BATCH` standbys not synced for :data:`SYNC_INTERVAL`."""
        try:
            if not await self._table_ready():
                return SweepReport(0, 0, 0, 0)
            due = await self._store.list_standbys_due(self._clock() - SYNC_INTERVAL, SWEEP_BATCH)
        except Exception as exc:  # noqa: BLE001 - one bad read skips one pass, loudly
            logger.warning("pod_standby_sync.sweep_unavailable error=%s", type(exc).__name__)
            return SweepReport(0, 0, 0, 0)
        results = [
            await self._sync_claimed(str(row["user_id"]), row, SWEEP_RETRY_COOLDOWN_SECONDS)
            for row in due[:SWEEP_BATCH]
            if row.get("user_id")
        ]
        report = SweepReport(
            attempted=len(results),
            synced=sum(1 for r in results if r.status == STATUS_SYNCED),
            skipped=sum(1 for r in results if r.status == STATUS_SKIPPED),
            failed=sum(1 for r in results if r.status not in (STATUS_SYNCED, STATUS_SKIPPED)),
        )
        if report.attempted:
            logger.info(
                "pod_standby_sync.sweep attempted=%d synced=%d failed=%d skipped=%d",
                report.attempted,
                report.synced,
                report.failed,
                report.skipped,
            )
        return report

    # -- one claimed attempt ---------------------------------------------------------

    async def _sync_claimed(
        self, user_id: str, observed: Mapping[str, Any], cooldown_seconds: int
    ) -> StandbySyncOutcome:
        lease_id = secrets.token_hex(16)
        try:
            claimed = await self._store.claim_sync_lease(
                user_id, observed, lease_id, cooldown_seconds
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("pod_standby_sync.claim_unavailable error=%s", type(exc).__name__)
            return outcome("store_unavailable")
        if not claimed:
            return outcome("busy")
        try:
            result = await self._transfer(user_id, claimed)
        except Exception as exc:  # noqa: BLE001 - the lease must still be released
            logger.warning("pod_standby_sync.internal_error error=%s", type(exc).__name__)
            result = outcome("internal_error")
        recorded = await self._record(user_id, claimed, lease_id, result)
        logger.info(
            "pod_standby_sync.done status=%s reason=%s seq=%s transferred=%d recorded=%s",
            recorded.status,
            recorded.reason,
            recorded.synced_seq,
            recorded.records_transferred,
            recorded.recorded,
        )
        return recorded

    async def _record(
        self, user_id: str, claimed: Mapping[str, Any], lease_id: str, result: StandbySyncOutcome
    ) -> StandbySyncOutcome:
        """Publish under the lease. A refused ``synced`` is re-recorded as a failure."""
        if result.status == STATUS_SYNCED:
            row = await self._safe_record(
                user_id, claimed, lease_id, result.synced_seq, result.synced_head_sha, "synced"
            )
            if row:
                return StandbySyncOutcome(**{**result.to_dict(), "recorded": True})
            result = outcome("record_refused")
        row = await self._safe_record(user_id, claimed, lease_id, None, None, result.status)
        return StandbySyncOutcome(**{**result.to_dict(), "recorded": bool(row)})

    async def _safe_record(self, user_id: str, claimed: Mapping[str, Any], *args: Any) -> Any:
        try:
            return await self._store.record_sync_result(user_id, claimed, *args)
        except Exception as exc:  # noqa: BLE001 - an unrecorded result expires with its lease
            logger.warning("pod_standby_sync.record_unavailable error=%s", type(exc).__name__)
            return None

    async def _transfer(self, user_id: str, claimed: Mapping[str, Any]) -> StandbySyncOutcome:
        try:
            pair = await self._pair(user_id, claimed)
            primary_head = await self._head(pair, "primary")
            standby_head = await self._head(pair, "standby")
            if primary_head == standby_head:
                return outcome(
                    "equal_heads",
                    synced_seq=standby_head.seq,
                    synced_head_sha=standby_head.store_sha,
                )
            if heads_prove_fork(primary_head, standby_head):
                return outcome("refused_fork")
            return await self._ferry(pair, standby_head)
        except SyncStop as stop:
            return outcome(stop.reason)

    # -- steps -----------------------------------------------------------------------

    async def _pair(self, user_id: str, standby: Mapping[str, Any]) -> _Pair:
        """The registry's primary for this claim, or a stop when it is not serving it."""
        primary = await self._registry.get(user_id)
        epoch = standby.get("placement_epoch")
        if (
            not primary
            or primary.get("status") != "provisioned"
            or int(primary.get("placement_epoch") or 0) != epoch
            or not primary.get("hushh_id")
            or primary.get("hushh_id") != standby.get("hushh_id")
        ):
            raise SyncStop("primary_not_ready")
        primary_url = str((primary.get("backend_metadata") or {}).get("url") or "").rstrip("/")
        standby_url = str(standby.get("url") or "").rstrip("/")
        if not primary_url.startswith("https://") or not standby_url.startswith("https://"):
            raise SyncStop("primary_not_ready")
        return _Pair(
            hushh_id=str(primary["hushh_id"]),
            epoch=int(epoch),
            primary_url=primary_url,
            standby_url=standby_url,
            primary=primary,
            standby=standby,
        )

    async def _call(
        self, side: str, fn: Any, refusals: Optional[Mapping[str, str]] = None, **kwargs: Any
    ) -> dict[str, Any]:
        """One transport call on a thread; a transport failure becomes a typed stop.

        ``refusals`` maps the refusal codes a step gives a specific meaning to.
        """
        error_type = self._transport.PodMigrationTransportError
        try:
            return await asyncio.to_thread(fn, token_minter=self._token_minter, **kwargs)
        except error_type as exc:
            specific = (refusals or {}).get(exc.code)
            raise SyncStop(specific or transport_reason(exc.code, side)) from None

    async def _head(self, pair: _Pair, side: str) -> Head:
        url = pair.primary_url if side == "primary" else pair.standby_url
        body = await self._call(
            side, self._transport.read_head, pod_url=url, hushh_id=pair.hushh_id
        )
        expected = pair.primary if side == "primary" else pair.standby
        return check_pod_head(body, side=side, expected=expected, placement_epoch=pair.epoch)

    async def _ferry(self, pair: _Pair, base: Head) -> StandbySyncOutcome:
        exported = await self._call(
            "primary",
            self._transport.export_range,
            _EXPORT_REFUSALS,
            pod_url=pair.primary_url,
            hushh_id=pair.hushh_id,
            base_seq=base.seq,
            base_head_sha=base.sha,
            standby_public_key=str(pair.standby.get("pod_pubkey") or ""),
            standby_key_id=str(pair.standby.get("pod_key_id") or ""),
        )
        target = parse_head(exported.get("head_seq"), exported.get("head_sha"), "primary")
        bundle = exported.get("bundle")
        if bundle is None:
            if target != base:
                raise SyncStop("head_mismatch")
            return outcome("equal_heads", synced_seq=base.seq, synced_head_sha=base.store_sha)
        if not isinstance(bundle, dict):
            raise SyncStop("invalid_response_primary")
        check_range_coordinates(bundle, base, target)
        imported = await self._call(
            "standby",
            self._transport.import_range,
            _IMPORT_REFUSALS,
            pod_url=pair.standby_url,
            hushh_id=pair.hushh_id,
            bundle=bundle,
            base_seq=base.seq,
            base_head_sha=base.sha,
        )
        reported = parse_head(imported.get("head_seq"), imported.get("head_sha"), "standby")
        after = await self._head(pair, "standby")
        if reported != target or after != target:
            raise SyncStop("head_mismatch")
        return outcome(
            "imported",
            synced_seq=target.seq,
            synced_head_sha=target.store_sha,
            records_transferred=target.seq - base.seq,
        )


async def sync_standby_on_demand(user_id: str) -> StandbySyncOutcome:
    """The owner's "sync now": one attempt for their own standby."""
    return await StandbySyncService().sync_once(user_id)


async def sweep_due_standbys() -> SweepReport:
    """The reconcile worker's standby sweep (one bounded batch)."""
    return await StandbySyncService().sweep_due()


__all__ = [
    "ON_DEMAND_COOLDOWN_SECONDS",
    "SWEEP_BATCH",
    "SWEEP_RETRY_COOLDOWN_SECONDS",
    "SYNC_INTERVAL",
    "StandbySyncOutcome",
    "StandbySyncService",
    "SweepReport",
    "sweep_due_standbys",
    "sync_standby_on_demand",
]
