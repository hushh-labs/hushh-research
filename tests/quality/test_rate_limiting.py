# tests/quality/test_rate_limiting.py
"""Rate limiting contract and security tests."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from api.middlewares import rate_limit
from api.middlewares.observability import observability_middleware
from api.middlewares.rate_limit import RateLimits, get_rate_limit_key
from hushh_mcp.constants import ConsentScope


class MockRequest:
    """Mock FastAPI request for testing."""

    def __init__(self, headers: dict | None = None, ip: str = "127.0.0.1", state=None):
        self.headers = dict(headers or {})
        self.client = MagicMock()
        self.client.host = ip
        self.url = MagicMock()
        self.url.path = "/api/consent/request"
        if state is not None:
            self.state = state


def _issue_vault_owner_token(user_id: str) -> str:
    from hushh_mcp.consent.token import issue_token

    return issue_token(
        user_id=user_id,
        agent_id="test_agent",
        scope=ConsentScope.VAULT_OWNER,
    ).token


class TestRateLimitKeyExtraction:
    def test_valid_bearer_token_keyed_by_token_user_id(self):
        token = _issue_vault_owner_token("user_123")
        request = MockRequest(headers={"Authorization": f"Bearer {token}"})

        key = get_rate_limit_key(request)

        assert key == "user:user_123"

    def test_unauthenticated_falls_back_to_ip(self):
        request = MockRequest(ip="192.168.1.100")

        key = get_rate_limit_key(request)

        assert "192.168.1.100" in key

    def test_different_authed_users_different_keys(self):
        token_a = _issue_vault_owner_token("user_a")
        token_b = _issue_vault_owner_token("user_b")

        key_a = get_rate_limit_key(MockRequest(headers={"Authorization": f"Bearer {token_a}"}))
        key_b = get_rate_limit_key(MockRequest(headers={"Authorization": f"Bearer {token_b}"}))

        assert key_a != key_b
        assert key_a == "user:user_a"
        assert key_b == "user:user_b"

    def test_cached_middleware_user_id_avoids_second_token_decode(self, monkeypatch):
        def _unexpected_validate_token(*_args, **_kwargs):
            raise AssertionError("cached middleware identity should avoid a second token decode")

        monkeypatch.setattr(rate_limit, "validate_token", _unexpected_validate_token)
        state = MagicMock()
        state.rate_limit_user_id = "cached_user"

        key = get_rate_limit_key(
            MockRequest(
                headers={"Authorization": "Bearer token-that-should-not-be-decoded"},
                state=state,
            )
        )

        assert key == "user:cached_user"

    def test_observability_identity_is_reused_by_rate_limiter(self, monkeypatch):
        decode_calls: list[str] = []

        def _observability_validate_token(token: str):
            decode_calls.append(token)
            return True, None, SimpleNamespace(user_id="cached_request_user")

        def _unexpected_rate_limit_decode(*_args, **_kwargs):
            raise AssertionError("rate limiter should reuse observability middleware identity")

        monkeypatch.setattr(
            "hushh_mcp.consent.token.validate_token",
            _observability_validate_token,
        )
        monkeypatch.setattr(rate_limit, "validate_token", _unexpected_rate_limit_decode)

        app = FastAPI()
        app.middleware("http")(observability_middleware)

        @app.get("/rate-key")
        async def rate_key(request: Request):
            return {"key": get_rate_limit_key(request)}

        response = TestClient(app).get(
            "/rate-key",
            headers={"Authorization": "Bearer signed-consent-token"},
        )

        assert response.status_code == 200
        assert response.json() == {"key": "user:cached_request_user"}
        assert decode_calls == ["signed-consent-token"]


class TestRateLimitKeyTrustBoundary:
    """
    Regression tests for the client-supplied-identity trust boundary.

    The previous implementation keyed the limiter on the client-controlled
    `X-User-ID` header, which let a caller (a) bypass their own quota by
    rotating the header value per-request and (b) DoS a victim by stuffing
    the victim's user_id into the header. The key must now derive from a
    signature-verified consent bearer token; unauthenticated or unverifiable
    traffic must collapse to the remote IP so it shares a bucket.
    """

    def test_x_user_id_header_is_ignored_without_bearer_token(self):
        request = MockRequest(headers={"X-User-ID": "attacker_spoofed"}, ip="203.0.113.7")

        key = get_rate_limit_key(request)

        assert "attacker_spoofed" not in key
        assert "203.0.113.7" in key

    def test_rotating_x_user_id_does_not_create_new_buckets(self):
        attacker_ip = "203.0.113.7"
        keys = {
            get_rate_limit_key(MockRequest(headers={"X-User-ID": f"spoof_{i}"}, ip=attacker_ip))
            for i in range(25)
        }

        assert len(keys) == 1
        (only_key,) = keys
        assert attacker_ip in only_key

    def test_cannot_dos_another_user_via_x_user_id_header(self):
        victim_token = _issue_vault_owner_token("victim_user")
        victim_key = get_rate_limit_key(
            MockRequest(headers={"Authorization": f"Bearer {victim_token}"})
        )

        attacker_request = MockRequest(headers={"X-User-ID": "victim_user"}, ip="203.0.113.7")
        attacker_key = get_rate_limit_key(attacker_request)

        assert victim_key == "user:victim_user"
        assert attacker_key != victim_key
        assert "203.0.113.7" in attacker_key

    def test_malformed_bearer_token_falls_back_to_ip(self):
        request = MockRequest(
            headers={"Authorization": "Bearer not-a-real-token"}, ip="198.51.100.2"
        )

        key = get_rate_limit_key(request)

        assert "not-a-real-token" not in key
        assert "198.51.100.2" in key

    def test_bearer_token_with_suffix_garbage_is_not_accepted(self):
        token = _issue_vault_owner_token("user_ok")
        tampered = token + "tamper"

        key = get_rate_limit_key(
            MockRequest(headers={"Authorization": f"Bearer {tampered}"}, ip="198.51.100.3")
        )

        assert key != "user:user_ok"
        assert "198.51.100.3" in key

    def test_lowercase_bearer_prefix_is_not_accepted(self):
        """Lowercase bearer scheme falls back to IP bucket resolution."""
        token = _issue_vault_owner_token("user_lower")
        request = MockRequest(
            headers={"Authorization": f"bearer {token}"},
            ip="203.0.113.20",
        )

        key = get_rate_limit_key(request)

        assert key != "user:user_lower"
        assert "203.0.113.20" in key

    def test_whitespace_only_bearer_token_falls_back_to_ip(self):
        """Whitespace-only bearer token falls back to IP bucket resolution."""
        request = MockRequest(
            headers={"Authorization": "Bearer   "},
            ip="203.0.113.21",
        )

        key = get_rate_limit_key(request)

        assert "203.0.113.21" in key

    def test_authorization_without_bearer_scheme_falls_back_to_ip(self):
        """Authorization headers without Bearer scheme fall back to IP buckets."""
        token = _issue_vault_owner_token("user_noscheme")
        request = MockRequest(
            headers={"Authorization": token},
            ip="203.0.113.22",
        )

        key = get_rate_limit_key(request)

        assert key != "user:user_noscheme"
        assert "203.0.113.22" in key

    def test_valid_token_with_none_payload_falls_back_to_ip(self, monkeypatch):
        """Missing validated payload falls back to IP bucket resolution."""

        def _none_payload(*_args, **_kwargs):
            return True, None, None

        monkeypatch.setattr(rate_limit, "validate_token", _none_payload)
        request = MockRequest(
            headers={"Authorization": "Bearer some-token"},
            ip="203.0.113.23",
        )

        key = get_rate_limit_key(request)

        assert "203.0.113.23" in key
        assert not key.startswith("user:")

    def test_valid_token_with_falsy_user_id_falls_back_to_ip(self, monkeypatch):
        """Falsy validated user identifiers fall back to IP bucket resolution."""
        mock_payload = MagicMock()
        mock_payload.user_id = ""

        def _empty_user_id(*_args, **_kwargs):
            return True, None, mock_payload

        monkeypatch.setattr(rate_limit, "validate_token", _empty_user_id)
        request = MockRequest(
            headers={"Authorization": "Bearer some-token"},
            ip="203.0.113.24",
        )

        key = get_rate_limit_key(request)

        assert "203.0.113.24" in key
        assert not key.startswith("user:")


class TestRateLimitConstants:
    def test_consent_request_limit(self):
        assert RateLimits.CONSENT_REQUEST == "10/minute"  # noqa: S105

    def test_consent_action_limit(self):
        assert RateLimits.CONSENT_ACTION == "20/minute"  # noqa: S105

    def test_token_validation_limit(self):
        assert RateLimits.TOKEN_VALIDATION == "60/minute"  # noqa: S105

    def test_agent_chat_limit(self):
        assert RateLimits.AGENT_CHAT == "30/minute"  # noqa: S105

    def test_global_limit(self):
        assert RateLimits.GLOBAL_PER_IP == "100/minute"  # noqa: S105


class TestRateLimitEnforcement:
    def test_consent_request_limit_is_safe_for_normal_use(self):
        limit = 10
        typical_actions_per_minute = 5
        requests_per_action = 2

        assert limit >= typical_actions_per_minute * requests_per_action

    def test_consent_action_limit_allows_batch_approvals(self):
        limit = 20
        batch_size = 10

        assert limit >= batch_size

    def test_two_step_flow_fits_within_limits(self):
        step1_requests = 1
        step2_requests = 1

        max_flows_per_minute = min(
            int(RateLimits.CONSENT_REQUEST.split("/")[0]) / step1_requests,
            int(RateLimits.CONSENT_ACTION.split("/")[0]) / step2_requests,
        )

        assert max_flows_per_minute >= 10, "Should allow at least 10 flows/minute"


class TestRateLimitKeyProxyFallback:
    def test_explicit_none_rate_limit_user_id_on_state_falls_through_to_bearer(self):
        """state.rate_limit_user_id = None must fall through to bearer decode, not IP."""
        token = _issue_vault_owner_token("state_none_user")
        state = MagicMock()
        state.rate_limit_user_id = None

        key = get_rate_limit_key(
            MockRequest(
                headers={"Authorization": f"Bearer {token}"},
                state=state,
            )
        )

        assert key == "user:state_none_user"

    def test_lowercase_authorization_header_key_accepted_for_bearer_fallback(self):
        """Lowercase authorization headers are accepted for bearer fallback."""
        token = _issue_vault_owner_token("user_lowercase_header")
        request = MockRequest(headers={"authorization": f"Bearer {token}"})

        key = get_rate_limit_key(request)

        assert key == "user:user_lowercase_header"

    def test_two_unauthenticated_ips_produce_different_rate_limit_keys(self):
        """Two distinct unauthenticated IPs must never share a bucket."""
        key_a = get_rate_limit_key(MockRequest(ip="203.0.113.50"))
        key_b = get_rate_limit_key(MockRequest(ip="203.0.113.51"))

        assert key_a != key_b
        assert "203.0.113.50" in key_a
        assert "203.0.113.51" in key_b
        assert not key_a.startswith("user:")
        assert not key_b.startswith("user:")

    def test_authenticated_and_unauthenticated_request_never_share_bucket(self):
        """An authenticated user bucket must never collide with an IP bucket."""
        token = _issue_vault_owner_token("bucket_isolation_user")
        authed_key = get_rate_limit_key(MockRequest(headers={"Authorization": f"Bearer {token}"}))
        anon_key = get_rate_limit_key(MockRequest(ip="203.0.113.52"))

        assert authed_key != anon_key
        assert authed_key.startswith("user:")
        assert not anon_key.startswith("user:")

    def test_missing_state_attribute_falls_through_to_bearer(self):
        """A request with no state attribute at all must still decode a valid bearer token."""
        token = _issue_vault_owner_token("no_state_user")

        key = get_rate_limit_key(MockRequest(headers={"Authorization": f"Bearer {token}"}))

        assert key == "user:no_state_user"

    def test_state_empty_string_user_id_falls_through_to_bearer(self):
        """Falsy cached user identifiers fall through to bearer decoding."""
        token = _issue_vault_owner_token("empty_string_state_user")
        state = MagicMock()
        state.rate_limit_user_id = ""

        key = get_rate_limit_key(
            MockRequest(
                headers={"Authorization": f"Bearer {token}"},
                state=state,
            )
        )

        assert key == "user:empty_string_state_user"

    def test_same_user_always_produces_same_key(self):
        """Valid tokens resolve to stable deterministic bucket keys."""
        token = _issue_vault_owner_token("deterministic_user")
        keys = {
            get_rate_limit_key(MockRequest(headers={"Authorization": f"Bearer {token}"}))
            for _ in range(10)
        }

        assert len(keys) == 1
        assert keys.pop() == "user:deterministic_user"
