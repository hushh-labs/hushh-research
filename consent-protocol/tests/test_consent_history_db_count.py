"""
Tests that get_audit_log uses DB-side count="exact" instead of a 5000-row fetch.

Canonical attach point:
    hushh_mcp.services.consent_db.ConsentDBService.get_audit_log
    (surfaced by api.routes.session.get_consent_history -> GET /api/consent/history)
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


class _FakeResponse:
    def __init__(self, data=None, count=None):
        self.data = data or []
        self.count = count


class TestConsentHistoryDbCount:
    """Proves that get_audit_log uses count='exact' and does not fetch 5000 rows for counting."""

    @pytest.mark.asyncio
    async def test_count_query_uses_exact_count(self, monkeypatch):
        select_calls: list[dict] = []

        class _FakeTable:
            def __init__(self):
                self._filters = []
                self._select_args = ()
                self._select_kwargs = {}

            def select(self, *args, **kwargs):
                self._select_args = args
                self._select_kwargs = kwargs
                select_calls.append({"args": args, "kwargs": kwargs})
                return self

            def eq(self, *a, **kw):
                return self

            def not_(self, *a, **kw):
                return self

            def order(self, *a, **kw):
                return self

            def limit(self, n):
                self._limit = n
                return self

            def offset(self, n):
                return self

            def execute(self):
                # Return different stubs based on whether count="exact" is requested
                if self._select_kwargs.get("count") == "exact":
                    return _FakeResponse(data=[], count=42)
                return _FakeResponse(data=[])

        class _FakeSupabase:
            def table(self, name):
                return _FakeTable()

        service = ConsentDBService()
        monkeypatch.setattr(service, "_get_supabase", lambda: _FakeSupabase())

        result = await service.get_audit_log("user_abc", page=1, limit=10)

        # Verify a count="exact" call was made
        count_calls = [c for c in select_calls if c["kwargs"].get("count") == "exact"]
        assert count_calls, (
            "Expected at least one select() call with count='exact'; got none. "
            f"All select calls: {select_calls}"
        )

        # Verify the returned total comes from DB count, not len(rows)
        assert result["total"] == 42

    @pytest.mark.asyncio
    async def test_count_query_does_not_fetch_5000_rows(self, monkeypatch):
        limit_values: list[int] = []

        class _FakeTable:
            def __init__(self):
                self._is_count = False

            def select(self, *args, **kwargs):
                if kwargs.get("count") == "exact":
                    self._is_count = True
                return self

            def eq(self, *a, **kw):
                return self

            def not_(self, *a, **kw):
                return self

            def order(self, *a, **kw):
                return self

            def limit(self, n):
                if self._is_count:
                    limit_values.append(n)
                return self

            def offset(self, n):
                return self

            def execute(self):
                if self._is_count:
                    return _FakeResponse(data=[], count=7)
                return _FakeResponse(data=[])

        class _FakeSupabase:
            def table(self, name):
                return _FakeTable()

        service = ConsentDBService()
        monkeypatch.setattr(service, "_get_supabase", lambda: _FakeSupabase())

        await service.get_audit_log("user_abc", page=1, limit=10)

        # The count query should use limit(0), NOT limit(5000)
        for lim in limit_values:
            assert lim != 5000, (
                f"Count query still fetches {lim} rows; expected limit(0) with count='exact'"
            )
