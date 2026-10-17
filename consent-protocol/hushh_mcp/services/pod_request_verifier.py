"""Hub verification of a signed pod request -- one verifier for every cloud.

The order of checks is the security argument, so it is spelled out:

1. **Shape and window.** A present-but-malformed signature is refused outright and
   never downgraded to the Google path. ``ts`` must be in [now - 60 s, now + 30 s].
2. **The row.** Looked up by the HusshID the pod asserts. The asserted id is inside
   the signed payload, so claiming another person's HusshID only selects THEIR row,
   whose key the caller does not hold. No row at all is ``KEY_UNRESOLVED``.
3. **The key.** If the row's recorded ``pod_signing_key_id`` is the header's kid,
   the stored key verifies. Otherwise the request may only TRIGGER a hub-initiated
   pull -- throttled per row (about 30 s, a conditional write) and by a per-process
   cap that only a request which won its row's slot can spend, so hammering one
   row never starves another -- to the address the hub recorded when it created
   the pod, with the hub's own credential. The request never carries key
   material. Then the row is re-read and the comparison repeated. A kid that is
   still unknown is ``KEY_UNRESOLVED``, which a caller may treat as "unsigned"
   for a row that has never signed.
4. **The signature**, over the exact method, path, query and raw body.
5. **The nonce**, consumed only after the signature verifies, so unauthenticated
   junk can never fill the replay table. A reused nonce is a replay: refused.
6. **The latch.** The first valid signature latches the row to ``signed``.

**Two placements (``pod_placement_fence``, STANDBY-SYNC.md E4).** Once the person has
a standby or ``placement_epoch > 0``, step 3 runs fenced: the request must carry a
current ``X-Hushh-Pod-Epoch`` (signed), turn and write paths accept only the primary's
key, the standby's key is accepted only when the caller passes ``sync_path=True``, and
a key that stays unknown after the pull is ``INVALID`` rather than ``KEY_UNRESOLVED``.
Without migration 950 (no ``placement_epoch`` on the row) nothing here changes.

Every failure is a quiet ``INVALID`` (or ``KEY_UNRESOLVED``) with a log line that
names the reason and never the key, the signature or the body.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER
from hushh_mcp.services.pod_placement_fence import (
    PlacementFence,
    choose_key,
    epoch_refusal,
    read_placement_fence,
    row_epoch,
)
from hushh_mcp.services.pod_request_signing import (
    MAX_AGE_MS,
    PodRequestSignatureMalformed,
    SignedRequestHeaders,
    VerifiedPod,
    parse_signature_headers,
    timestamp_in_window,
    verify_request_signature,
)

logger = logging.getLogger(__name__)

#: One hub-initiated key pull per row per interval, however many requests ask.
PULL_INTERVAL_MS = 30_000
#: And at most this many pulls per window in one hub process, across all rows, so
#: the hub can never be used to wake (and bill) a fleet of pods. It counts pulls,
#: never attempts: a request that loses its row's slot does not spend it.
GLOBAL_PULL_CAP = 20
GLOBAL_PULL_WINDOW_SECONDS = 60.0
#: A nonce must outlive every moment its timestamp could still be accepted, with a
#: margin for clock skew between hub instances.
NONCE_RETENTION_MS = MAX_AGE_MS + 60_000


class SignedOutcome(str, Enum):
    UNSIGNED = "unsigned"
    INVALID = "invalid"
    KEY_UNRESOLVED = "key_unresolved"
    VERIFIED = "verified"


@dataclass(frozen=True)
class SignedRequest:
    """The transport-neutral view of one HTTP request."""

    headers: Mapping[str, str]
    method: str
    path: str
    query_pairs: list[tuple[str, str]]
    body: bytes


@dataclass(frozen=True)
class SignedVerification:
    outcome: SignedOutcome
    pod: Optional[VerifiedPod] = None
    #: The registry row this decision read, when it read one. A caller deciding the
    #: latch on the transitional path reuses it instead of reading twice.
    row: Optional[dict] = None


class PullCap:
    """A sliding-window cap on hub-initiated key pulls, per process."""

    def __init__(
        self, limit: int = GLOBAL_PULL_CAP, window_seconds: float = GLOBAL_PULL_WINDOW_SECONDS
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._stamps: deque[float] = deque()
        self._lock = threading.Lock()

    def _expire(self, now: float) -> None:
        while self._stamps and now - self._stamps[0] >= self._window:
            self._stamps.popleft()

    def has_room(self) -> bool:
        """Whether a pull would be allowed now. Spends nothing."""
        with self._lock:
            self._expire(time.monotonic())
            return len(self._stamps) < self._limit

    def allow(self) -> bool:
        """Spend one slot for a pull that is about to happen. False when full."""
        now = time.monotonic()
        with self._lock:
            self._expire(now)
            if len(self._stamps) >= self._limit:
                return False
            self._stamps.append(now)
            return True


_DEFAULT_CAP = PullCap()

Refresh = Callable[[dict], Awaitable[Any]]


def _refuse(reason: str, row: Optional[dict] = None) -> SignedVerification:
    logger.info("pod_request_auth.refused reason=%s", reason)
    return SignedVerification(SignedOutcome.INVALID, row=row)


def _recorded_key(row: Optional[dict]) -> tuple[str, str]:
    if not isinstance(row, dict):
        return "", ""
    return (
        str(row.get("pod_signing_key_id") or "").strip(),
        str(row.get("pod_signing_pubkey") or "").strip(),
    )


async def _read_row(registry: Any, hushh_id: str) -> Optional[dict]:
    try:
        row = await registry.get_by_hushh_id(hushh_id)
    except Exception as exc:  # noqa: BLE001 - an unreadable registry is not a pod
        logger.warning("pod_request_auth.registry_read_failed %s", type(exc).__name__)
        return None
    return row if isinstance(row, dict) else None


async def _pull_then_reread(
    row: dict, *, registry: Any, store: Any, refresh: Refresh, cap: PullCap, now_ms: int
) -> Optional[dict]:
    """Trigger at most one throttled hub-initiated pull, then re-read the row.

    The row's slot is claimed BEFORE the cap is spent, so a request that loses the
    per-row throttle never touches the cap: junk aimed at one row buys at most one
    cap slot per interval. A full cap is checked first without spending, so it does
    not burn the row's 30 s stamp either.
    """
    hushh_id = str(row.get("hushh_id") or "")
    if not cap.has_room():
        logger.warning("pod_request_auth.pull_capped")
        return None
    try:
        claimed = await store.claim_key_pull(
            hushh_id=hushh_id, interval_ms=PULL_INTERVAL_MS, now_ms=now_ms
        )
    except Exception as exc:  # noqa: BLE001 - no stamp, no pull
        logger.info("pod_request_auth.pull_claim_failed %s", type(exc).__name__)
        return None
    if not claimed:
        return None
    if not cap.allow():  # filled by other rows between the check and the claim
        logger.warning("pod_request_auth.pull_capped")
        return None
    try:
        await refresh(row)
    except Exception as exc:  # noqa: BLE001 - the collector is best-effort by design
        logger.info("pod_request_auth.pull_failed %s", type(exc).__name__)
        return None
    return await _read_row(registry, hushh_id)


async def _consume_nonce(store: Any, signed: SignedRequestHeaders) -> bool:
    try:
        return bool(
            await store.consume_nonce(
                kid=signed.kid,
                nonce=signed.nonce,
                expires_at_ms=signed.ts_ms + NONCE_RETENTION_MS,
            )
        )
    except Exception as exc:  # noqa: BLE001 - unable to prove single use: refuse
        logger.warning("pod_request_auth.nonce_unavailable %s", type(exc).__name__)
        return False


async def _latch(store: Any, row: dict, kid: str) -> None:
    if str(row.get("identity_mode") or "") == "signed":
        return
    try:
        await store.latch_signed(hushh_id=str(row.get("hushh_id") or ""), kid=kid)
    except Exception as exc:  # noqa: BLE001 - the next signed request latches it
        logger.warning("pod_request_auth.latch_failed %s", type(exc).__name__)


@dataclass(frozen=True)
class _Deps:
    registry: Any
    store: Any
    refresh: Refresh
    cap: PullCap
    now_ms: int


async def _finish(
    request: SignedRequest,
    signed: SignedRequestHeaders,
    *,
    aud: str,
    hushh_id: str,
    row: dict,
    public_key: str,
    store: Any,
    standby: bool = False,
) -> SignedVerification:
    """Steps 4 to 6 under the chosen key: signature, nonce, latch."""
    verified = verify_request_signature(
        public_key,
        signed,
        aud=aud,
        hushh_id=hushh_id,
        method=request.method,
        path=request.path,
        query_pairs=request.query_pairs,
        body=request.body,
    )
    if not verified:
        return _refuse("bad_signature", row)
    if not await _consume_nonce(store, signed):
        return _refuse("replayed_nonce", row)
    if not standby:  # the latch belongs to the primary's key on the registry row
        await _latch(store, row, signed.kid)
    pod = VerifiedPod(hushh_id=hushh_id, key_id=signed.kid, standby=standby)
    return SignedVerification(SignedOutcome.VERIFIED, pod=pod, row=row)


async def _verify_fenced(
    request: SignedRequest,
    signed: SignedRequestHeaders,
    *,
    aud: str,
    hushh_id: str,
    row: dict,
    fence: PlacementFence,
    deps: _Deps,
    sync_path: bool,
) -> SignedVerification:
    """Step 3 for a person with two placements. Every failure is INVALID (E4)."""
    refusal = epoch_refusal(fence, signed.epoch)
    if refusal:
        return _refuse(refusal, row)
    choice = choose_key(fence, row, signed.kid, sync_path=sync_path)
    if choice.refusal:
        return _refuse(choice.refusal, row)
    if choice.needs_pull:
        pulled = await _pull_then_reread(
            row,
            registry=deps.registry,
            store=deps.store,
            refresh=deps.refresh,
            cap=deps.cap,
            now_ms=deps.now_ms,
        )
        if pulled is None or _recorded_key(pulled)[0] != signed.kid:
            return _refuse("key_unresolved", pulled or row)
        pulled_epoch = row_epoch(pulled)
        if pulled_epoch is None or (signed.epoch or 0) < pulled_epoch:
            return _refuse("epoch_stale", pulled)
        row = pulled
        choice = choose_key(fence, row, signed.kid, sync_path=sync_path)
        if choice.refusal or choice.needs_pull:
            return _refuse(choice.refusal or "key_unresolved", row)
    return await _finish(
        request,
        signed,
        aud=aud,
        hushh_id=hushh_id,
        row=row,
        public_key=choice.public_key or _recorded_key(row)[1],
        store=deps.store,
        standby=choice.standby,
    )


async def verify_signed_request(
    request: SignedRequest,
    *,
    aud: str,
    registry: Any,
    store: Any,
    refresh: Refresh,
    now_ms: Optional[int] = None,
    cap: Optional[PullCap] = None,
    standbys: Any = None,
    sync_path: bool = False,
) -> SignedVerification:
    """Decide one request. Never raises.

    ``standbys`` reads the person's standby (``read_standby(user_id)``); it is
    consulted only when the row carries ``placement_epoch`` (migration 950).
    ``sync_path`` admits the standby's key; leave it False on turn and write paths.
    """
    try:
        signed = parse_signature_headers(request.headers)
    except PodRequestSignatureMalformed:
        return _refuse("malformed")
    if signed is None:
        return SignedVerification(SignedOutcome.UNSIGNED)
    hushh_id = str(request.headers.get(POD_IDENTITY_HEADER) or "").strip()
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if not hushh_id or not aud:
        return _refuse("no_identity_or_audience")
    if not timestamp_in_window(signed.ts_ms, now):
        return _refuse("stale_timestamp")
    row = await _read_row(registry, hushh_id)
    if row is None or str(row.get("hushh_id") or "") != hushh_id:
        # No row holds a key to check this against. That is not a bad signature, so
        # the transitional path still decides exactly as it did before signing
        # existed (for a GCP orphan pod: verified, then the route's 404).
        logger.info("pod_request_auth.unknown_pod")
        return SignedVerification(SignedOutcome.KEY_UNRESOLVED)
    fence = await read_placement_fence(row, standbys)
    if fence is None:
        return _refuse("placement_unreadable", row)
    if fence.fenced:
        deps = _Deps(registry, store, refresh, cap or _DEFAULT_CAP, now)
        return await _verify_fenced(
            request,
            signed,
            aud=aud,
            hushh_id=hushh_id,
            row=row,
            fence=fence,
            deps=deps,
            sync_path=sync_path,
        )
    if _recorded_key(row)[0] != signed.kid:
        pulled = await _pull_then_reread(
            row,
            registry=registry,
            store=store,
            refresh=refresh,
            cap=cap or _DEFAULT_CAP,
            now_ms=now,
        )
        if pulled is None or _recorded_key(pulled)[0] != signed.kid:
            logger.info("pod_request_auth.key_unresolved")
            return SignedVerification(SignedOutcome.KEY_UNRESOLVED, row=pulled or row)
        row = pulled
    return await _finish(
        request,
        signed,
        aud=aud,
        hushh_id=hushh_id,
        row=row,
        public_key=_recorded_key(row)[1],
        store=store,
    )
