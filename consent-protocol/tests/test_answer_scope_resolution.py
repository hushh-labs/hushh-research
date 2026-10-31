"""Scope isolation and payment binding for paid answers.

These guard two boundaries: what a resolver agent is allowed to put in front of
an owner, and what one payment authorizes.
"""

from hushh_mcp.consent.answer_scope_resolution import (
    DROP_NOT_IN_CATALOG,
    DROP_NOT_REQUESTABLE,
    compute_terms_digest,
    validate_resolved_scopes,
)

CATALOG = ["attr.travel.trips", "attr.personal_data.home_city", "attr.preferences.food"]


def _resolve(proposed, catalog=CATALOG):
    return validate_resolved_scopes(proposed, owner_catalog=catalog)


def test_accepted_is_always_a_subset_of_what_the_agent_proposed():
    # The guard may remove; it may never decide a scope the agent did not pick.
    result = _resolve(["attr.travel.trips"])
    assert set(result.accepted) <= {"attr.travel.trips"}
    assert result.accepted == ("attr.travel.trips",)


def test_drops_scopes_another_person_may_never_request():
    # runtime_secrets is deny-listed in requestable_scope_policy; a resolver
    # naming it must not reach the owner's approval screen at all.
    result = _resolve(["attr.runtime_secrets.llm", "attr.travel.trips"])
    assert result.accepted == ("attr.travel.trips",)
    assert ("attr.runtime_secrets.llm", DROP_NOT_REQUESTABLE) in result.dropped


def test_drops_scopes_the_owner_does_not_have():
    # A resolver cannot invent a scope: the per-owner registry is the authority.
    result = _resolve(["attr.financial.holdings", "attr.preferences.food"])
    assert result.accepted == ("attr.preferences.food",)
    assert ("attr.financial.holdings", DROP_NOT_IN_CATALOG) in result.dropped


def test_empty_catalog_yields_nothing_rather_than_everything():
    # Negative control for fail-closed: a missing catalog must not be permissive.
    result = _resolve(["attr.travel.trips", "attr.preferences.food"], catalog=[])
    assert result.accepted == ()
    assert result.is_empty is True
    assert {reason for _scope, reason in result.dropped} == {DROP_NOT_IN_CATALOG}


def test_malformed_and_duplicate_input_cannot_slip_through():
    result = _resolve(["", "not-a-scope", "pkm.read", "ATTR.TRAVEL.TRIPS", "attr.travel.trips"])
    assert result.accepted == ("attr.travel.trips",)  # case-folded, de-duplicated
    assert any(scope == "not-a-scope" for scope, _reason in result.dropped)
    assert any(scope == "pkm.read" for scope, _reason in result.dropped)


def test_scope_limit_is_enforced_and_recorded():
    many = [f"attr.d{i}.x" for i in range(20)]
    result = validate_resolved_scopes(many, owner_catalog=many, max_scopes=3)
    assert len(result.accepted) == 3
    assert len(result.dropped) == 17


class TestTermsDigest:
    """One payment authorizes one question, scope set, pair and price."""

    base = dict(
        question="What does your travel history say about Japan?",
        scopes=["attr.travel.trips"],
        owner_user_id="owner-1",
        requester_user_id="requester-1",
        amount_cents=1000,
    )

    def test_is_stable_across_scope_order_and_whitespace(self):
        a = compute_terms_digest(**self.base)
        b = compute_terms_digest(
            **{**self.base, "question": "  What does your travel history   say about Japan? "}
        )
        c = compute_terms_digest(
            **{**self.base, "scopes": ["attr.travel.trips", "attr.travel.trips"]}
        )
        assert a == b == c

    def test_changes_when_any_bound_term_changes(self):
        base = compute_terms_digest(**self.base)
        # Each of these must invalidate a payment made against `base`.
        assert compute_terms_digest(**{**self.base, "amount_cents": 2000}) != base
        assert compute_terms_digest(**{**self.base, "question": "Something else entirely?"}) != base
        assert compute_terms_digest(**{**self.base, "requester_user_id": "requester-2"}) != base
        assert compute_terms_digest(**{**self.base, "owner_user_id": "owner-2"}) != base
        # Widening the scopes after approval is the attack this exists to stop.
        widened = {**self.base, "scopes": ["attr.travel.trips", "attr.preferences.food"]}
        assert compute_terms_digest(**widened) != base
