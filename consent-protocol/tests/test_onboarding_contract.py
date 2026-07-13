from hushh_mcp.onboarding_contract import (
    SETUP_CAPABILITY_ORDER,
    normalize_setup_capability_id,
    normalize_setup_capability_ids,
)


def test_setup_capability_contract_has_exact_product_order() -> None:
    assert SETUP_CAPABILITY_ORDER == (
        "gmail",
        "location",
        "email",
        "finance",
        "ria",
        "connected-systems",
    )


def test_setup_capability_normalization_drops_retired_and_malformed_ids() -> None:
    assert normalize_setup_capability_ids(
        ["finance", " gmail ", "marketplace", "pkm", "gmail", None]
    ) == ["gmail", "finance"]
    assert normalize_setup_capability_id(" connected-systems ") == "connected-systems"
    assert normalize_setup_capability_id("consent") is None
