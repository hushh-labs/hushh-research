import pytest

from hushh_mcp.services.wallet_card_validation import (
    CARD_BRANDS,
    NETWORK_ORDER,
    classify_card_network,
    normalize_card_network,
)


@pytest.mark.parametrize(
    "prefix,length,brand",
    [
        ("411111", 13, "visa"),
        ("424242", 16, "visa"),
        ("411111", 19, "visa"),
        ("555555", 16, "mastercard"),
        ("222111", 16, "mastercard"),
        ("272000", 16, "mastercard"),
        ("371111", 15, "amex"),
        ("601111", 16, "discover"),
        ("651111", 16, "discover"),
        ("652111", 16, "rupay"),
        ("220011", 16, "mir"),
        ("401178", 16, "elo"),
        ("506099", 18, "verve"),
        ("300111", 14, "diners"),
        ("352800", 16, "jcb"),
        ("621111", 16, "unionpay"),
    ],
)
def test_existing_network_rules_are_backend_owned(prefix, length, brand):
    assert classify_card_network(prefix, length)["network"] == brand


@pytest.mark.parametrize(
    "prefix,length,brand",
    [
        ("411111", 14, "visa"),
        ("371111", 16, "amex"),
        ("555555", 15, "mastercard"),
        ("353111", 15, "rupay"),
    ],
)
@pytest.mark.parametrize("owner_selected", [False, True])
def test_invalid_network_lengths_keep_the_network_for_local_rejection(
    prefix, length, brand, owner_selected
):
    result = classify_card_network(prefix, length, brand if owner_selected else None)
    assert result["network"] == brand
    assert result["source"] == ("owner_selected" if owner_selected else "prefix")


def test_length_can_disambiguate_an_overlapping_network():
    assert classify_card_network("353111", 19)["network"] == "jcb"


@pytest.mark.parametrize("prefix", ["353111", "356111", "622126", "622925"])
def test_overlapping_networks_are_not_guessed(prefix):
    result = classify_card_network(prefix, 16)
    assert result["source"] == "ambiguous" and result["network"] == "other"
    assert len(result["candidates"]) > 1


def test_unknown_network_and_owner_selected_new_prefix():
    assert classify_card_network("911111", 16)["network"] == "other"
    assert classify_card_network("911111", 16, "MasterCard")["network"] == "mastercard"
    assert classify_card_network("353111", 16, "rupay")["source"] == "owner_selected"


@pytest.mark.parametrize(
    "prefix,length",
    [
        ("4111111111111111", 16),
        ("41111", 16),
        ("abcd12", 16),
        ("４１１１１１", 16),
        ("411111", True),
        ("411111", 11),
        ("411111", 20),
    ],
)
def test_invalid_metadata_is_refused(prefix, length):
    with pytest.raises(ValueError):
        classify_card_network(prefix, length)


def test_selected_network_validation_and_normalization():
    assert normalize_card_network(" Visa ") == "visa"
    assert normalize_card_network("UNSUPPORTED") == "other"
    with pytest.raises(ValueError):
        classify_card_network("411111", 16, "bad")
    assert set(NETWORK_ORDER) == CARD_BRANDS


def test_twelve_digit_metadata_preserves_known_network_rejection_and_generic_selection():
    assert classify_card_network("911111", 12)["network"] == "other"
    assert classify_card_network("911111", 12, "other")["source"] == "owner_selected"
    assert classify_card_network("411111", 12)["network"] == "visa"
    assert classify_card_network("371111", 12)["network"] == "amex"
