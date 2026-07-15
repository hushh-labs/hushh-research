"""Tests that the domain registry cache timer uses timezone-aware UTC.

DomainRegistryService tracked cache freshness with datetime.utcnow(): it set
self._cache_time on load and computed elapsed time in _is_cache_valid by
subtracting _cache_time from another utcnow() value. datetime.utcnow() is
deprecated and returns a naive datetime.

The fix uses datetime.now(timezone.utc) at every site. Because the setter and
the elapsed computation must stay on the same awareness, mixing a tz-aware
"now" with a naive _cache_time would raise TypeError inside _is_cache_valid.
These tests drive the real _is_cache_valid method on a real service instance
with a tz-aware _cache_time and assert fresh and expired cache windows behave
correctly without raising, and that the module no longer calls utcnow.

Reachable from api/routes/pkm.py and api/routes/pkm_routes_shared.py, which
use DomainRegistryService.get_domain, list_domains, and register_domain; each
calls _is_cache_valid before serving cached domains.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hushh_mcp.services.domain_registry_service import DomainRegistryService


def test_is_cache_valid_true_for_fresh_aware_cache_time():
    service = DomainRegistryService()
    service._cache["financial"] = object()  # type: ignore[assignment]
    service._cache_time = datetime.now(timezone.utc)

    # Must not raise: a tz-aware now minus a tz-aware _cache_time is valid.
    assert service._is_cache_valid() is True


def test_is_cache_valid_false_for_expired_aware_cache_time():
    service = DomainRegistryService()
    service._cache["financial"] = object()  # type: ignore[assignment]
    service._cache_time = datetime.now(timezone.utc) - timedelta(
        seconds=service._cache_ttl + 10
    )

    assert service._is_cache_valid() is False


def test_is_cache_valid_false_when_never_loaded():
    service = DomainRegistryService()
    assert service._cache_time is None
    assert service._is_cache_valid() is False


def test_domain_registry_module_has_no_deprecated_utcnow():
    import inspect

    from hushh_mcp.services import domain_registry_service

    source = inspect.getsource(domain_registry_service)
    assert "datetime.utcnow(" not in source
