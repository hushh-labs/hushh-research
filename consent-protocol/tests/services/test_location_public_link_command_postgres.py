"""Public link effects, events and command receipts use the owning transaction."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services import location_command_effect_receipts as receipts
from hushh_mcp.services import one_location_agent_service as location
from hushh_mcp.services.location_public_link_writer import public_link_terms
from tests.services.test_location_command_postgres import db as db  # noqa: F401
from tests.services.test_location_command_postgres import ready


def service_factory(db, monkeypatch):
    db.execute_raw("""
        CREATE TABLE one_location_access_requests(id UUID PRIMARY KEY);
        CREATE TABLE one_location_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          owner_user_id TEXT, actor_user_id TEXT, recipient_user_id TEXT,
          grant_id UUID, envelope_id UUID, request_id UUID, referral_id UUID,
          event_type TEXT, metadata JSONB, created_at TIMESTAMPTZ);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    db.execute_raw((migrations / "064_one_location_public_invites.sql").read_text())
    # Location write paths consult the owner-level sharing posture (migration
    # 221); the fixture's actor_profiles rows come from the shared ``db`` fixture.
    db.execute_raw((migrations / "221_one_location_account_settings.sql").read_text())
    monkeypatch.setattr(location, "get_db", lambda: db)
    monkeypatch.setattr(
        location, "_public_invite_signing_key", lambda: b"synthetic-public-link-fixture"
    )
    monkeypatch.setattr(
        location.OneLocationAgentService, "_public_invite_owner_label", lambda *_: "Fixture"
    )
    return location.OneLocationAgentService


async def claimed_link(db, monkeypatch, action="location.create_public_link", existing=None):
    ledger, _, _, args = await ready(db)
    monkeypatch.setattr(receipts, "ActionDirectiveStore", lambda: ledger)
    binding = {"owner": "owner", "action": action, "activeInvite": None, "durationHours": 0.5}
    if existing:
        binding["activeInvite"] = {"id": existing["id"], "expiresAt": existing["expiresAt"]}
    args.update(action={"action_id": action, "execution_policy": "confirm_required"}, slots={})
    issued = await ledger.issue_command(**args)
    confirmation = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=action,
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    claim = await ledger.claim_command(
        **args,
        confirmation_receipt=confirmation.receipt,
        effect_request_hmac=ledger._hmac([action, public_link_terms(action, binding)]),
    )
    return {"command_operation_id": claim["operation_id"], "command_binding": binding}


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [False, True])
async def test_lost_response_and_concurrent_retry_never_recreate_or_extend_twice(
    db, monkeypatch, existing
):
    make_service = service_factory(db, monkeypatch)
    original = (
        make_service().create_public_invite(owner_user_id="owner", duration_hours=0.25)["invite"]
        if existing
        else None
    )
    command = await claimed_link(db, monkeypatch, existing=original)

    def create():
        return make_service().create_public_invite(
            owner_user_id="owner", duration_hours=0.5, **command
        )

    first, duplicate = await asyncio.gather(asyncio.to_thread(create), asyncio.to_thread(create))
    assert first["invite"]["id"] == duplicate["invite"]["id"]
    assert first["invite"]["expiresAt"] == duplicate["invite"]["expiresAt"]
    if original:
        assert first["invite"]["id"] == original["id"] and first["reused"] is True
    assert first["operationReceipt"] == duplicate["operationReceipt"]
    assert set(first["operationReceipt"]) == {
        "operation_id",
        "invite_id",
        "expires_at",
        "status",
        "reused",
    }
    assert len(db.execute_raw("SELECT id FROM one_location_public_invites").data) == 1
    assert len(db.execute_raw("SELECT id FROM one_location_events").data) == 1 + int(existing)
    # Replaying the old create after manual revocation returns its receipt and
    # fresh revoked state; it cannot resurrect the link or renew its window.
    make_service().revoke_public_invite(owner_user_id="owner", invite_id=first["invite"]["id"])
    after = create()
    assert after["invite"]["status"] == "revoked"
    assert not after["invite"].get("publicUrl")
    assert after["operationReceipt"] == first["operationReceipt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["receipt", "event"])
async def test_public_link_and_event_roll_back_when_receipt_or_event_cannot_commit(
    db, monkeypatch, failure
):
    make_service = service_factory(db, monkeypatch)
    command = await claimed_link(db, monkeypatch)
    if failure == "receipt":

        def fail(*_):
            raise RuntimeError("injected receipt failure")

        monkeypatch.setattr(receipts.CommandEffectReceipt, "save", fail)
    else:
        db.execute_raw(
            "ALTER TABLE one_location_events ADD CONSTRAINT injected_failure CHECK (event_type != 'location_public_invite_created')"
        )
    with pytest.raises((RuntimeError, IntegrityError, location.OneLocationAgentError)):
        make_service().create_public_invite(owner_user_id="owner", duration_hours=0.5, **command)
    assert db.execute_raw("SELECT id FROM one_location_public_invites").data == []
    assert db.execute_raw("SELECT id FROM one_location_events").data == []
    assert db.execute_raw("SELECT effect_receipt,state FROM one_action_directive_ledger").data == [
        {"effect_receipt": None, "state": "consumed"}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["new_link", "duration", "owner", "legacy_token", "expiry", "cancel"]
)
async def test_command_cannot_change_reviewed_public_link_terms_or_replace_its_url(
    db, monkeypatch, change
):
    make_service = service_factory(db, monkeypatch)
    original = None
    if change in {"legacy_token", "expiry"}:
        original = make_service().create_public_invite(owner_user_id="owner", duration_hours=1)[
            "invite"
        ]
    command = await claimed_link(db, monkeypatch, existing=original)
    owner, duration = "owner", 0.5
    if change == "new_link":
        make_service().create_public_invite(owner_user_id="owner", duration_hours=1)
    elif change == "duration":
        duration = 1
    elif change == "owner":
        owner = "other"
    elif change == "legacy_token":
        db.execute_raw("UPDATE one_location_public_invites SET metadata='{}'::jsonb")
    elif change == "expiry":
        db.execute_raw(
            "UPDATE one_location_public_invites SET expires_at=clock_timestamp()-INTERVAL '1 second'"
        )
    else:
        db.execute_raw("UPDATE one_adk_sessions SET command_status='cancelled'")
    before = db.execute_raw("SELECT id,status,expires_at FROM one_location_public_invites").data
    with pytest.raises(location.OneLocationAgentError) as error:
        make_service().create_public_invite(owner_user_id=owner, duration_hours=duration, **command)
    assert error.value.code == "LOCATION_PUBLIC_LINK_REVIEW_REQUIRED"
    assert (
        db.execute_raw("SELECT id,status,expires_at FROM one_location_public_invites").data
        == before
    )
    assert db.execute_raw("SELECT effect_receipt FROM one_action_directive_ledger").data == [
        {"effect_receipt": None}
    ]


@pytest.mark.asyncio
async def test_revoke_replay_leaves_a_later_link_untouched(db, monkeypatch):
    make_service = service_factory(db, monkeypatch)
    original = make_service().create_public_invite(owner_user_id="owner", duration_hours=1)[
        "invite"
    ]
    command = await claimed_link(
        db, monkeypatch, action="location.revoke_public_link", existing=original
    )

    def revoke():
        return make_service().revoke_public_invite(
            owner_user_id="owner", invite_id=original["id"], **command
        )

    first = revoke()
    later = make_service().create_public_invite(owner_user_id="owner", duration_hours=1)["invite"]
    assert revoke() == first
    assert later["id"] != original["id"]
    live = db.execute_raw("SELECT id FROM one_location_public_invites WHERE status='active'").data
    assert [str(row["id"]) for row in live] == [later["id"]]
    assert (
        len(
            db.execute_raw(
                "SELECT id FROM one_location_events WHERE event_type='location_public_invite_revoked'"
            ).data
        )
        == 1
    )


@pytest.mark.asyncio
async def test_concurrent_manual_calls_share_owner_lock_and_database_duration_clock(
    db, monkeypatch
):
    make_service = service_factory(db, monkeypatch)

    def create():
        return make_service().create_public_invite(owner_user_id="owner", duration_hours=0.25)

    first, second = await asyncio.gather(asyncio.to_thread(create), asyncio.to_thread(create))
    assert first["invite"]["id"] == second["invite"]["id"]
    assert len(db.execute_raw("SELECT id FROM one_location_public_invites").data) == 1
    for result in (first, second):
        expiry = datetime.fromisoformat(result["invite"]["expiresAt"].replace("Z", "+00:00"))
        assert 890 < (expiry - datetime.now(timezone.utc)).total_seconds() <= 900


def test_semantic_public_link_read_never_returns_tokens_or_another_owners_link(db, monkeypatch):
    make_service = service_factory(db, monkeypatch)
    service = make_service()
    service.create_public_invite(owner_user_id="owner", duration_hours=1)
    service.create_public_invite(owner_user_id="other", duration_hours=0.5)
    result = service.observe_command_status(user_id="owner", kind="links")
    assert len(result["items"]) == 1
    assert set(result["items"][0]) == {"status", "expiresAt", "durationHours"}
    assert result["items"][0]["durationHours"] == 1
    db.execute_raw(
        "UPDATE one_location_public_invites SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE owner_user_id='owner'"
    )
    assert service.observe_command_status(user_id="owner", kind="links")["items"] == []
    assert db.execute_raw(
        "SELECT status FROM one_location_public_invites WHERE owner_user_id='owner'"
    ).data == [{"status": "active"}]
