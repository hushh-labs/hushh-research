"""A TrustLink must delegate the scope the owner actually chose.

Dynamic `attr.*` scopes all collapse to the same `ConsentScope.PKM_READ`
enum, so a link that stores only the enum cannot tell `attr.food.recipes.*`
from `attr.financial.*`. Verifying such a link against a sibling domain then
succeeds, and a narrow delegation silently becomes all-PKM access.
"""

from __future__ import annotations

from hushh_mcp.constants import ConsentScope
from hushh_mcp.trust.link import create_trust_link, is_trusted_for_scope, verify_trust_link

USER_ID = "user_nyx"
DELEGATOR = "agent_identity"
DELEGATEE = "agent_shopper"

FOOD = "attr.food.recipes.*"
FINANCIAL = "attr.financial.holdings.*"


def _link(scope_str: str):
    return create_trust_link(
        DELEGATOR,
        DELEGATEE,
        ConsentScope.PKM_READ,
        USER_ID,
        scope_str=scope_str,
    )


def test_link_keeps_the_verbatim_scope_the_owner_chose():
    link = _link(FOOD)
    assert link.scope_str == FOOD
    assert verify_trust_link(link) is True


def test_narrow_delegation_does_not_authorize_a_sibling_domain():
    link = _link(FOOD)
    assert is_trusted_for_scope(link, FOOD) is True
    # The bug: both sides resolve to PKM_READ, so this used to return True.
    assert is_trusted_for_scope(link, FINANCIAL) is False


def test_wildcard_still_covers_its_own_branch():
    link = _link("attr.food.*")
    assert is_trusted_for_scope(link, "attr.food.recipes") is True
    assert is_trusted_for_scope(link, "attr.financial.holdings") is False


def test_verbatim_scope_is_signed_and_cannot_be_swapped():
    link = _link(FOOD)
    widened = link.model_copy(update={"scope_str": FINANCIAL})
    # The signature covers the verbatim scope, so retargeting the link fails.
    assert verify_trust_link(widened) is False


def test_legacy_links_without_a_verbatim_scope_still_verify():
    """A link minted before this field existed keeps its old signed form."""
    link = create_trust_link(DELEGATOR, DELEGATEE, ConsentScope.PKM_READ, USER_ID)
    assert link.scope_str == ""
    assert verify_trust_link(link) is True
    assert is_trusted_for_scope(link, ConsentScope.PKM_READ) is True
