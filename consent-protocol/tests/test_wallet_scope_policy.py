"""Reserved wallet domain: sharing policy + reserved-scope indicator.

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
    assert is_external_requestable_pkm_scope("attr.wallet.summary.*")
    assert is_external_requestable_pkm_scope("attr.wallet.secrets.*")


@pytest.mark.parametrize(
    "scope",
    [
        "attr.wallet.*",
        "attr.wallet.secrets.pan",
        "attr.wallet.summary.last4",
        "attr.wallet.secrets",
        "attr.wallet.other.*",
    ],
)
def test_domain_wildcard_and_exact_paths_are_refused(scope: str) -> None:
    assert not is_external_requestable_pkm_scope(scope)


def test_public_projection_is_closed() -> None:
    policy = DOMAIN_SHARING_POLICY_REGISTRY["wallet"]
    assert policy.allow_public_projection is False
    assert policy.allow_domain_wildcard is False


def test_nl_structuring_cannot_invent_the_domain() -> None:
    with pytest.raises(ValueError, match="owner_managed_domain_slug"):
        validate_dynamic_top_level_domain("wallet")


def test_first_party_owner_write_path_is_allowed() -> None:
    assert validate_dynamic_top_level_domain("wallet", allow_internal=True) == "wallet"


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        ("attr.wallet.summary.*", True),
        ("attr.wallet.secrets.*", True),
        ("attr.source_library.knowledge.*", True),
        ("attr.financial.portfolio.*", False),
        ("agent.wallet.manage", False),
        ("vault.owner", False),
        (None, False),
        ("", False),
    ],
)
def test_reserved_domain_scope_truth_table(scope, expected) -> None:
    assert is_reserved_domain_scope(scope) is expected


def test_agent_wallet_scope_resolves_and_displays() -> None:
    assert resolve_scope_to_enum("agent.wallet.manage") is ConsentScope.AGENT_WALLET_MANAGE
    meta = get_scope_display_metadata("agent.wallet.manage")
    assert meta["label"] == "Wallet Management"
    assert meta["reserved"] is False


def test_dynamic_display_metadata_carries_reserved_indicator() -> None:
    assert get_scope_display_metadata("attr.wallet.summary.*")["reserved"] is True
    assert get_scope_display_metadata("attr.financial.portfolio.*")["reserved"] is False
