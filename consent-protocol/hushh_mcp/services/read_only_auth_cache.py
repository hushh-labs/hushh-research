"""Short-TTL bounded read-only auth and tombstone lookup caches."""

from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
from typing import Any

_CACHE_TTL_SECONDS = 15.0
_CACHE_MAX_ENTRIES = 4096
_CACHE_LOCK = threading.RLock()
_NOT_TOMBSTONED_CACHE: OrderedDict[str, float] = OrderedDict()
_ACTIVE_DEVICE_CACHE: OrderedDict[tuple[str, str], float] = OrderedDict()


def allow_read_only_auth_cache() -> bool:
    """Only cache auth/tombstone checks during read-only HTTP requests outside pytest."""
    if os.getenv("PYTEST_CURRENT_TEST"):
        return False
    from api.middlewares.observability import is_read_only_request

    return is_read_only_request()


def invalidate_tombstone_cache(*user_ids: str) -> None:
    """Evict cached negative tombstone lookups when deletion state changes."""
    with _CACHE_LOCK:
        if not user_ids:
            _NOT_TOMBSTONED_CACHE.clear()
            return
        for raw_uid in user_ids:
            clean_uid = str(raw_uid or "").strip()
            if clean_uid:
                _NOT_TOMBSTONED_CACHE.pop(clean_uid, None)


def probe_cached_not_tombstoned(normalized_user_id: str) -> tuple[bool, bool]:
    """Return ``(use_cache, hit_not_tombstoned)`` for a negative tombstone check."""
    use_cache = allow_read_only_auth_cache()
    if not use_cache:
        return False, False
    now = time.monotonic()
    with _CACHE_LOCK:
        expires_at = _NOT_TOMBSTONED_CACHE.get(normalized_user_id)
        if expires_at is not None and expires_at > now:
            _NOT_TOMBSTONED_CACHE.move_to_end(normalized_user_id)
            return True, True
        if expires_at is not None:
            _NOT_TOMBSTONED_CACHE.pop(normalized_user_id, None)
    return True, False


def settle_tombstone_row(
    normalized_user_id: str,
    row: Any,
    *,
    use_cache: bool,
    in_progress_exc_cls: type[Exception],
) -> bool:
    """Enforce tombstone row state and cache negative read-only results only."""
    if row is not None and row[0] in {"provider_cleanup", "local_erasure"}:
        invalidate_tombstone_cache(normalized_user_id)
        raise in_progress_exc_cls("approved account cleanup is still running")
    if row is not None:
        invalidate_tombstone_cache(normalized_user_id)
        return True
    if use_cache:
        with _CACHE_LOCK:
            _NOT_TOMBSTONED_CACHE[normalized_user_id] = time.monotonic() + _CACHE_TTL_SECONDS
            _NOT_TOMBSTONED_CACHE.move_to_end(normalized_user_id)
            while len(_NOT_TOMBSTONED_CACHE) > _CACHE_MAX_ENTRIES:
                _NOT_TOMBSTONED_CACHE.popitem(last=False)
    return False


def invalidate_active_device_cache(user_id: str, device_id: str | None = None) -> None:
    """Evict cached active-device checks when a device is replaced or revoked."""
    with _CACHE_LOCK:
        if device_id is not None:
            _ACTIVE_DEVICE_CACHE.pop((user_id, device_id), None)
            return
        for key in [k for k in _ACTIVE_DEVICE_CACHE if k[0] == user_id]:
            _ACTIVE_DEVICE_CACHE.pop(key, None)


def is_active_device_cached(store: Any, *, user_id: str, device_id: str) -> bool:
    """Lookup active trusted device with read-only positive caching."""
    use_cache = allow_read_only_auth_cache()
    key = (user_id, device_id)
    if use_cache:
        now = time.monotonic()
        with _CACHE_LOCK:
            expires_at = _ACTIVE_DEVICE_CACHE.get(key)
            if expires_at is not None and expires_at > now:
                _ACTIVE_DEVICE_CACHE.move_to_end(key)
                return True
            if expires_at is not None:
                _ACTIVE_DEVICE_CACHE.pop(key, None)
    active = store.get_active_device(user_id=user_id, device_id=device_id) is not None
    if use_cache and active:
        with _CACHE_LOCK:
            _ACTIVE_DEVICE_CACHE[key] = time.monotonic() + _CACHE_TTL_SECONDS
            _ACTIVE_DEVICE_CACHE.move_to_end(key)
            while len(_ACTIVE_DEVICE_CACHE) > _CACHE_MAX_ENTRIES:
                _ACTIVE_DEVICE_CACHE.popitem(last=False)
    elif not active:
        invalidate_active_device_cache(user_id, device_id)
    return active


def revoke_and_invalidate_active_device(
    store: Any, *, user_id: str, device_id: str, now_ms: int
) -> bool:
    """Revoke a device in the store, invalidate positive read cache, and audit."""
    revoked = store.revoke_device(user_id=user_id, device_id=device_id, now_ms=now_ms)
    if revoked:
        invalidate_active_device_cache(user_id, device_id)
        store.audit(
            user_id=user_id, device_id=device_id, event_type="device_revoked", created_at=now_ms
        )
    return bool(revoked)
