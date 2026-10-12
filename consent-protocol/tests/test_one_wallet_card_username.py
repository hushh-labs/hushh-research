import pytest

from hushh_mcp.services.one_wallet_card_username import (
    generate_wallet_username,
    validate_wallet_username,
)


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Ankit Kumar Singh", "ankit.kumar.singh"),
        ("Élodie Martin", "elodie.martin"),
        ("李", "member"),
        ("Admin", "member"),
        (None, "member"),
    ],
)
def test_username_defaults_are_readable_and_valid(name, expected):
    assert generate_wallet_username(name, "private-owner-id") == expected
    assert validate_wallet_username(expected) == expected


@pytest.mark.parametrize(
    "value",
    [
        "ab",
        "a" * 31,
        "Ankit",
        "user_name",
        ".name",
        "name.",
        "a..b",
        "user@domain.com",
        "sex",
        "s.e.x",
        "sex123",
        "user.porn",
        "admin",
        "support1",
        "<script>",
    ],
)
def test_username_rejects_invalid_or_blocked_labels(value):
    with pytest.raises(ValueError):
        validate_wallet_username(value)


def test_generation_truncates_without_a_trailing_dot():
    result = generate_wallet_username("a" * 29 + " long surname")
    assert result == "a" * 29
