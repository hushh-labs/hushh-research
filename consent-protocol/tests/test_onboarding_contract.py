from hushh_mcp.onboarding_contract import (
    SETUP_CAPABILITY_ORDER,
    SETUP_PREREQUISITE_ORDER,
    normalize_setup_capability_declined_ids,
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
    assert SETUP_PREREQUISITE_ORDER == ("connections",)


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


def test_declined_capability_normalization_excludes_the_mandatory_prerequisite() -> None:
    # "connections" is mandatory and can never be declined, even if a caller
    # somehow supplies it -- unlike normalize_setup_capability_ids, which
    # legitimately carries it as the AI-access-choice marker.
    assert normalize_setup_capability_declined_ids(
        [
            "gmail",
            " calendar ",
            "connections",
            "marketplace",
            "gmail",
            None,
        ]
    ) == ["gmail", "calendar"]
    assert normalize_setup_capability_declined_ids([]) == []
    assert normalize_setup_capability_declined_ids(None) == []
    assert normalize_setup_capability_declined_ids("not-a-list") == []
