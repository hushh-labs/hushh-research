"""Encrypted remembered sign-in objects, metadata-only recovery and Forget fencing.

Object upload is preceded by a sealed write intent. Publication uses the observed
log sequence, so a late save cannot supersede Forget. Every restore rereads that
projection; a stored sign-in is never evidence that the website accepts it.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

from cryptography.exceptions import InvalidTag

from hushh_mcp.services.pod_bounded_object import BoundedObjectReader
from hushh_mcp.services.pod_commit_log import (
    ObjectStore,
    PodCommitLog,
    PodLogConflict,
    PodLogCursor,
)

from .consent import BrowserConsentPort
from .contracts import BrowserBinding, BrowserReadiness, BrowserRefused
from .session_cipher import BrowserSessionCipher
from .session_projection import _SITE, KIND, SessionProjection, refresh_projection
from .session_projection import ForgetReceipt as ForgetReceipt
from .session_projection import SiteRevision as SiteRevision
from .session_state import MAX_SESSION_BYTES, RememberedState


class BrowserSessionStore(ObjectStore, BoundedObjectReader, Protocol):
    pass


class BrowserSessions:
    def __init__(
        self,
        *,
        owner_id: str,
        store: BrowserSessionStore,
        log: PodCommitLog,
        custody_key: bytes,
        consent: BrowserConsentPort,
        readiness: BrowserReadiness,
        fence_live_contexts: Callable[[str], Awaitable[None]],
        clock: Callable[[], float] = time.time,
    ) -> None:
        readiness.require_ready()
        if len(custody_key) != 32 or not owner_id:
            raise BrowserRefused("BROWSER_SESSION_KEY_UNAVAILABLE")
        self._owner = owner_id
        self._store, self._log, self._consent = store, log, consent
        self._cipher = BrowserSessionCipher(owner_id, custody_key)
        self._fence, self._clock = fence_live_contexts, clock
        self._projection = SessionProjection()
        self._cursor: PodLogCursor | None = None
        self._lock = asyncio.Lock()
        self._blocked: set[str] = set()
        self._forget_epochs: dict[str, int] = {}
        self._forgetting: set[str] = set()
        self._restored: dict[
            tuple[BrowserBinding, str], tuple[SiteRevision, frozenset[str]] | None
        ] = {}

    def site_id(self, origin: str, account_id: str) -> str:
        return self._cipher.site_id(origin, account_id)

    async def _check(self, binding: BrowserBinding, site: str, *, forgetting: bool = False) -> None:
        if binding.owner_id != self._owner or not _SITE.fullmatch(site):
            raise BrowserRefused("BROWSER_SESSION_OWNER_REFUSED")
        await self._consent.check_binding(binding)
        if site in self._blocked and not forgetting:
            raise BrowserRefused("BROWSER_SESSION_FORGOTTEN")

    async def _refresh(self) -> int:
        self._projection, self._cursor = await refresh_projection(
            self._log, self._cursor, self._projection
        )
        return self._cursor.seq if self._cursor else 0

    async def remember(
        self,
        binding: BrowserBinding,
        site: str,
        state: RememberedState,
        *,
        approved_origins: frozenset[str],
    ) -> SiteRevision:
        state = state.for_origins(approved_origins, now=self._clock())
        raw = state.model_dump_json().encode()
        if len(raw) > MAX_SESSION_BYTES:
            raise BrowserRefused("BROWSER_SESSION_TOO_LARGE")
        async with self._lock:
            if site in self._forgetting:
                raise BrowserRefused("BROWSER_SESSION_FORGET_PENDING")
            started_epoch = self._forget_epochs.get(site, 0)
            await self._check(binding, site, forgetting=True)
            seq = await self._refresh()
            prior = self._projection.sites.get(site, SiteRevision())
            if sum(len(keys) for keys in self._projection.objects.values()) >= 10000:
                raise BrowserRefused("BROWSER_SESSION_INVENTORY_LIMIT")
            terms = {
                "site": site,
                "generation": prior.generation,
                "origins": sorted(approved_origins),
                "state": state.model_dump(mode="json"),
            }
            await self._consent.require(binding, "session_remember", terms)
            key = f"browser/sessions/{secrets.token_hex(16)}.bin"
            sealed = self._cipher.seal(raw, site, prior.generation, key)
            intent = await self._log.append(
                KIND,
                {
                    "operation": "intent",
                    "site": site,
                    "generation": prior.generation,
                    "object": key,
                },
                expected_seq=seq,
            )
            try:
                await self._store.put(key, sealed)
                await self._check(binding, site, forgetting=True)
                await self._consent.require(binding, "session_remember", terms)
                if self._forget_epochs.get(site, 0) != started_epoch:
                    raise BrowserRefused("BROWSER_SESSION_FORGOTTEN")
                await self._log.append(
                    KIND,
                    {
                        "operation": "publish",
                        "site": site,
                        "generation": prior.generation,
                        "object": key,
                        "digest": hashlib.sha256(sealed).hexdigest(),
                        "size": len(sealed),
                    },
                    expected_seq=intent["seq"],
                )
            except BaseException:
                # CAS can commit then report cancellation or lose its response.
                # Retain the inventoried ciphertext instead of deleting an object
                # that may already be the published snapshot. Cleanup requires
                # verified publication state and quiescent writers.
                raise
            await self._refresh()
            if self._forget_epochs.get(site, 0) != started_epoch:
                raise BrowserRefused("BROWSER_SESSION_FORGOTTEN")
            self._blocked.discard(site)
            return self._projection.sites[site]

    async def restore_for_task(
        self,
        binding: BrowserBinding,
        site: str,
        *,
        approved_origins: frozenset[str],
        install: Callable[[RememberedState], Awaitable[None]],
    ) -> bool:
        async with self._lock:
            await self._check(binding, site)
            await self._refresh()
            current = self._projection.sites.get(site, SiteRevision())
            if current.object_key is None:
                return False
            terms = {
                "site": site,
                "generation": current.generation,
                "object": current.object_key,
                "digest": current.digest,
                "origins": sorted(approved_origins),
            }
            task_use = (binding, site)
            if task_use in self._restored:
                if self._restored[task_use] == (current, approved_origins):
                    try:
                        await self._consent.require(binding, "session_restore", terms)
                        await self._check(binding, site)
                    except BaseException:
                        await self._fence(site)
                        raise
                    return True  # idempotent receipt, never import a second time
                raise BrowserRefused("BROWSER_SESSION_RESTORE_ALREADY_USED")
            await self._consent.require(binding, "session_restore", terms)
            try:
                raw = await self._store.get_bounded(
                    current.object_key, max_bytes=MAX_SESSION_BYTES + 28
                )
            except (ValueError, RuntimeError):
                raise BrowserRefused("BROWSER_SESSION_OBJECT_UNAVAILABLE") from None
            if (
                raw is None
                or len(raw) != current.size
                or hashlib.sha256(raw).hexdigest() != current.digest
            ):
                raise BrowserRefused("BROWSER_SESSION_OBJECT_INVALID")
            try:
                opened = self._cipher.open(raw, site, current.generation, current.object_key)
                state = RememberedState.model_validate_json(opened).for_origins(
                    approved_origins, now=self._clock()
                )
            except (ValueError, InvalidTag):
                raise BrowserRefused("BROWSER_SESSION_OBJECT_INVALID") from None
            await self._refresh()
            await self._check(binding, site)
            if self._projection.sites.get(site) != current:
                raise BrowserRefused("BROWSER_SESSION_CHANGED")
            await self._consent.require(binding, "session_restore", terms)
            # Install is part of the guarded critical section, not returned for
            # a caller to import later after Forget. Cross-process CAS is checked
            # again after import; any observed change destroys the live context.
            try:
                await self._check(binding, site)
                self._restored[task_use] = None  # reserve before uncertain import
                await install(state)
                await self._refresh()
                await self._check(binding, site)
                await self._consent.require(binding, "session_restore", terms)
                await self._check(binding, site)
                if self._projection.sites.get(site) != current:
                    raise BrowserRefused("BROWSER_SESSION_CHANGED")
            except BaseException:
                await self._fence(site)
                raise
            self._restored[task_use] = (current, approved_origins)
            return True  # stored sign-in imported, NOT authenticated by the website

    async def forget(self, binding: BrowserBinding, site: str) -> ForgetReceipt:
        await self._check(binding, site, forgetting=True)
        self._blocked.add(site)  # before waiting for a save/restore or worker close
        self._forgetting.add(site)
        self._forget_epochs[site] = self._forget_epochs.get(site, 0) + 1
        forget_epoch = self._forget_epochs[site]
        closed = True
        try:
            await self._fence(site)
        except Exception:
            closed = False
        async with self._lock:
            try:
                seq = await self._refresh()
                current = self._projection.sites.get(site, SiteRevision())
                if current.object_key is not None or current.generation == 0:
                    await self._log.append(
                        KIND,
                        {
                            "operation": "forget",
                            "site": site,
                            "generation": current.generation + 1,
                        },
                        expected_seq=seq,
                    )
                await self._refresh()
            except (PodLogConflict, RuntimeError):
                return ForgetReceipt(closed, False, False)
            deleted = closed
            for key in self._projection.objects.get(site, set()):
                try:
                    await self._store.delete(key)
                except Exception:
                    deleted = False
            if closed and self._forget_epochs[site] == forget_epoch:
                self._forgetting.discard(site)
            return ForgetReceipt(closed, True, deleted)

    async def recovery_inventory(self) -> tuple[str, ...]:
        """Current published ciphertext objects; same-custody restart inventory.

        A recovery with only the log cannot restore these objects and must report
        remembered sign-in unavailable. Current admission still governs reuse.
        """
        async with self._lock:
            await self._refresh()
            return tuple(
                sorted(
                    site.object_key for site in self._projection.sites.values() if site.object_key
                )
            )
