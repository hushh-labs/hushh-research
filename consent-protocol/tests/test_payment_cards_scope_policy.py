"""Reserved payment_cards domain: sharing policy + reserved-scope indicator.

The domain is owner-managed (NL structuring can never invent it) yet
deliberately shareable: exactly two branch wildcards are externally
requestable, everything else is closed.
"""

import pytest

from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_reserved_domain_scope,
)
from hushh_mcp.consent.scope_helpers import (
    get_scope_display_metadata,
    resolve_scope_to_enum,
)
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.domain_contracts import (
    DOMAIN_SHARING_POLICY_REGISTRY,
    validate_dynamic_top_level_domain,
)


def test_exactly_the_two_branch_wildcards_are_requestable() -> None:
    assert is_external_requestable_pkm_scope("attr.payment_cards.summary.*")
    assert is_external_requestable_pkm_scope("attr.payment_cards.secrets.*")


@pytest.mark.parametrize(
    "scope",
    [
        "attr.payment_cards.*",
        "attr.payment_cards.secrets.pan",
        "attr.payment_cards.summary.last4",
        "attr.payment_cards.secrets",
        "attr.payment_cards.other.*",
    ],
)
def test_domain_wildcard_and_exact_paths_are_refused(scope: str) -> None:
    assert not is_external_requestable_pkm_scope(scope)


def test_public_projection_is_closed() -> None:
    policy = DOMAIN_SHARING_POLICY_REGISTRY["payment_cards"]
    assert policy.allow_public_projection is False
    assert policy.allow_domain_wildcard is False


def test_nl_structuring_cannot_invent_the_domain() -> None:
    with pytest.raises(ValueError, match="owner_managed_domain_slug"):
        validate_dynamic_top_level_domain("payment_cards")


def test_first_party_owner_write_path_is_allowed() -> None:
    assert (
        validate_dynamic_top_level_domain("payment_cards", allow_internal=True) == "payment_cards"
    )


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        ("attr.payment_cards.summary.*", True),
        ("attr.payment_cards.secrets.*", True),
        ("attr.source_library.knowledge.*", True),
        ("attr.financial.portfolio.*", False),
        ("agent.cards.manage", False),
        ("vault.owner", False),
        (None, False),
        ("", False),
    ],
)
def test_reserved_domain_scope_truth_table(scope, expected) -> None:
    assert is_reserved_domain_scope(scope) is expected


def test_agent_cards_scope_resolves_and_displays() -> None:
    assert resolve_scope_to_enum("agent.cards.manage") is ConsentScope.AGENT_CARDS_MANAGE
    meta = get_scope_display_metadata("agent.cards.manage")
    assert meta["label"] == "Cards Management"
    assert meta["reserved"] is False


def test_dynamic_display_metadata_carries_reserved_indicator() -> None:
    assert get_scope_display_metadata("attr.payment_cards.summary.*")["reserved"] is True
    assert get_scope_display_metadata("attr.financial.portfolio.*")["reserved"] is False
