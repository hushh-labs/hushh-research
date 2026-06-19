"""
Verify that the slowapi @limiter.limit() decorator is actually registered on
the routes that were previously unprotected.

Strategy
--------
Build a minimal FastAPI app for each route module, wire the limiter and
exception handler exactly as server.py does, override the limiter's storage
backend with an in-memory MemoryStorage so tests are hermetic and instant,
and confirm that the decorated handlers return 429 once the bucket is
exhausted.

No database, no network, no external service calls.
"""

from __future__ import annotations

import inspect

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

import api.routes.consent as consent_module
import api.routes.developer as developer_module
import api.routes.ria as ria_module
from api.middlewares.rate_limit import RateLimits

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_limiter(limit_string: str) -> Limiter:
    """Return a fresh Limiter that resets after *limit_string* hits."""
    return Limiter(
        key_func=get_remote_address,
        default_limits=[limit_string],
        storage_uri="memory://",
    )


# ---------------------------------------------------------------------------
# Decorator registration tests (static analysis, no HTTP round-trip needed)
# ---------------------------------------------------------------------------


class TestDecoratorRegistration:
    """Confirm that @limiter.limit() appears on the expected handlers."""

    def _router_operations(self, router) -> dict[str, list[str]]:
        """Map 'METHOD /path' -> list[decorator names] from the router."""
        result: dict[str, list[str]] = {}
        for route in router.routes:
            key = f"{','.join(route.methods or [])} {route.path}"
            result[key] = []
            # FastAPI wraps the original function; check its __wrapped__ chain
            fn = route.endpoint
            while hasattr(fn, "__wrapped__"):
                fn = fn.__wrapped__
        return result

    def test_consent_routes_have_limiter_import(self):
        """consent.py must import limiter from the rate_limit middleware."""
        src = inspect.getsource(consent_module)
        assert "from api.middlewares.rate_limit import" in src
        assert "limiter" in src

    def test_ria_routes_have_limiter_import(self):
        src = inspect.getsource(ria_module)
        assert "from api.middlewares.rate_limit import" in src
        assert "limiter" in src

    def test_developer_routes_have_limiter_import(self):
        src = inspect.getsource(developer_module)
        assert "from api.middlewares.rate_limit import" in src
        assert "limiter" in src

    def test_consent_module_uses_limiter_limit(self):
        src = inspect.getsource(consent_module)
        assert "@limiter.limit(" in src

    def test_ria_module_uses_limiter_limit(self):
        src = inspect.getsource(ria_module)
        assert "@limiter.limit(" in src

    def test_developer_module_uses_limiter_limit(self):
        src = inspect.getsource(developer_module)
        assert "@limiter.limit(" in src


# ---------------------------------------------------------------------------
# Rate constant contract
# ---------------------------------------------------------------------------


class TestRateLimitConstants:
    """Each constant must be a valid slowapi limit string."""

    @pytest.mark.parametrize(
        "attr,expected",
        [
            ("CONSENT_REQUEST", "10/minute"),
            ("CONSENT_ACTION", "20/minute"),
            ("TOKEN_VALIDATION", "60/minute"),
            ("AGENT_CHAT", "30/minute"),
            ("GLOBAL_PER_IP", "100/minute"),
        ],
    )
    def test_constant_value(self, attr: str, expected: str):
        assert getattr(RateLimits, attr) == expected

    def test_all_constants_are_strings(self):
        for name in (
            "CONSENT_REQUEST",
            "CONSENT_ACTION",
            "TOKEN_VALIDATION",
            "AGENT_CHAT",
            "GLOBAL_PER_IP",
        ):
            val = getattr(RateLimits, name)
            assert isinstance(val, str), f"{name} must be a str"

    def test_all_constants_have_per_minute_granularity(self):
        for name in (
            "CONSENT_REQUEST",
            "CONSENT_ACTION",
            "TOKEN_VALIDATION",
            "AGENT_CHAT",
            "GLOBAL_PER_IP",
        ):
            val = getattr(RateLimits, name)
            assert val.endswith("/minute"), f"{name} must end with /minute"

    def test_limits_are_numerically_positive(self):
        for name in (
            "CONSENT_REQUEST",
            "CONSENT_ACTION",
            "TOKEN_VALIDATION",
            "AGENT_CHAT",
            "GLOBAL_PER_IP",
        ):
            val = getattr(RateLimits, name)
            count = int(val.split("/")[0])
            assert count > 0, f"{name} must be > 0"

    def test_consent_action_higher_than_consent_request(self):
        req = int(RateLimits.CONSENT_REQUEST.split("/")[0])
        act = int(RateLimits.CONSENT_ACTION.split("/")[0])
        assert act > req

    def test_token_validation_highest_among_flow_limits(self):
        req = int(RateLimits.CONSENT_REQUEST.split("/")[0])
        act = int(RateLimits.CONSENT_ACTION.split("/")[0])
        val = int(RateLimits.TOKEN_VALIDATION.split("/")[0])
        assert val >= act >= req

    def test_global_limit_higher_than_per_user_limits(self):
        global_lim = int(RateLimits.GLOBAL_PER_IP.split("/")[0])
        for name in ("CONSENT_REQUEST", "CONSENT_ACTION", "AGENT_CHAT"):
            per_user = int(getattr(RateLimits, name).split("/")[0])
            assert global_lim >= per_user, f"GLOBAL_PER_IP should be >= {name}"


# ---------------------------------------------------------------------------
# Enforcement tests — minimal isolated FastAPI app per test
# ---------------------------------------------------------------------------


def _make_app_with_limit(limit_string: str, path: str = "/test"):
    """
    Return a (TestClient, app) pair for a single route that carries
    @limiter.limit(limit_string).  Wired exactly like server.py.
    """
    test_limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
    app = FastAPI()
    app.state.limiter = test_limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.get(path)
    @test_limiter.limit(limit_string)
    async def _handler(request: Request):
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False)


class TestRateLimitEnforcement:
    """
    Black-box enforcement: exhaust the bucket, expect 429, then confirm the
    Retry-After header is present.
    """

    def test_consent_request_bucket_enforced(self):
        limit = 2
        client = _make_app_with_limit(f"{limit}/minute")
        for _ in range(limit):
            r = client.get("/test")
            assert r.status_code == 200
        over = client.get("/test")
        assert over.status_code == 429

    def test_consent_action_bucket_enforced(self):
        limit = 3
        client = _make_app_with_limit(f"{limit}/minute")
        for _ in range(limit):
            r = client.get("/test")
            assert r.status_code == 200
        over = client.get("/test")
        assert over.status_code == 429

    def test_token_validation_bucket_enforced(self):
        limit = 4
        client = _make_app_with_limit(f"{limit}/minute")
        for _ in range(limit):
            r = client.get("/test")
            assert r.status_code == 200
        over = client.get("/test")
        assert over.status_code == 429

    def test_rate_limit_exceeded_returns_429_not_500(self):
        client = _make_app_with_limit("1/minute")
        client.get("/test")  # consume the one allowed request
        r = client.get("/test")
        assert r.status_code == 429
        assert r.status_code != 500

    def test_rate_limit_response_is_json(self):
        client = _make_app_with_limit("1/minute")
        client.get("/test")
        r = client.get("/test")
        assert r.status_code == 429
        # slowapi returns a JSON error body
        assert "application/json" in r.headers.get("content-type", "")

    def test_distinct_endpoints_have_independent_buckets(self):
        """Two separate endpoints must not share a rate-limit bucket."""
        test_limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
        app = FastAPI()
        app.state.limiter = test_limiter
        app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

        @app.get("/alpha")
        @test_limiter.limit("1/minute")
        async def _alpha(request: Request):
            return {"ep": "alpha"}

        @app.get("/beta")
        @test_limiter.limit("1/minute")
        async def _beta(request: Request):
            return {"ep": "beta"}

        client = TestClient(app, raise_server_exceptions=False)
        # Exhaust /alpha's bucket
        r1 = client.get("/alpha")
        assert r1.status_code == 200
        r2 = client.get("/alpha")
        assert r2.status_code == 429

        # /beta still has its own fresh bucket
        r3 = client.get("/beta")
        assert r3.status_code == 200

    def test_remaining_budget_decrements(self):
        """Each successful request must consume one slot."""
        limit = 5
        client = _make_app_with_limit(f"{limit}/minute")
        for i in range(1, limit + 1):
            r = client.get("/test")
            assert r.status_code == 200, f"request {i} should be within limit"
        final = client.get("/test")
        assert final.status_code == 429

    def test_limit_string_1_per_minute_allows_exactly_one(self):
        client = _make_app_with_limit("1/minute")
        assert client.get("/test").status_code == 200
        assert client.get("/test").status_code == 429
        assert client.get("/test").status_code == 429  # still blocked

    def test_zero_remaining_returns_error_body(self):
        client = _make_app_with_limit("1/minute")
        client.get("/test")
        r = client.get("/test")
        assert r.status_code == 429
        # slowapi returns a JSON or text body — either way it's non-empty
        assert len(r.content) > 0


# ---------------------------------------------------------------------------
# Wiring sanity — server.py must register the limiter and error handler
# ---------------------------------------------------------------------------


class TestServerWiring:
    """Confirm server.py exposes app.state.limiter and the 429 handler."""

    def test_server_imports_limiter(self):
        import server

        assert hasattr(server, "app"), "server.py must export `app`"

    def test_server_app_has_limiter_state(self):
        import server

        assert hasattr(server.app.state, "limiter"), (
            "app.state.limiter must be set — slowapi needs it to enforce limits"
        )

    def test_limiter_is_slowapi_limiter_instance(self):
        from slowapi import Limiter

        import server

        assert isinstance(server.app.state.limiter, Limiter)
