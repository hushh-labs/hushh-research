"""Contact discovery: the guards that were missing entirely.

`POST /api/marketplace/contacts/match` answers "is the person behind this phone
number on Hushh", a thousand numbers at a time. It shipped with no rate limit of
its own and no global one to fall back on -- `SlowAPIMiddleware` is never
installed and `RateLimits.GLOBAL_PER_IP` is referenced nowhere outside its own
test -- so an authenticated caller could walk the national number space against
the user base at whatever rate their connection allowed. It also echoed four
digits of each matched person's number back.

Neither of those had a single test. These are those tests.
"""

from __future__ import annotations

import inspect

import pytest

from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.marketplace import (
    MarketplaceContactLookup,
    MarketplaceContactMatchRequest,
)
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.ria_iam_service import RIAIAMService

_ROUTE_KEY = "api.routes.marketplace.match_marketplace_contacts"


def _registered_limits() -> list[str]:
    """The limit strings slowapi actually holds for the match route."""
    route_limits = getattr(limiter, "_route_limits", {})
    assert _ROUTE_KEY in route_limits, (
        "the contact match route carries no rate limit at all -- this is the "
        "enumeration oracle, not a style preference"
    )
    return [str(entry.limit) for entry in route_limits[_ROUTE_KEY]]


class TestContactMatchIsRateLimited:
    def test_the_route_is_bounded_per_minute_and_per_day(self):
        """One ceiling cannot describe the shape of this abuse.

        A per-minute bound stops a tight loop. It does nothing about the
        patient walk -- a few requests a minute, all day -- which is the
        realistic way somebody enumerates a user base through a discovery
        endpoint. Both bounds have to be present.
        """
        limits = _registered_limits()

        assert any("minute" in limit for limit in limits), limits
        assert any("day" in limit for limit in limits), limits

    def test_the_bounds_leave_room_for_the_loop_the_ui_offers(self):
        """The minute bound must not refuse a person doing what we told them to.

        On the web the Contact Picker returns only hand-picked entries, so
        `describeContactSyncOutcome` offers a "Check more" action that re-runs
        the whole sync — the product actively asks a user to press this
        repeatedly to cover a large address book. At four a minute the fifth
        press failed, and the refusal came from a limit meant for an attacker.
        """

        limits = _registered_limits()
        per_minute = int(next(limit for limit in limits if "minute" in limit).split()[0])

        # A press every five seconds is faster than a human works the picker.
        assert per_minute >= 12, per_minute

    def test_the_day_bound_is_the_one_that_stops_a_walk(self):
        # Nothing is lost by a generous minute bound: the day bound is the
        # security bound. It has to stay far below what enumerating a number
        # space needs, and far above what a real address book does across
        # every surface and device.
        limits = _registered_limits()
        per_day = int(next(limit for limit in limits if "day" in limit).split()[0])

        assert per_day <= 100, per_day
        assert per_day >= 40, per_day

    def test_the_limit_is_keyed_per_user_rather_than_per_address(self):
        # The route requires a Firebase identity, so an IP bucket would be the
        # wrong one -- a caller sheds it by changing address, and a whole
        # office behind one NAT would share a budget they never spent.
        source = inspect.getsource(limiter.__class__.__init__)
        assert "key_func" in source
        from api.middlewares.rate_limit import get_rate_limit_key

        assert limiter._key_func is get_rate_limit_key


class TestTheRefusalIsReadableByAPerson:
    """A 429 on this route reaches a human, not a machine.

    slowapi's default body is `{"error": "Rate limit exceeded: 12 per 1 minute"}`,
    and the web client puts whatever string it finds straight into a toast. That
    is a fine answer for a developer holding an API key and a poor one for
    somebody who just pressed "Check more" on their contacts.
    """

    def _client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from slowapi.errors import RateLimitExceeded

        from api.middleware import require_firebase_auth
        from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
        from api.routes import marketplace

        app = FastAPI()
        app.include_router(marketplace.router)
        app.state.limiter = limiter
        app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
        app.dependency_overrides[require_firebase_auth] = lambda: "user_test_429"
        return TestClient(app, raise_server_exceptions=False)

    def test_the_body_says_something_a_person_can_act_on(self, monkeypatch):
        # Force the limiter on: the pytest harness disables it so route tests
        # are not throttled by shared buckets, which also means nothing else
        # ever exercises this path.
        from api.middlewares.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", True)
        limiter.reset()

        client = self._client()
        payload = {"phone_lookups": [], "limit": 10, "scope": "one_network"}

        statuses = [
            client.post("/api/marketplace/contacts/match", json=payload).status_code
            for _ in range(14)
        ]
        assert 429 in statuses, statuses

        refused = client.post("/api/marketplace/contacts/match", json=payload)
        assert refused.status_code == 429
        body = refused.json()

        message = body.get("detail", {}).get("message", "")
        assert "contacts" in message.lower(), body
        # The limit's own numbers are an implementation detail, and reading
        # "12 per 1 minute" in a toast is how a person learns we have no copy
        # for this state.
        assert "per 1 minute" not in message, body
        assert body.get("detail", {}).get("code") == "RATE_LIMITED", body
        # The marketplace client reads `error`, not `detail.message`. Both
        # carry the same sentence so neither surface falls back to the raw one.
        assert body.get("error") == message, body

    def test_other_routes_keep_slowapis_own_answer(self, monkeypatch):
        # The typed body is opt-in per path. Widening it silently would change
        # the shape every other rate-limited route returns.
        from api.middlewares.rate_limit import _TYPED_RATE_LIMIT_PATHS

        assert "/api/marketplace/contacts/match" in _TYPED_RATE_LIMIT_PATHS
        assert not any(path.startswith("/api/one/location") for path in _TYPED_RATE_LIMIT_PATHS)


class TestContactMatchLeaksNoPhoneDigits:
    def test_the_match_payload_carries_no_phone_digits(self):
        """Not even four of them.

        The caller derived every digest it sent from its own address book, so
        it already holds the number behind each match -- echoing part of it
        back tells the caller nothing it did not have, and costs a real leak
        the moment a response is logged, cached, or rendered into a page. Both
        were happening: the marketplace deck rendered these digits into the
        DOM while One Location stripped them on arrival.
        """
        source = inspect.getsource(RIAIAMService.match_marketplace_contacts)

        # `last4` still appears as a local -- it is the index bucket the SQL
        # pre-filter needs. What must not appear is a response key carrying it.
        assert '"phone_last4"' not in source
        assert "'phone_last4'" not in source

    def test_last4_is_still_used_as_the_bucket_key(self):
        # The digest decides a match; `last4` only narrows the candidate rows
        # so the query is index-friendly. Removing the response field must not
        # have removed the pre-filter with it.
        source = inspect.getsource(RIAIAMService.match_marketplace_contacts)
        assert "normalized_lookups" in source
        assert "last4" in source


class TestContactDiscoveryHasAName:
    def test_the_capability_is_declared(self):
        # Until this existed, the single most identity-revealing query in the
        # product was the only one with no scope attached to it -- nothing the
        # consent surface could show, nothing an audit row could carry.
        assert ConsentScope.CAP_CONTACT_DISCOVERY.value == "cap.contact.discovery"
        assert "cap.contact.discovery" in ConsentScope.list()


class TestContactMatchRequestBounds:
    """The payload bounds that were the only guard this route had."""

    def test_a_digest_must_be_a_digest(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            MarketplaceContactLookup(hash="not-a-sha256", last4="1234")

    def test_scope_is_closed(self):
        from pydantic import ValidationError

        assert MarketplaceContactMatchRequest().scope == "marketplace"
        assert MarketplaceContactMatchRequest(scope="one_network").scope == "one_network"
        with pytest.raises(ValidationError):
            MarketplaceContactMatchRequest(scope="everything")

    def test_the_constants_exist_under_their_documented_names(self):
        assert RateLimits.CONTACT_DISCOVERY_MATCH
        assert RateLimits.CONTACT_DISCOVERY_MATCH_DAILY
