"""Hermetic unit tests for personal_agent_identity_service.

Pure HMAC derivation: no DB, no network. Sets the signing-key trust-domain env
and clears the cached settings so the tests are deterministic on any machine.
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_identity_service as ident

_SIGNING_KEY = "test_secret_key_for_ci_only_32chars_min"


@pytest.fixture(autouse=True)
def _signing_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", _SIGNING_KEY)
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


class TestNormalizeE164:
    def test_accepts_and_strips_formatting(self):
        assert ident.normalize_e164(" +1 (425) 555-0133 ") == "+14255550133"

    def test_plain_e164_passthrough(self):
        assert ident.normalize_e164("+14255550133") == "+14255550133"

    @pytest.mark.parametrize("bad", ["", "   ", "4255550133", "+0123456", "+1", "not-a-phone"])
    def test_rejects_invalid(self, bad):
        with pytest.raises(ValueError):
            ident.normalize_e164(bad)

    @pytest.mark.parametrize(
        "unicode_phone",
        [
            "+1２３４５６７",  # ASCII 1 + fullwidth digits
            "+1٢٣٤٥٦٧",  # ASCII 1 + Arabic-Indic digits
        ],
    )
    def test_rejects_unicode_digits(self, unicode_phone):
        # Trust boundary: non-ASCII digits hash to a different digest than the
        # ASCII form of the "same" number, so they must fail closed.
        with pytest.raises(ValueError):
            ident.normalize_e164(unicode_phone)


class TestMintHushhId:
    def test_deterministic(self):
        assert ident.mint_hushh_id("+14255550133") == ident.mint_hushh_id("+14255550133")

    def test_normalization_is_stable(self):
        assert ident.mint_hushh_id("+1 (425) 555-0133") == ident.mint_hushh_id("+14255550133")

    def test_prefixed_lowercase_no_padding(self):
        hid = ident.mint_hushh_id("+14255550133")
        assert hid.startswith("ha1_")
        assert hid == hid.lower()
        assert "=" not in hid

    def test_opaque_does_not_contain_phone(self):
        hid = ident.mint_hushh_id("+14255550133")
        assert "4255550133" not in hid
        assert "14255550133" not in hid

    def test_distinct_phones_distinct_ids(self):
        assert ident.mint_hushh_id("+14255550133") != ident.mint_hushh_id("+14255550134")

    def test_generation_changes_id(self):
        base = ident.mint_hushh_id("+14255550133", generation=0)
        rotated = ident.mint_hushh_id("+14255550133", generation=1)
        assert base != rotated

    def test_negative_generation_rejected(self):
        with pytest.raises(ValueError):
            ident.mint_hushh_id("+14255550133", generation=-1)

    def test_signing_key_binds_output(self, monkeypatch):
        first = ident.mint_hushh_id("+14255550133")
        monkeypatch.setenv("APP_SIGNING_KEY", "another_test_signing_key_32_chars_ok")
        get_core_security_settings.cache_clear()
        assert ident.mint_hushh_id("+14255550133") != first


class TestHashPhone:
    def test_deterministic_hex(self):
        h = ident.hash_phone_e164("+14255550133")
        assert h == ident.hash_phone_e164("+14255550133")
        assert len(h) == 64
        int(h, 16)  # valid hex

    def test_distinct_context_from_hushh_id(self):
        # Same phone, different HMAC context => unrelated digests.
        phone = "+14255550133"
        assert ident.hash_phone_e164(phone) not in ident.mint_hushh_id(phone)

    def test_invalid_phone_rejected(self):
        with pytest.raises(ValueError):
            ident.hash_phone_e164("not-a-phone")
