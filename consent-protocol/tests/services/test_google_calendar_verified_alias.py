"""A Google-verified Calendar email becomes a verified alias of the connecting account only.

The alias helper runs against the real ActorIdentityService request and confirm code over
stored rows (the same pool stand-in the service's own alias tests use), so a confirmation
the real service would refuse cannot pass here.
"""

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from hushh_mcp.services import actor_identity_service
from hushh_mcp.services import google_calendar_profile_photo as photo_module
from hushh_mcp.services import google_calendar_verified_alias as aliases
from hushh_mcp.services.actor_identity_service import ActorIdentityAliasError, ActorIdentityService
from hushh_mcp.services.google_calendar_profile_photo import CalendarProfilePhotos
from tests.services.test_actor_identity_service import _AliasFakeConnection, _AliasFakePool

EMAIL = "organizer@example.test"


@pytest.fixture
def store(monkeypatch):
    """The real alias service over stored rows; `rows` is the alias table."""
    connection = _AliasFakeConnection()

    async def get_pool():
        return _AliasFakePool(connection)

    monkeypatch.setattr(actor_identity_service, "get_pool", get_pool)
    return connection


async def registered(user_id, email=EMAIL):
    return await aliases.record_google_verified_alias(user_id=user_id, email=email)


async def test_a_verified_google_email_becomes_a_verified_alias_through_the_real_service(store):
    assert await registered("owner-1", f" {EMAIL.upper()} ")
    (alias,) = await ActorIdentityService().list_verified_email_aliases("owner-1")
    assert alias["email_normalized"] == EMAIL
    assert (alias["verification_status"], alias["revoked_at"]) == ("verified", None)
    assert alias["verified_at"] is not None
    assert (alias["verification_source"], alias["source_ref"]) == (
        "user_verified",
        "google_calendar_oauth",
    )
    assert store.rows[0]["verification_code_hash"] is None  # the one-time code was consumed


async def test_the_real_service_refuses_an_empty_code_so_it_cannot_be_used_to_confirm(store):
    """The original defect: confirming with "" and accept_without_code raised, was swallowed
    as a benign skip, and no alias was ever registered."""
    service = ActorIdentityService()
    await service.request_email_alias_verification(user_id="owner-1", email=EMAIL)
    with pytest.raises(ActorIdentityAliasError) as refused:
        await service.confirm_email_alias_verification(
            user_id="owner-1", email=EMAIL, verification_code="", accept_without_code=True
        )
    assert refused.value.code == "EMAIL_ALIAS_CODE_REQUIRED"
    assert store.rows[0]["verification_status"] == "pending"


async def test_a_second_check_changes_nothing(store):
    assert await registered("owner-1")
    first = dict(store.rows[0])
    assert await registered("owner-1")
    assert len(store.rows) == 1 and store.rows[0] == first


async def test_an_alias_the_person_removed_is_never_revived(store):
    assert await registered("owner-1")
    store.rows[0].update(verification_status="revoked", revoked_at=datetime.now(UTC))
    assert not await registered("owner-1")
    assert (store.rows[0]["verification_status"], len(store.rows)) == ("revoked", 1)


async def test_an_address_another_account_verified_is_never_taken_over(store):
    assert await registered("owner-1")
    assert not await registered("owner-2")
    verified = {row["user_id"] for row in store.rows if row["verification_status"] == "verified"}
    assert verified == {"owner-1"}
    assert [row["user_id"] for row in store.rows] == ["owner-1"]  # nothing was even requested


async def test_each_account_is_isolated_to_its_own_address(store):
    assert await registered("owner-1", "one@example.test")
    assert await registered("owner-2", "two@example.test")
    mine = await ActorIdentityService().list_verified_email_aliases("owner-1")
    assert [alias["email_normalized"] for alias in mine] == ["one@example.test"]


@pytest.mark.parametrize(
    "user_id,email", [("", EMAIL), ("owner-1", ""), ("owner-1", "not-an-email")]
)
async def test_unusable_input_registers_nothing(store, user_id, email):
    assert not await registered(user_id, email)
    assert store.rows == []


async def test_a_failure_never_breaks_the_caller(monkeypatch):
    async def broken():
        raise RuntimeError("database down")

    monkeypatch.setattr(actor_identity_service, "get_pool", broken)
    assert not await registered("owner-1")


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


# ---- the live Google check is the only caller ------------------------------------------


class Owner:
    def __init__(self, profile, row):
        self.profile, self.row = profile, row

    async def access_token(self, **_):
        return "token"

    async def _userinfo(self, _):
        return self.profile

    async def _connection(self, _):
        return self.row


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
    await CalendarProfilePhotos(Owner(profile, ROW)).lookup(
        user_id="owner-1", account_id="default", row=ROW
    )
    assert recorded == []


async def test_a_verified_live_check_registers_the_alias_for_the_owner(recorded):
    profile = {"sub": "sub-1", "email": EMAIL, "email_verified": True}
    identity = await CalendarProfilePhotos(Owner(profile, ROW)).lookup(
        user_id="owner-1", account_id="default", row=ROW
    )
    assert identity["verified_email"] == EMAIL
    assert recorded == [{"user_id": "owner-1", "email": EMAIL}]
