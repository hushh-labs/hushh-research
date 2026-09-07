from hushh_mcp.onboarding_contract import (
    SETUP_CAPABILITY_ORDER,
    SETUP_PREREQUISITE_ORDER,
    normalize_setup_capability_id,
    normalize_setup_capability_ids,
)


def test_setup_capability_contract_has_exact_product_order() -> None:
    assert SETUP_CAPABILITY_ORDER == (
        "gmail",
        "calendar",
        "location",
        "email",
        "finance",
        "ria",
        "connected-systems",
    )
    assert SETUP_PREREQUISITE_ORDER == ("cloud", "connections")


def test_a_cloud_marker_survives_the_round_trip() -> None:
    """`cloud` must be admitted, and must sort ahead of AI access.

    This is the guard for the whole onboarding reorder, and it is worth more than it
    looks. `normalize_setup_capability_ids` filters against `SETUP_STATE_IDS` on the read
    AND the write path, so before `cloud` was admitted here every surface that wrote the
    marker would have had it dropped silently, with nothing raising and nothing logged --
    the step would simply never complete and no error would say why.

    Broken on purpose: remove "cloud" from SETUP_PREREQUISITE_ORDER and both asserts fail.
    """
    assert normalize_setup_capability_ids(["cloud"]) == ["cloud"]
    assert normalize_setup_capability_ids(["connections", "gmail", "cloud"]) == [
        "cloud",
        "connections",
        "gmail",
    ]
    # It is a root-setup prerequisite, never a product-agent capability, so it must stay
    # out of the generated action catalog.
    assert normalize_setup_capability_id("cloud") is None


def test_setup_capability_normalization_drops_retired_and_malformed_ids() -> None:
    assert normalize_setup_capability_ids(
        [
            "finance",
            " gmail ",
            "calendar",
            "marketplace",
            "connections",
            "pkm",
            "gmail",
            None,
        ]
    ) == ["connections", "gmail", "calendar", "finance"]
    assert normalize_setup_capability_id(" connected-systems ") == "connected-systems"
    assert normalize_setup_capability_id(" calendar ") == "calendar"
    assert normalize_setup_capability_id("consent") is None
