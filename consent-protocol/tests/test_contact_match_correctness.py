"""Contact matching: the two ways a real person went unfound.

Both bugs sit in `RIAIAMService.match_marketplace_contacts`, both are silent,
and neither had a test. The caller gets an ordinary empty list — indistinguishable
from "none of your contacts are here" — so nothing on any screen could tell the
difference between an honest answer and a broken one.
"""

from __future__ import annotations

import inspect
import logging

from hushh_mcp.services.ria_iam_service import RIAIAMService


class TestTheNormalizerDoesNotInventACountry:
    """A stored number is read as E.164, never guessed into one.

    This used to read a bare ten-digit number as North American --
    `if len(digits) == 10: return f"+1{digits}"` -- the same bug the client-side
    normalizer removed and documented at
    `lib/contacts/phone-normalization.ts:11-15`.

    It is worse on this side. On the client a wrong guess only produced a digest
    that missed. Here it fabricates an identity: a stored `9876543210` on an
    Indian account hashed as `+19876543210`, so a requester holding the real US
    number `+19876543210` was told that stranger is on Hussh. A guess that can
    disclose somebody's membership to a person who does not know them is not a
    fallback.
    """

    def test_a_bare_ten_digit_number_is_not_assumed_american(self):
        normalize = RIAIAMService._normalize_contact_phone_for_hash
        assert normalize("9876543210") == "+9876543210"
        assert normalize("9876543210") != "+19876543210"

    def test_an_e164_number_is_left_exactly_as_it_is(self):
        normalize = RIAIAMService._normalize_contact_phone_for_hash
        assert normalize("+919876543210") == "+919876543210"
        assert normalize("+91 98765-43210") == "+919876543210"
        assert normalize("+1 650 555 1234") == "+16505551234"

    def test_nothing_at_all_is_not_a_number(self):
        normalize = RIAIAMService._normalize_contact_phone_for_hash
        assert normalize("") is None
        assert normalize("   ") is None
        assert normalize(None) is None

    def test_the_client_and_the_server_agree_on_the_same_string(self):
        # The two normalizers must produce byte-identical E.164 or the digests
        # never meet. The client emits strict E.164 through libphonenumber; the
        # server's only job is to reproduce what is already stored in that shape.
        normalize = RIAIAMService._normalize_contact_phone_for_hash
        for stored in ("+919876543210", "+16505551234", "+447911123456"):
            assert normalize(stored) == stored

    def test_the_guess_is_gone_from_the_code_and_not_only_from_the_behaviour(self):
        # Compared against the executable body with the docstring removed --
        # that docstring quotes the deleted branch on purpose, so a naive
        # substring search over the whole source matches the explanation
        # instead of the code.
        import ast
        import textwrap

        tree = ast.parse(
            textwrap.dedent(inspect.getsource(RIAIAMService._normalize_contact_phone_for_hash))
        )
        function = tree.body[0]
        assert isinstance(function, ast.FunctionDef)
        body = function.body
        if ast.get_docstring(function) is not None:
            body = body[1:]
        code = "".join(ast.unparse(node) for node in body)

        assert "len(digits) == 10" not in code
        assert "+1" not in code

    def test_a_missing_plus_is_reported_rather_than_guessed_at(self, caplog):
        # The counter is how we learn whether such a row exists in production,
        # instead of reading the writers and hoping. It must never carry the
        # number itself.
        normalize = RIAIAMService._normalize_contact_phone_for_hash
        with caplog.at_level(logging.WARNING):
            normalize("919876543210")

        assert "stored_phone_missing_plus" in caplog.text
        assert "919876543210" not in caplog.text


class TestEveryoneStaysReachable:
    """The candidate cap must not decide who is findable.

    Rows come back `ORDER BY aic.user_id ASC` -- an ordering the query's own
    comment calls arbitrary -- and anything past the cap is never
    digest-compared. A last4 bucket holds roughly one ten-thousandth of the user
    base, so a full address book of 1000 buckets expects `users / 10`
    candidates, which crosses the old flat 5000 at only fifty thousand accounts.
    Past that, a person whose Firebase uid sorts late was dropped from every
    large lookup, deterministically and permanently.
    """

    @staticmethod
    def _cap_for(bucket_count: int) -> int:
        # Mirrors the expression under test. Written out rather than imported so
        # a change to the formula has to be made deliberately in both places.
        return min(max(bucket_count * 50, 500), 50_000)

    def test_the_cap_scales_with_the_buckets_actually_asked_for(self):
        source = inspect.getsource(RIAIAMService.match_marketplace_contacts)
        assert "len(last4_values) * 50" in source
        # The old formula keyed off the RESULT limit, which has nothing to do
        # with how many rows have to be examined to produce it.
        assert "limit_safe * 50" not in source

    def test_a_full_address_book_clears_a_hundred_thousand_accounts(self):
        # 1000 buckets against 100k users expects ~10k candidates. The old cap
        # was 5000 -- it truncated half of them.
        assert self._cap_for(1000) >= 10_000
        assert self._cap_for(1000) > 5000

    def test_a_small_lookup_still_gets_a_floor(self):
        # A handful of contacts must not end up with a cap so tight that one
        # last4 collision crowds out the real row.
        assert self._cap_for(1) == 500
        assert self._cap_for(5) == 500

    def test_the_bound_is_still_a_bound(self):
        # `phone_lookups` is capped at 1000 by the route, so the worst request
        # anyone can shape stays inside a size Postgres and the Python digest
        # loop can both carry.
        assert self._cap_for(1000) <= 50_000
        assert self._cap_for(10_000) == 50_000

    def test_the_digest_comparison_still_decides_the_match(self):
        # The bucket is an index-friendly pre-filter and nothing more. If this
        # ever became the thing that decided a match, every last4 collision
        # would be a false positive about a stranger's membership.
        source = inspect.getsource(RIAIAMService.match_marketplace_contacts)
        assert "normalized_lookups" in source
        assert "hashlib.sha256" in source
