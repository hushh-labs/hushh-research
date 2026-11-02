"""A Google-verified Calendar email becomes a verified alias of the connecting account only."""

import re
from pathlib import Path

import pytest

from hushh_mcp.services import google_calendar_profile_photo as photo_module
from hushh_mcp.services import google_calendar_verified_alias as aliases
from hushh_mcp.services.actor_identity_service import ActorIdentityAliasError
from hushh_mcp.services.google_calendar_profile_photo import CalendarProfilePhotos

EMAIL = "organizer@example.test"


class FakeIdentity:
    def __init__(self, existing=(), *, request_error=None):
        self.existing = list(existing)
        self.request_error = request_error
        self.calls = []

    async def list_verified_email_aliases(self, user_id):
        self.calls.append(("list", user_id))
        return self.existing

    async def request_email_alias_verification(self, **kwargs):
        self.calls.append(("request", kwargs))
        if self.request_error:
            raise self.request_error

    async def confirm_email_alias_verification(self, **kwargs):
        self.calls.append(("confirm", kwargs))


def alias(status="verified", revoked_at=None):
    return {"email_normalized": EMAIL, "verification_status": status, "revoked_at": revoked_at}


async def test_registers_a_verified_alias_for_exactly_the_connecting_account():
    identity = FakeIdentity()
    assert await aliases.record_google_verified_alias(
        user_id="owner-1", email=f" {EMAIL.upper()} ", identity=identity
    )
    kinds = [call[0] for call in identity.calls]
    assert kinds == ["list", "request", "confirm"]
    request, confirm = identity.calls[1][1], identity.calls[2][1]
    assert request == {
        "user_id": "owner-1",
        "email": EMAIL,
        "verification_source": "user_verified",
        "source_ref": "google_calendar_oauth",
    }
    # Confirmed on the same account and address, authorised by the Google check, never by a code.
    assert (confirm["user_id"], confirm["email"], confirm["accept_without_code"]) == (
        "owner-1",
        EMAIL,
        True,
    )


def test_the_recorded_source_is_one_the_alias_table_already_accepts():
    """No migration: a source outside the table's CHECK would be refused (or coerced)."""
    migration = Path(__file__).parents[2] / "db/migrations/052_actor_verified_email_aliases.sql"
    allowed = set(
        re.findall(
            r"'([a-z_]+)'",
            re.search(r"verification_source IN \(([^)]*)\)", migration.read_text()).group(1),
        )
    )
    assert aliases._SOURCE in allowed


async def test_an_already_verified_alias_is_left_alone():
    identity = FakeIdentity([alias()])
    assert await aliases.record_google_verified_alias(
        user_id="owner-1", email=EMAIL, identity=identity
    )
    assert [call[0] for call in identity.calls] == ["list"]


@pytest.mark.parametrize("existing", [alias("revoked"), alias("verified", revoked_at="2026-10-01")])
async def test_an_alias_the_person_removed_is_never_revived(existing):
    identity = FakeIdentity([existing])
    assert not await aliases.record_google_verified_alias(
        user_id="owner-1", email=EMAIL, identity=identity
    )
    assert [call[0] for call in identity.calls] == ["list"]  # nothing requested, nothing confirmed


async def test_an_address_another_account_verified_is_never_taken_over():
    conflict = ActorIdentityAliasError(
        "taken", code="EMAIL_ALIAS_ALREADY_VERIFIED", status_code=409
    )
    identity = FakeIdentity(request_error=conflict)
    assert not await aliases.record_google_verified_alias(
        user_id="owner-2", email=EMAIL, identity=identity
    )
    assert [call[0] for call in identity.calls] == ["list", "request"]  # never confirmed


async def test_a_failure_never_breaks_the_caller():
    identity = FakeIdentity(request_error=RuntimeError("database down"))
    assert not await aliases.record_google_verified_alias(
        user_id="owner-1", email=EMAIL, identity=identity
    )
    assert not await aliases.record_google_verified_alias(
        user_id="", email=EMAIL, identity=identity
    )
    assert not await aliases.record_google_verified_alias(user_id="owner-1", email="")


# ---- the live Google check is the only caller ------------------------------------------


class Owner:
    def __init__(self, profile):
        self.profile = profile
        self.row = None

    async def access_token(self, **_):
        return "token"

    async def _userinfo(self, _):
        return self.profile

    async def _connection(self, _):
        return self.row


def photos(profile, row):
    owner = Owner(profile)
    owner.row = row
    return CalendarProfilePhotos(owner)


ROW = {
    "provider_subject": "sub-1",
    "provider_email": EMAIL,
    "refresh_token_ciphertext": "x",
    "status": "connected",
}


@pytest.fixture
def recorded(monkeypatch):
    calls = []

    async def record(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(photo_module, "record_google_verified_alias", record)
    return calls


@pytest.mark.parametrize(
    "profile",
    [
        {"sub": "sub-1", "email": EMAIL, "email_verified": False},  # Google did not verify it
        {"sub": "sub-1", "email": "other@example.test", "email_verified": True},  # not this account
        {"sub": "sub-2", "email": EMAIL, "email_verified": True},  # a different Google subject
    ],
)
async def test_nothing_is_registered_unless_google_vouches_for_this_exact_account(
    recorded, profile
):
    await photos(profile, ROW).lookup(user_id="owner-1", account_id="default", row=ROW)
    assert recorded == []


async def test_a_verified_live_check_registers_the_alias_for_the_owner(recorded):
    profile = {"sub": "sub-1", "email": EMAIL, "email_verified": True}
    identity = await photos(profile, ROW).lookup(user_id="owner-1", account_id="default", row=ROW)
    assert identity["verified_email"] == EMAIL
    assert recorded == [{"user_id": "owner-1", "email": EMAIL}]
