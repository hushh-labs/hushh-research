"""Behavioral tests for _BoundedRevocationCache.

Verifies that the in-memory revocation cache:
- Rejects revoked tokens (membership semantics preserved)
- Evicts entries whose TTL has expired (memory bounded)
- Enforces the size cap when TTL eviction is insufficient
- Is thread-safe under concurrent add/contains access
- Exposes clear() for test-fixture cleanup (conftest.py compatibility)
- Does not raise on non-str __contains__ probes
"""

from __future__ import annotations

import threading
import time

from hushh_mcp.consent.token import _BoundedRevocationCache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cache(**overrides) -> _BoundedRevocationCache:
    c = _BoundedRevocationCache()
    for k, v in overrides.items():
        setattr(c, k, v)
    return c


# ---------------------------------------------------------------------------
# Basic membership semantics
# ---------------------------------------------------------------------------


def test_revoked_token_is_in_cache():
    c = _cache()
    c.add("tok_abc")
    assert "tok_abc" in c


def test_unknown_token_not_in_cache():
    c = _cache()
    assert "tok_unknown" not in c


def test_clear_empties_cache():
    c = _cache()
    c.add("tok1")
    c.add("tok2")
    c.clear()
    assert len(c) == 0
    assert "tok1" not in c


def test_len_tracks_entries():
    c = _cache()
    assert len(c) == 0
    c.add("a")
    assert len(c) == 1
    c.add("b")
    assert len(c) == 2


def test_duplicate_add_does_not_inflate_size():
    c = _cache()
    c.add("dup")
    c.add("dup")
    assert len(c) == 1


def test_non_str_contains_probe_returns_false():
    c = _cache()
    c.add("tok")
    assert (42 in c) is False
    assert (None in c) is False


# ---------------------------------------------------------------------------
# TTL eviction
# ---------------------------------------------------------------------------


def test_entry_evicted_after_ttl_expires():
    c = _cache()
    # Back-date the inserted entry so its TTL has already elapsed.
    c.add("old_tok")
    old_entry_time = int(time.time() * 1000) - c._TTL_MS - 1
    with c._lock:
        c._entries["old_tok"] = old_entry_time

    assert "old_tok" not in c
    # Eviction should also remove it from _entries
    with c._lock:
        assert "old_tok" not in c._entries


def test_entry_within_ttl_is_still_present():
    c = _cache()
    c.add("live_tok")
    # Back-date to just inside the TTL window (1 ms before cutoff).
    recent_entry_time = int(time.time() * 1000) - c._TTL_MS + 1_000
    with c._lock:
        c._entries["live_tok"] = recent_entry_time

    assert "live_tok" in c


def test_evict_expired_locked_returns_count_of_removed_entries():
    c = _cache()
    now_ms = int(time.time() * 1000)
    with c._lock:
        c._entries["expired1"] = now_ms - c._TTL_MS - 1
        c._entries["expired2"] = now_ms - c._TTL_MS - 2
        c._entries["live"] = now_ms
        removed = c._evict_expired_locked(now_ms)

    assert removed == 2
    with c._lock:
        assert "live" in c._entries
        assert "expired1" not in c._entries


# ---------------------------------------------------------------------------
# Size cap
# ---------------------------------------------------------------------------


def test_size_cap_enforced_when_ttl_eviction_insufficient():
    c = _BoundedRevocationCache()
    c._MAX_SIZE = 5

    for i in range(10):
        c.add(f"tok_{i}")

    assert len(c) <= 5


def test_most_recently_added_entry_survives_cap_eviction():
    c = _BoundedRevocationCache()
    c._MAX_SIZE = 3

    # Add entries with artificially old timestamps so they are "older".
    now_ms = int(time.time() * 1000)
    with c._lock:
        c._entries["old_1"] = now_ms - 3000
        c._entries["old_2"] = now_ms - 2000
        c._entries["old_3"] = now_ms - 1000

    # Adding one more should evict the oldest (old_1).
    c.add("new_tok")

    with c._lock:
        assert "old_1" not in c._entries
        assert "new_tok" in c._entries


def test_size_cap_zero_means_no_entry_survives():
    c = _BoundedRevocationCache()
    c._MAX_SIZE = 0
    c.add("tok")
    assert len(c) == 0


# ---------------------------------------------------------------------------
# Thread safety
# ---------------------------------------------------------------------------


def test_concurrent_adds_do_not_corrupt_cache():
    c = _cache()
    errors: list[Exception] = []

    def _worker(n: int) -> None:
        try:
            for i in range(50):
                c.add(f"thread_{n}_tok_{i}")
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=_worker, args=(t,)) for t in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"Exceptions raised in worker threads: {errors}"
    assert len(c) <= c._MAX_SIZE


def test_concurrent_contains_while_adding_does_not_raise():
    c = _cache()
    c.add("existing")
    errors: list[Exception] = []

    def _reader() -> None:
        try:
            for _ in range(100):
                _ = "existing" in c
        except Exception as exc:
            errors.append(exc)

    def _writer() -> None:
        try:
            for i in range(100):
                c.add(f"new_{i}")
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=_reader) for _ in range(4)] + [
        threading.Thread(target=_writer) for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []


# ---------------------------------------------------------------------------
# Integration: validate_token rejects entries added to the module-level cache
# ---------------------------------------------------------------------------


def test_revoke_token_causes_validate_token_to_reject():
    """revoke_token() uses _revoked_tokens; validate_token() checks it."""
    from hushh_mcp.consent.token import _revoked_tokens, issue_token, revoke_token, validate_token
    from hushh_mcp.constants import ConsentScope

    tok = issue_token("user1", "agent1", ConsentScope.VAULT_OWNER, expires_in_ms=60_000)
    valid_before, _, _ = validate_token(tok.token)
    assert valid_before is True

    revoke_token(tok.token)
    try:
        valid_after, reason, _ = validate_token(tok.token)
        assert valid_after is False
        assert "revoked" in (reason or "").lower()
    finally:
        # Clean up so other tests are not affected.
        _revoked_tokens.clear()
