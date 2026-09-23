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


@pytest.mark.parametrize("scope", ["attr.financial.profile.*", "attr.financial.portfolio.*"])
def test_derived_and_summary_branches_stay_shareable(scope):
    assert is_external_requestable_pkm_scope(scope) is True
