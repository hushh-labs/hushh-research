"""Raw financial records and account identifiers are never shareable.

Founder decision 2026-09-23: a grant delivers derived facts and summaries,
not the per-connection copies (`sources`), app state (`runtime`), or account
masks, numbers and security codes wherever they sit."""

import pytest

from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_externalizable_pkm_manifest_path,
)


@pytest.mark.parametrize(
    "scope",
    [
        "attr.financial.sources.*",
        "attr.financial.sources.plaid.*",
        "attr.financial.sources.plaid.items",
        "attr.financial.sources.statement.*",
        "attr.financial.runtime.*",
        "attr.financial.*",
        # Zero-knowledge Plaid branches sealed in the owner's vault.
        "attr.financial.connections_v1.*",
        "attr.financial.accounts_v1.*",
        "attr.financial.accounts_v1.balances",
        "attr.financial.holdings_v1.*",
        "attr.financial.securities_v1.*",
        "attr.financial.transactions_v1.*",
        "attr.financial.transactions_v1.merchant_name",
        "attr.financial.derived_v1.*",
    ],
)
def test_raw_financial_branches_cannot_be_requested(scope):
    assert is_external_requestable_pkm_scope(scope) is False


@pytest.mark.parametrize(
    "path",
    [
        "portfolio.holdings.account_mask",
        "portfolio.holdings.symbol_cusip",
        "portfolio.account_info.account_number",
        "portfolio.account_info.routing_number",
        "profile.accounts.mask",
    ],
)
def test_account_identifiers_never_enter_an_export(path):
    assert is_externalizable_pkm_manifest_path(domain="financial", path=path) is False


@pytest.mark.parametrize(
    "scope",
    [
        "attr.financial.profile.*",
        "attr.financial.portfolio.*",
        "attr.financial.summary.*",
        "attr.financial.summary.allocation_bands",
    ],
)
def test_derived_and_summary_branches_stay_shareable(scope):
    assert is_external_requestable_pkm_scope(scope) is True


def test_vault_branches_are_registered_financial_subintents():
    from hushh_mcp.services.domain_contracts import (
        FINANCIAL_INTENT_MAP,
        FINANCIAL_SUBINTENT_REGISTRY,
        get_domain_sharing_policy,
    )

    registered = {entry.domain_key for entry in FINANCIAL_SUBINTENT_REGISTRY}
    denied = set(get_domain_sharing_policy("financial").denied_manifest_path_prefixes)
    for branch in (
        "connections_v1",
        "accounts_v1",
        "holdings_v1",
        "securities_v1",
        "transactions_v1",
        "derived_v1",
    ):
        assert branch in FINANCIAL_INTENT_MAP
        assert f"financial.{branch}" in registered
        assert branch in denied
    assert "summary" in FINANCIAL_INTENT_MAP
    assert "financial.summary" in registered
    assert "summary" not in denied
