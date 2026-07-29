"""Regression tests for rate_limit.get_rate_limit_key.

Covers the three resolution paths:
1. Cached user_id from observability middleware state (fast path).
2. Direct JWT decode from Authorization header (slow path, no middleware).
3. IP-address fallback for unauthenticated or invalid requests.
"""

# Governance note:
# These tests are intentionally isolated to the current mainline
# rate-limit contract and do not depend on unresolved predecessor PRs
# or middleware-train ordering assumptions.

from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import Request

_SENTINEL = object()

# Helpers

def _build_request(
    headers: dict[str, str] | None = None,
    state_user_id: str | None | object = _SENTINEL,
) -> Request:
    """Build a minimal Starlette Request with optional headers and state."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/test",
        "query_string": b"",
        "headers": [
            (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
        ],
    }
    request = Request(scope)
    if state_user_id is not _SENTINEL:
        request.state.rate_limit_user_id = state_user_id
    return request


# Path 1: cached state (set by observability middleware)

class TestCachedStatePath:
    def test_returns_user_bucket_from_cached_state(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request(state_user_id="user-abc-123")
        assert get_rate_limit_key(request) == "user:user-abc-123"

    def test_cached_state_takes_priority_over_bearer_token(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request(
            headers={"Authorization": "Bearer some.token.here"},
            state_user_id="cached-user",
        )
        with patch("api.middlewares.rate_limit.validate_token") as mock_validate:
            key = get_rate_limit_key(request)

        assert key == "user:cached-user"
        mock_validate.assert_not_called()


# Path 2: JWT decode from Authorization header (no cached state)

class TestBearerTokenPath:
    def test_returns_user_bucket_from_valid_bearer_token(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        mock_payload = MagicMock()
        mock_payload.user_id = "user-from-token"

        request = _build_request(headers={"Authorization": "Bearer valid.token.here"})

        with patch(
            "api.middlewares.rate_limit.validate_token",
            return_value=(True, None, mock_payload),
        ):
            key = get_rate_limit_key(request)

        assert key == "user:user-from-token"

    def test_falls_back_to_ip_when_token_validation_fails(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request(headers={"Authorization": "Bearer invalid.token"})

        with patch(
            "api.middlewares.rate_limit.validate_token",
            return_value=(False, "bad_signature", None),
        ), patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="10.0.0.1",
        ):
            key = get_rate_limit_key(request)

        assert key == "10.0.0.1"

    def test_falls_back_to_ip_when_valid_token_has_no_user_id(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        mock_payload = MagicMock()
        mock_payload.user_id = None

        request = _build_request(
            headers={"Authorization": "Bearer valid.but.no.userid"}
        )

        with patch(
            "api.middlewares.rate_limit.validate_token",
            return_value=(True, None, mock_payload),
        ), patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="10.1.2.3",
        ):
            key = get_rate_limit_key(request)

        assert key == "10.1.2.3"

    def test_falls_back_to_ip_when_bearer_token_value_is_empty(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request(headers={"Authorization": "Bearer "})

        with patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="127.0.0.1",
        ):
            key = get_rate_limit_key(request)

        assert key == "127.0.0.1"

# Path 3: IP-address fallback

class TestIpFallbackPath:
    def test_falls_back_to_ip_when_no_authorization_header(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request()

        with patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="192.168.1.42",
        ):
            key = get_rate_limit_key(request)

        assert key == "192.168.1.42"

    def test_falls_back_to_ip_when_authorization_scheme_is_not_bearer(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        request = _build_request(
            headers={"Authorization": "Basic dXNlcjpwYXNz"}
        )

        with patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="127.0.0.1",
        ):
            key = get_rate_limit_key(request)

        assert key == "127.0.0.1"

    def test_falls_back_to_ip_when_state_user_id_is_none(self) -> None:
        from api.middlewares.rate_limit import get_rate_limit_key

        # State attribute explicitly set to None (observability ran, but no JWT)
        request = _build_request(state_user_id=None)

        with patch(
            "api.middlewares.rate_limit.get_remote_address",
            return_value="172.16.0.5",
        ):
            key = get_rate_limit_key(request)

        assert key == "172.16.0.5"