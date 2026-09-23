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


# --- regressions the adversarial review found in the first cut ---------------


def test_a_pipe_in_the_session_id_cannot_forge_the_scope_boundary():
    """The signed payload must be injective.

    Pipe-joining alone let `session_id="|attr.food.*"` with no verbatim scope
    hash to the same bytes as `session_id=""` with `scope_str="attr.food.*"`.
    A link could then be re-presented as the other and take the weaker legacy
    comparison path with an unchanged, valid signature.
    """
    from hushh_mcp.trust.link import _signing_payload

    common = dict(
        from_agent=DELEGATOR,
        to_agent=DELEGATEE,
        scope=ConsentScope.PKM_READ,
        created_at=1,
        expires_at=2,
        signed_by_user=USER_ID,
    )
    carried = _signing_payload(**common, session_id="", scope_str=FOOD)
    smuggled = _signing_payload(**common, session_id=f"|{FOOD}", scope_str="")
    assert carried != smuggled


def test_a_vault_owner_link_still_delegates_only_vault_owner():
    """scope_matches treats vault.owner as a master key.

    Routing a non-dynamic scope through it would turn a vault.owner link into
    a delegation of everything, which is wider than it has ever been.
    """
    link = create_trust_link(
        DELEGATOR,
        DELEGATEE,
        ConsentScope.VAULT_OWNER,
        USER_ID,
        scope_str="vault.owner",
    )
    assert is_trusted_for_scope(link, ConsentScope.VAULT_OWNER) is True
    assert is_trusted_for_scope(link, FINANCIAL) is False
    assert is_trusted_for_scope(link, ConsentScope.PKM_WRITE) is False


def test_a_legacy_dynamic_link_still_authorizes_what_it_recorded():
    """A link minted before this field existed recorded only PKM_READ.

    Comparing the caller's raw string against `link.scope.value` made every
    such link authorize nothing, which is a silent revocation.
    """
    link = create_trust_link(DELEGATOR, DELEGATEE, ConsentScope.PKM_READ, USER_ID)
    assert link.scope_str == ""
    assert is_trusted_for_scope(link, FOOD) is True
    assert is_trusted_for_scope(link, "pkm.read") is True
    assert is_trusted_for_scope(link, ConsentScope.PKM_WRITE) is False
