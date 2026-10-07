"""The agent's half of the signed owner feed: fetch, verify, open, cache.

An owner-cloud agent reads its owner's location state, consent center, marketplace
listing and command candidates from ``/api/one/pod/owner-feed`` instead of handing a
consent token to a hub door. Every answer is opened with this agent's own X25519 key
and its ``OWNER_FEED`` signature is checked against the public keys in
``OWNER_FEED_ED25519_PUBLIC_KEYS``; anything that fails is
``OwnerFeedUnavailable``, never an empty state.

Snapshots are cached briefly by version so one turn's several questions make one
read; a newer answer never gives way to an older one. Command reads are never cached:
each is a distinct, budgeted question.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

_FEED_PATH = "/api/one/pod/owner-feed"
_SNAPSHOT_TTL_SECONDS = 15.0
_TIMEOUT_SECONDS = 10.0
_MAX_CACHE_ENTRIES = 128


class OwnerFeedUnavailable(RuntimeError):
    """The feed could not be read, or what came back did not verify for this agent."""


def owner_feed_enabled() -> bool:
    """True when this agent can verify owner feeds (the hub gave it the public key)."""
    from hushh_mcp.consent.token_signing import OWNER_FEED, known_kids  # noqa: PLC0415

    try:
        return bool(known_kids(OWNER_FEED))
    except RuntimeError:
        logger.warning("pod_owner_feed.public_keys_malformed")
        return False


@dataclass(frozen=True)
class _Cached:
    version: str
    issued_at_ms: int
    projection: dict
    fetched_at: float
    binding: tuple[Any, ...]


class PodOwnerFeedClient:
    """Sync, like ``PodHubClient``; callers use ``asyncio.to_thread``."""

    def __init__(
        self,
        *,
        hub: Any = None,
        keypair: Any = None,
        ttl_seconds: float = _SNAPSHOT_TTL_SECONDS,
        clock: Any = time.time,
    ) -> None:
        self._hub = hub
        self._keypair = keypair
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, str, str], _Cached] = {}

    def _fetch(self, kind: str, params: dict[str, Any], command: Optional[dict]) -> Any:
        hub = self._hub
        if hub is None:
            from hushh_mcp.services.pod_hub_client import PodHubClient  # noqa: PLC0415

            hub = PodHubClient(timeout_seconds=_TIMEOUT_SECONDS)
        if command is not None:
            return hub.post(f"{_FEED_PATH}/command", json=command)
        return hub.get(f"{_FEED_PATH}/{kind}", params=params or None)

    def _open(self, envelope: Any, kind: str, owner_id: str) -> dict:
        from hushh_mcp.services.pod_owner_feed_envelope import open_feed  # noqa: PLC0415

        keypair = self._keypair
        if keypair is None:
            from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415

            keypair = pod_keypair()
        feed = open_feed(
            envelope,
            pod_private_key=keypair.private_key,
            hushh_id=(os.getenv("HUSSH_ID") or "").strip(),
            pod_key_id=keypair.key_id,
            kind=kind,
            now_ms=int(self._clock() * 1000),
        )
        if feed["ownerId"] != owner_id:
            raise OwnerFeedUnavailable("owner feed names another owner")
        return feed

    def _binding(self) -> tuple[Any, ...]:
        from hushh_mcp.services.pod_session_authority import active_session_authority

        keypair = self._keypair
        if keypair is None:
            from hushh_mcp.services.pod_self_registration import pod_keypair

            keypair = pod_keypair()
        authority = active_session_authority()
        return (
            (os.getenv("HUSSH_ID") or "").strip(),
            keypair.key_id,
            keypair.private_key.public_key().public_bytes_raw(),
            None if authority is None else authority.epoch,
            None if authority is None else authority.environment,
            None if authority is None else authority.pod_key_id,
        )

    def read(
        self,
        kind: str,
        owner_id: str,
        *,
        params: Optional[dict[str, Any]] = None,
        command: Optional[dict[str, Any]] = None,
    ) -> dict:
        """The verified projection for one read of ``owner_id``'s own feed."""
        if not owner_id:
            raise OwnerFeedUnavailable("owner feed needs an owner")
        try:
            binding = self._binding()
        except Exception:
            raise OwnerFeedUnavailable("owner feed binding unavailable") from None
        query = {key: value for key, value in (params or {}).items() if value is not None}
        key = (kind, owner_id, json.dumps(query, sort_keys=True))
        now = self._clock()
        with self._lock:
            held = self._cache.get(key) if command is None else None
        if held is not None and held.binding == binding and 0 <= now - held.fetched_at < self._ttl:
            return copy.deepcopy(held.projection)
        try:
            response = self._fetch(kind, query, command)
            if getattr(response, "status_code", 0) != 200:
                raise OwnerFeedUnavailable(
                    f"owner feed refused status={getattr(response, 'status_code', 0)}"
                )
            body = response.json()
            feed = self._open(
                body.get("envelope") if isinstance(body, dict) else None, kind, owner_id
            )
        except OwnerFeedUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is one typed state
            raise OwnerFeedUnavailable(f"owner feed unavailable: {type(exc).__name__}") from None
        if command is not None:
            if self._binding() != binding:
                raise OwnerFeedUnavailable("owner feed binding changed")
            return feed["projection"]
        with self._lock:
            if self._binding() != binding:
                raise OwnerFeedUnavailable("owner feed binding changed")
            held = self._cache.get(key)
            if (
                held is not None
                and held.binding == binding
                and feed["issuedAtMs"] < held.issued_at_ms
            ):
                raise OwnerFeedUnavailable("owner feed went backwards")
            if key not in self._cache and len(self._cache) >= _MAX_CACHE_ENTRIES:
                oldest = min(self._cache, key=lambda entry: self._cache[entry].fetched_at)
                del self._cache[oldest]
            self._cache[key] = _Cached(
                feed["version"], feed["issuedAtMs"], feed["projection"], now, binding
            )
        return copy.deepcopy(feed["projection"])


_SHARED: Optional[PodOwnerFeedClient] = None
_SHARED_LOCK = threading.Lock()


def owner_feed_client() -> Optional[PodOwnerFeedClient]:
    """The process's feed client, or None when this agent cannot verify a feed."""
    global _SHARED
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    if not owner_cloud_agent():
        return None
    if not owner_feed_enabled():
        return None
    with _SHARED_LOCK:
        if _SHARED is None:
            _SHARED = PodOwnerFeedClient()
        return _SHARED


__all__ = [
    "OwnerFeedUnavailable",
    "PodOwnerFeedClient",
    "owner_feed_client",
    "owner_feed_enabled",
]
