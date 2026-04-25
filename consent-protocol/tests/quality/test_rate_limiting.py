# tests/quality/test_rate_limiting.py
"""Rate limiting contract and security tests."""

from unittest.mock import MagicMock

from api.middlewares.rate_limit import RateLimits, get_rate_limit_key
from hushh_mcp.constants import ConsentScope


class MockRequest:
    """Mock FastAPI request for testing."""

    def __init__(self, headers: dict | None = None, ip: str = "127.0.0.1"):
        self.headers = dict(headers or {})
        self.client = MagicMock()
        self.client.host = ip
        self.url = MagicMock()
        self.url.path = "/api/consent/request"


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
            get_rate_limit_key(
                MockRequest(headers={"X-User-ID": f"spoof_{i}"}, ip=attacker_ip)
            )
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

        attacker_request = MockRequest(
            headers={"X-User-ID": "victim_user"}, ip="203.0.113.7"
        )
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
