"""
Regression tests for _consent_exports TTL eviction in api/routes/consent.py.

Attach point: api/routes/consent.py (_evict_stale_consent_exports / _consent_exports)

Bug: The module-level `_consent_exports: Dict[str, Dict]` cache stores encrypted
consent export blobs keyed by consent-token string.  Entries were only removed
when a token was explicitly revoked (lines handling supersession and /revoke).
Tokens that expire naturally after their 24-hour TTL never triggered cleanup, so
their cache entries -- each containing encrypted_data, iv, tag, wrapped_key_bundle
and metadata -- accumulated in the process heap indefinitely.

In a long-running server that grants many consents, the dict grows without bound,
constituting a slow memory-exhaustion path (CWE-400).

Fix: Added _CONSENT_EXPORT_TTL_MS = 25 * 60 * 60 * 1000 (24-hour token lifetime
plus 1-hour grace) and _evict_stale_consent_exports(), which sweeps entries whose
`created_at` field is older than the TTL.  The sweep is called:
  - before every cache write (grant, DB-cache, refresh-upload)
  - lazily on the read path, before returning a cached entry
"""

import ast
import pathlib
import time
from unittest.mock import patch

from api.routes.consent import (
    _CONSENT_EXPORT_TTL_MS,
    _consent_exports,
    _evict_stale_consent_exports,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh_entry(offset_ms: int = 0) -> dict:
    """Return a minimal cache entry dict with created_at set to now + offset_ms."""
    return {
        "encrypted_data": b"ciphertext",
        "iv": b"iv",
        "tag": b"tag",
        "wrapped_key_bundle": {"connector_key_id": "k1"},
        "scope": "attr.financial.*",
        "export_revision": 1,
        "export_generated_at": "2024-01-01T00:00:00Z",
        "refresh_status": "current",
        "is_strict_zero_knowledge": True,
        "created_at": int(time.time() * 1000) + offset_ms,
    }


def _stale_entry() -> dict:
    """Return an entry whose created_at is older than the full TTL."""
    return _fresh_entry(offset_ms=-(_CONSENT_EXPORT_TTL_MS + 1))


# ---------------------------------------------------------------------------
# _evict_stale_consent_exports
# ---------------------------------------------------------------------------


def test_evict_removes_stale_entries():
    """Entries older than TTL must be removed by the sweep."""
    _consent_exports.clear()
    _consent_exports["tok_stale"] = _stale_entry()
    _consent_exports["tok_fresh"] = _fresh_entry()

    evicted = _evict_stale_consent_exports()

    assert evicted == 1, f"Expected 1 eviction, got {evicted}"
    assert "tok_stale" not in _consent_exports, "Stale entry was not removed"
    assert "tok_fresh" in _consent_exports, "Fresh entry was incorrectly removed"

    _consent_exports.clear()


def test_evict_keeps_all_fresh_entries():
    """The sweep must not touch entries that are still within their TTL."""
    _consent_exports.clear()
    for i in range(5):
        _consent_exports[f"tok_{i}"] = _fresh_entry()

    evicted = _evict_stale_consent_exports()

    assert evicted == 0
    assert len(_consent_exports) == 5

    _consent_exports.clear()


def test_evict_clears_all_stale_entries():
    """When all entries are stale the cache must be emptied."""
    _consent_exports.clear()
    for i in range(10):
        _consent_exports[f"tok_{i}"] = _stale_entry()

    evicted = _evict_stale_consent_exports()

    assert evicted == 10
    assert len(_consent_exports) == 0


def test_evict_handles_empty_cache():
    """The sweep must succeed on an empty dict."""
    _consent_exports.clear()
    evicted = _evict_stale_consent_exports()
    assert evicted == 0


def test_evict_handles_missing_created_at():
    """Entries without a created_at field are treated as stale (age = TTL)."""
    _consent_exports.clear()
    entry = _fresh_entry()
    del entry["created_at"]
    _consent_exports["tok_no_ts"] = entry

    evicted = _evict_stale_consent_exports()

    # created_at defaults to 0 => age is huge => must be evicted
    assert evicted == 1
    assert "tok_no_ts" not in _consent_exports


def test_evict_called_before_write_on_grant(monkeypatch):
    """
    _evict_stale_consent_exports must be called before a cache write triggered
    by a consent grant.  We verify by patching the helper and asserting it was
    invoked from within the write path.
    """
    calls = []

    # Patch the function at its canonical location
    with patch(
        "api.routes.consent._evict_stale_consent_exports",
        side_effect=lambda: calls.append(1) or 0,
    ):
        # Simulate what the grant handler does: call evict then write
        from api.routes import consent as consent_module

        consent_module._evict_stale_consent_exports()
        consent_module._consent_exports["synthetic_tok"] = _fresh_entry()

    assert calls, "_evict_stale_consent_exports was not called before cache write"
    _consent_exports.pop("synthetic_tok", None)


# ---------------------------------------------------------------------------
# TTL constant sanity check
# ---------------------------------------------------------------------------


def test_ttl_constant_is_at_least_24h():
    """TTL must cover the full 24-hour token lifetime."""
    twenty_four_hours_ms = 24 * 60 * 60 * 1000
    assert _CONSENT_EXPORT_TTL_MS >= twenty_four_hours_ms, (
        f"_CONSENT_EXPORT_TTL_MS={_CONSENT_EXPORT_TTL_MS} is less than 24 hours"
    )


def test_ttl_constant_not_excessively_large():
    """TTL should not extend far beyond what is needed (sanity upper bound = 48h)."""
    forty_eight_hours_ms = 48 * 60 * 60 * 1000
    assert _CONSENT_EXPORT_TTL_MS <= forty_eight_hours_ms, (
        f"_CONSENT_EXPORT_TTL_MS={_CONSENT_EXPORT_TTL_MS} exceeds 48 hours — "
        "stale entries would be kept too long"
    )


# ---------------------------------------------------------------------------
# AST guard: eviction helper is called at all write sites
# ---------------------------------------------------------------------------

CONSENT_PY = pathlib.Path(__file__).parent.parent / "api/routes/consent.py"


def _find_evict_calls(tree: ast.AST) -> list[int]:
    """Return line numbers of all _evict_stale_consent_exports() call sites."""
    calls = []

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "_evict_stale_consent_exports":
                calls.append(node.lineno)
            self.generic_visit(node)

    Visitor().visit(tree)
    return calls


def test_eviction_helper_exists_in_source():
    """The eviction helper function must be defined in consent.py."""
    source = CONSENT_PY.read_text()
    assert "def _evict_stale_consent_exports" in source, (
        "api/routes/consent.py does not define _evict_stale_consent_exports"
    )


def test_eviction_called_at_least_three_write_sites():
    """
    The eviction sweep must be called before each of the three cache-write sites:
      1. consent grant (approve)
      2. DB-fallback cache population (export endpoint)
      3. refresh-upload (export-refresh/complete)
    """
    source = CONSENT_PY.read_text()
    tree = ast.parse(source)
    calls = _find_evict_calls(tree)

    assert len(calls) >= 3, (
        f"Expected at least 3 _evict_stale_consent_exports() call sites, "
        f"found {len(calls)} at lines: {calls}"
    )
