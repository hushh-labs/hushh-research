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

    def test_the_bounds_are_small_enough_to_matter(self):
        # Syncing an address book is a deliberate act, not a loop. A person
        # does it once, and occasionally again after adding someone. If these
        # numbers ever drift up to where a scripted walk is comfortable, the
        # limit has stopped being a limit.
        limits = _registered_limits()
        per_minute = next(limit for limit in limits if "minute" in limit)
        per_day = next(limit for limit in limits if "day" in limit)

        assert int(per_minute.split()[0]) <= 10, per_minute
        assert int(per_day.split()[0]) <= 50, per_day

    def test_the_limit_is_keyed_per_user_rather_than_per_address(self):
        # The route requires a Firebase identity, so an IP bucket would be the
        # wrong one -- a caller sheds it by changing address, and a whole
        # office behind one NAT would share a budget they never spent.
        source = inspect.getsource(limiter.__class__.__init__)
        assert "key_func" in source
        from api.middlewares.rate_limit import get_rate_limit_key

        assert limiter._key_func is get_rate_limit_key


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
