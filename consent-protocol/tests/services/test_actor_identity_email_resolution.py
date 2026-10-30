"""Where an account's email actually comes from.

The identity shadow read `user_record.email` and nothing else. People sign in
with Google, with Apple, and with a phone number, and only the first reliably
fills that top-level field -- so accounts were cached with no address at all,
and every feature that mails someone inherited the blank. Save my Soul is how
it surfaced: it skipped those contacts and reported "Emailed 0" without saying
why.
"""

from __future__ import annotations

from hushh_mcp.services.actor_identity_service import resolve_firebase_email


class _Provider:
    def __init__(self, provider_id: str, email: str | None = None):
        self.provider_id = provider_id
        self.email = email


class _User:
    def __init__(self, email=None, provider_data=None):
        self.email = email
        self.provider_data = provider_data or []


class TestTopLevelWins:
    def test_uses_the_top_level_email_when_present(self):
        user = _User(
            email="ankit@hushh.ai",
            provider_data=[_Provider("google.com", "other@gmail.com")],
        )
        assert resolve_firebase_email(user) == "ankit@hushh.ai"

    def test_a_blank_top_level_field_does_not_win(self):
        user = _User(email="   ", provider_data=[_Provider("google.com", "real@gmail.com")])
        assert resolve_firebase_email(user) == "real@gmail.com"


class TestProviderFallback:
    def test_finds_a_google_address_when_the_top_level_is_empty(self):
        # A phone-first account that later links Google carries the address on
        # the provider entry before the top-level field catches up.
        user = _User(provider_data=[_Provider("google.com", "real@gmail.com")])
        assert resolve_firebase_email(user) == "real@gmail.com"

    def test_finds_an_apple_relay_address(self):
        # Apple with Hide My Email leaves the top-level empty and puts the
        # relay address on the provider entry. Without this the contact simply
        # has no address and is skipped.
        user = _User(provider_data=[_Provider("apple.com", "abc123@privaterelay.appleid.com")])
        assert resolve_firebase_email(user) == "abc123@privaterelay.appleid.com"

    def test_prefers_google_over_apple_when_both_are_linked(self):
        # A real mailbox beats a relay that may refuse mail from an
        # unregistered sender.
        user = _User(
            provider_data=[
                _Provider("apple.com", "abc@privaterelay.appleid.com"),
                _Provider("google.com", "real@gmail.com"),
            ]
        )
        assert resolve_firebase_email(user) == "real@gmail.com"

    def test_falls_back_to_any_provider_that_has_one(self):
        user = _User(provider_data=[_Provider("microsoft.com", "work@contoso.com")])
        assert resolve_firebase_email(user) == "work@contoso.com"

    def test_ignores_provider_entries_with_no_usable_address(self):
        user = _User(
            provider_data=[
                _Provider("phone", None),
                _Provider("phone", ""),
                _Provider("google.com", "not-an-address"),
                _Provider("apple.com", "real@icloud.com"),
            ]
        )
        assert resolve_firebase_email(user) == "real@icloud.com"


class TestPhoneOnlyIsHonestlyUnreachable:
    def test_returns_none_when_the_account_has_no_email_anywhere(self):
        # This case is real and must not be papered over: a phone-only signup
        # cannot be emailed, and the caller has to say so rather than silently
        # skipping the person.
        user = _User(provider_data=[_Provider("phone")])
        assert resolve_firebase_email(user) is None

    def test_returns_none_for_an_account_with_no_provider_data_at_all(self):
        assert resolve_firebase_email(_User()) is None

    def test_survives_a_record_that_does_not_expose_provider_data(self):
        class _Bare:
            email = None

        assert resolve_firebase_email(_Bare()) is None
