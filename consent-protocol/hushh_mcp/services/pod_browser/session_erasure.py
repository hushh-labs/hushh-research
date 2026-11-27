"""Owner-requested session erasure, independent of Browser execution readiness.

Only opaque metadata is folded. Cookie objects are deleted without opening them.
The lock is shared with all live session writers in this owner incarnation.
"""

from __future__ import annotations

import asyncio
import hmac
import re
from collections.abc import Awaitable, Callable

from hushh_mcp.services.pod_commit_log import ObjectStore, PodCommitLog, PodLogConflict

from .contracts import BrowserRefused
from .origin import public_origin
from .session_cipher import BrowserSessionCipher
from .session_projection import (
    _SITE,
    KIND,
    ForgetReceipt,
    SessionProjection,
    SiteRevision,
    refresh_projection,
)
from .task_contracts import BrowserOwnerAccess


def browser_custody_key(dek: bytes) -> bytes:
    if not isinstance(dek, bytes) or len(dek) != 32:
        raise BrowserRefused("BROWSER_RECOVERY_UNAVAILABLE")
    return hmac.digest(dek, b"hussh/pod-browser-custody/v1", "sha256")


def exact_session_selection(sec_id: str, origins: list[str] | tuple[str, ...]) -> None:
    if (
        not isinstance(sec_id, str)
        or not re.fullmatch(r"sec_[a-f0-9]{16}", sec_id)
        or not isinstance(origins, (list, tuple))
        or not 1 <= len(origins) <= 16
        or any(not isinstance(origin, str) or len(origin) > 2048 for origin in origins)
        or len(set(origins)) != len(origins)
        or any(public_origin(origin) != origin for origin in origins)
    ):
        raise BrowserRefused("BROWSER_SESSION_SELECTION_INVALID")


async def erase_session_site(
    *,
    log: PodCommitLog,
    store: ObjectStore,
    site: str,
    lock: asyncio.Lock,
    check: Callable[[], Awaitable[None]],
    fence: Callable[[str], Awaitable[None]],
) -> ForgetReceipt:
    """The same generation/CAS transaction for live-task and owner-only Forget."""
    if not isinstance(site, str) or not _SITE.fullmatch(site):
        raise BrowserRefused("BROWSER_SESSION_SITE_INVALID")
    await check()
    closed = True
    try:
        await fence(site)
    except Exception:
        closed = False
    await check()
    async with lock:
        # A delayed put holds this same lock. Inventory deletion cannot run
        # ahead of it, even when its task has already detached terminal state.
        await check()
        try:
            projection, cursor = await refresh_projection(log, None, SessionProjection())
            await check()
            current = projection.sites.get(site, SiteRevision())
            if current.object_key is not None or current.generation == 0:
                await log.append(
                    KIND,
                    {"operation": "forget", "site": site, "generation": current.generation + 1},
                    expected_seq=cursor.seq if cursor is not None else 0,
                )
            await check()
            projection, _ = await refresh_projection(log, None, SessionProjection())
        except BrowserRefused:
            raise
        except (PodLogConflict, RuntimeError):
            return ForgetReceipt(closed, False, False)
        await check()
        deleted = closed
        for object_key in projection.objects.get(site, set()):
            await check()
            try:
                await store.delete(object_key)
            except Exception:
                deleted = False
            await check()
        return ForgetReceipt(closed, True, deleted)


class OwnerSessionCleanup:
    """Recovered custody and writer coordination; never holds an owner bearer."""

    def __init__(
        self,
        *,
        authority,
        log: PodCommitLog,
        store: ObjectStore,
        dek: bytes,
        incarnation: str,
        admission,
    ):
        if log is None or not isinstance(dek, bytes) or len(dek) != 32 or authority is None:
            raise BrowserRefused("BROWSER_RECOVERY_UNAVAILABLE")
        self._authority, self._log, self._store = authority, log, store
        self._pod, self._incarnation = authority.hushh_id, incarnation
        self._admission = admission
        self._key = browser_custody_key(dek)
        self.lock = asyncio.Lock()

    async def _check(self, access: BrowserOwnerAccess) -> None:
        from hushh_mcp.services.pod_session_authority import (
            PodSessionRefused,
            active_session_authority,
        )

        if (
            not self._key
            or access.pod_id != self._pod
            or access.incarnation != self._incarnation
            or active_session_authority() is not self._authority
        ):
            raise BrowserRefused("BROWSER_OWNER_REFUSED")
        await access.check()
        try:
            await self._authority.require_held()
        except PodSessionRefused:
            raise BrowserRefused("BROWSER_OWNER_REFUSED") from None
        await self._log.require_open()
        await access.check()
        if active_session_authority() is not self._authority:
            raise BrowserRefused("BROWSER_OWNER_REFUSED")

    async def forget(
        self, access: BrowserOwnerAccess, *, sec_id: str, origins: list[str], fence
    ) -> ForgetReceipt:
        from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmissionRefused

        exact_session_selection(sec_id, origins)
        await self._check(access)
        try:
            permit = await self._admission.acquire_turn(incarnation=self._incarnation)
        except PodUpgradeAdmissionRefused:
            raise BrowserRefused("BROWSER_DRAINING") from None
        try:
            await self._check(access)
            cipher = BrowserSessionCipher(access.owner_id, self._key)
            receipts = []
            for origin in origins:
                receipts.append(
                    await erase_session_site(
                        log=self._log,
                        store=self._store,
                        site=cipher.site_id(origin, sec_id),
                        lock=self.lock,
                        check=lambda: self._check(access),
                        fence=fence,
                    )
                )
            await self._check(access)
            return ForgetReceipt(
                all(receipt.fenced for receipt in receipts),
                all(receipt.persisted for receipt in receipts),
                all(receipt.deletion_requested for receipt in receipts),
            )
        finally:
            await permit.release()

    def close(self) -> None:
        self._key = b""


def install_session_cleanup(app, *, log, dek, logger, admission=None) -> None:
    """After authenticated recovery, including when Browser itself is disabled."""
    from hushh_mcp.services.pod_session_authority import active_session_authority
    from hushh_mcp.services.pod_storage import resolve_pod_object_store
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    app.state.browser_session_cleanup = None
    try:
        cleanup = OwnerSessionCleanup(
            authority=active_session_authority(),
            log=log,
            store=resolve_pod_object_store(),
            dek=dek,
            incarnation=pod_incarnation(),
            admission=admission if admission is not None else ADMISSION,
        )
        app.state.browser_session_cleanup = cleanup
    except Exception:
        logger.warning("pod.browser_session_cleanup_unavailable")
