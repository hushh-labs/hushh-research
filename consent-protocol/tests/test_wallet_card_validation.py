"""Server-side payment-card envelope validation (the region barrier)."""

import uuid

import pytest

from hushh_mcp.services.wallet_card_validation import (
    validate_card_summary_entry,
    validate_wallet_card_envelope,
)


def _entry(**overrides):
    entry = {
        "card_id": f"card_{uuid.uuid4()}",
        "brand": "visa",
        "last4": "4242",
        "expiry_month": 4,
        "expiry_year": 2030,
        "issuing_region": "US",
    }
    entry.update(overrides)
    return entry


def test_valid_entry_passes() -> None:
    validate_card_summary_entry(_entry())


def test_region_is_normalized_not_matched_literally() -> None:
    validate_card_summary_entry(_entry(issuing_region="india", brand="rupay"))


@pytest.mark.parametrize(
    ("brand", "region"),
    [("rupay", "US"), ("mir", "IN"), ("elo", "US"), ("verve", "BR")],
)
def test_region_locked_brand_outside_home_market_is_refused(brand, region) -> None:
    with pytest.raises(ValueError, match="card_brand_region_mismatch"):
        validate_card_summary_entry(_entry(brand=brand, issuing_region=region))


@pytest.mark.parametrize("region", ["US", "IN", "BR", "JP", "DE"])
def test_global_brands_pass_everywhere(region) -> None:
    validate_card_summary_entry(_entry(brand="visa", issuing_region=region))
    validate_card_summary_entry(_entry(brand="amex", issuing_region=region))


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("card_id", "card_not_a_uuid", "card_id_invalid"),
        ("brand", "spacecard", "card_brand_unknown"),
        ("last4", "42", "card_last4_invalid"),
        ("last4", "abcd", "card_last4_invalid"),
        ("expiry_month", 13, "card_expiry_month_invalid"),
        ("expiry_year", 1999, "card_expiry_year_invalid"),
        ("issuing_region", "Atlantis", "card_issuing_region_invalid"),
    ],
)
def test_bad_fields_are_refused(field, value, code) -> None:
    with pytest.raises(ValueError, match=code):
        validate_card_summary_entry(_entry(**{field: value}))


def test_envelope_refuses_secret_shaped_keys_anywhere() -> None:
    with pytest.raises(ValueError, match="contains_secret_key"):
        validate_wallet_card_envelope({"cards": [], "extra": {"cvv": "123"}})
    with pytest.raises(ValueError, match="contains_secret_key"):
        validate_wallet_card_envelope({"secrets": {}})


def test_envelope_count_mismatch_and_duplicates_are_refused() -> None:
    entry = _entry()
    with pytest.raises(ValueError, match="count_mismatch"):
        validate_wallet_card_envelope({"card_count": 2, "cards": [entry]})
    with pytest.raises(ValueError, match="duplicate_card_id"):
        validate_wallet_card_envelope({"card_count": 2, "cards": [entry, dict(entry)]})


def test_envelope_happy_path_with_bookkeeping_keys() -> None:
    validate_wallet_card_envelope(
        {
            "domain_intent": "wallet",
            "manifest_version": 3,
            "card_count": 1,
            "cards": [_entry()],
        }
    )


def test_store_domain_refuses_wallet_when_flag_off(monkeypatch) -> None:
    """The write policy hook: flag off -> 403 before any persistence."""
    from fastapi import HTTPException

    from api.routes import pkm_routes_shared

    monkeypatch.delenv("ONE_WALLET_ENABLED", raising=False)

    class _Req:
        summary = {"card_count": 0, "cards": []}

    with pytest.raises(HTTPException) as exc_info:
        pkm_routes_shared._enforce_wallet_write_policy(_Req(), "wallet")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail["code"] == "WALLET_DISABLED"


def test_store_domain_validates_envelope_when_flag_on(monkeypatch) -> None:
    from fastapi import HTTPException

    from api.routes import pkm_routes_shared

    monkeypatch.setenv("ONE_WALLET_ENABLED", "true")

    class _GoodReq:
        summary = {"card_count": 1, "cards": [_entry()]}

    pkm_routes_shared._enforce_wallet_write_policy(_GoodReq(), "wallet")

    class _BadReq:
        summary = {"card_count": 1, "cards": [_entry(brand="rupay", issuing_region="US")]}

    with pytest.raises(HTTPException) as exc_info:
        pkm_routes_shared._enforce_wallet_write_policy(_BadReq(), "wallet")
    assert exc_info.value.status_code == 422
    assert exc_info.value.detail["code"] == "WALLET_CARD_ENVELOPE_INVALID"


def test_other_domains_bypass_the_hook(monkeypatch) -> None:
    from api.routes import pkm_routes_shared

    monkeypatch.delenv("ONE_WALLET_ENABLED", raising=False)

    class _Req:
        summary = {"anything": True}

    pkm_routes_shared._enforce_wallet_write_policy(_Req(), "financial")
