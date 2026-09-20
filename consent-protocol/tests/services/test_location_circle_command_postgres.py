"""Exercise the existing Circle writers with real command authority and locks."""

import asyncio
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services import location_command_effect_receipts as receipts
from hushh_mcp.services.location_circle_command import circle_effect_terms
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)
from tests.services.test_location_command_postgres import db as db  # noqa: F401
from tests.services.test_location_command_postgres import ready, sms_schema

ACTIONS = [
    "rename_circle",
    "remove_from_circle",
    "leave_circle",
    "delete_circle",
    "accept_circle_invite",
    "decline_circle_invite",
]


def circle_fixture(db, monkeypatch, action):
    sms_schema(db)
    db.execute_raw("""
        UPDATE connections SET user_a_id='other',user_b_id='owner';
        ALTER TABLE connection_requests ADD COLUMN id UUID PRIMARY KEY DEFAULT gen_random_uuid();
        CREATE TABLE connection_scope_proposals(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          connection_request_id UUID NOT NULL REFERENCES connection_requests(id), status TEXT NOT NULL DEFAULT 'pending',
          expires_at TIMESTAMPTZ NOT NULL,resolved_at TIMESTAMPTZ);
        CREATE TABLE connection_scope_proposal_events(id BIGSERIAL PRIMARY KEY,
          connection_scope_proposal_id UUID NOT NULL REFERENCES connection_scope_proposals(id),
          event_type TEXT NOT NULL,actor_user_id TEXT,reason TEXT);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for name in (
        "138_circle_member_connection_origin.sql",
        "158_one_location_circle_member_limit_100.sql",
        "159_one_location_circle_invite_max_uses_100.sql",
    ):
        db.execute_raw((migrations / name).read_text())
    # Only delivery transports are replaced; mutation/cleanup/receipt SQL stays real.
    from hushh_mcp.services import push_notifications

    monkeypatch.setattr(
        push_notifications, "send_circle_member_invite_accepted_push", lambda **_: None
    )
    monkeypatch.setattr(
        OneLocationCircleService, "_notify_invite_declined", staticmethod(lambda **_: None)
    )
    monkeypatch.setattr(
        OneLocationCircleService, "_notify_membership_end", staticmethod(lambda **_: None)
    )
    service = OneLocationCircleService(db=db, hmac_key="synthetic-circle-key")
    circle_owner = (
        "other"
        if action in {"leave_circle", "accept_circle_invite", "decline_circle_invite"}
        else "owner"
    )
    with db.engine.begin() as conn:
        circle_id = service.create_circle_in_transaction(
            conn, owner_user_id=circle_owner, name="Goa"
        )
    binding = {
        "owner": "owner",
        "action": f"location.{action}",
        "circleId": circle_id,
        "circleName": "Goa",
    }
    if "invite" in action:
        invitation = db.execute_raw(
            """INSERT INTO one_location_circle_member_invites(circle_id,inviter_user_id,invitee_user_id,expires_at)
          VALUES(CAST(:circle AS UUID),'other','owner',NOW()+INTERVAL '1 day') RETURNING id,created_at,expires_at""",
            {"circle": circle_id},
        ).data[0]
        binding.update(
            inviteId=str(invitation["id"]),
            inviterId="other",
            inviteCreatedAt=invitation["created_at"].isoformat(),
            inviteExpiresAt=invitation["expires_at"].isoformat(),
        )
    else:
        binding["circleUpdatedAt"] = (
            db.execute_raw(
                "SELECT updated_at FROM one_location_circles WHERE id=CAST(:circle AS UUID)",
                {"circle": circle_id},
            )
            .data[0]["updated_at"]
            .isoformat()
        )
        if action == "rename_circle":
            binding["newName"] = "Goa trip"
        else:
            member = "owner" if action == "leave_circle" else "other"
            joined = db.execute_raw(
                """INSERT INTO one_location_circle_memberships(circle_id,user_id,role,status)
              VALUES(CAST(:circle AS UUID),:member,'member','active') RETURNING joined_at""",
                {"circle": circle_id, "member": member},
            ).data[0]["joined_at"]
            if action == "delete_circle":
                binding["roster"] = [
                    {
                        "userId": row["user_id"],
                        "role": row["role"],
                        "joinedAt": row["joined_at"].isoformat(),
                    }
                    for row in db.execute_raw(
                        "SELECT user_id,role,joined_at FROM one_location_circle_memberships"
                    ).data
                ]
            else:
                binding.update(memberId=member, joinedAt=joined.isoformat())
    return service, binding


async def claim(db, monkeypatch, binding):
    ledger, _, _, args = await ready(db)
    monkeypatch.setattr(receipts, "ActionDirectiveStore", lambda: ledger)
    action = binding["action"]
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
    result = await ledger.claim_command(
        **args,
        confirmation_receipt=confirmation.receipt,
        effect_request_hmac=ledger._hmac([action, circle_effect_terms(action, binding)]),
    )
    return {"command_operation_id": result["operation_id"], "command_binding": binding}


def execute(service, binding, command):
    action = binding["action"].removeprefix("location.")
    if action == "rename_circle":
        return service.update_circle(
            owner_user_id="owner", circle_id=binding["circleId"], name=binding["newName"], **command
        )
    if action == "remove_from_circle":
        return service.remove_member(
            owner_user_id="owner",
            circle_id=binding["circleId"],
            member_user_id=binding["memberId"],
            **command,
        )
    if action == "leave_circle":
        return service.leave_circle(user_id="owner", circle_id=binding["circleId"], **command)
    if action == "delete_circle":
        return service.delete_circle(
            owner_user_id="owner", circle_id=binding["circleId"], **command
        )
    if action == "accept_circle_invite":
        return service.accept_member_invite(
            user_id="owner", invite_id=binding["inviteId"], **command
        )
    return service.decline_member_invite(user_id="owner", invite_id=binding["inviteId"], **command)


def snapshot(db):
    return {
        table: db.execute_raw(f"SELECT * FROM {table} ORDER BY 1,2").data
        for table in (
            "one_location_circles",
            "one_location_circle_memberships",
            "one_location_circle_member_invites",
            "one_location_circle_invite_codes",
            "connections",
            "connection_origins",
            "one_location_share_grants",
            "one_location_sms_contacts",
            "one_location_events",
        )
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ACTIONS)
async def test_real_circle_writers_commit_once_and_replay_after_authority_expires(
    db, monkeypatch, action
):
    service, binding = circle_fixture(db, monkeypatch, action)
    command = await claim(db, monkeypatch, binding)
    first, second = await asyncio.gather(
        *[asyncio.to_thread(execute, service, binding, command) for _ in range(2)]
    )
    assert first == second
    assert first["operationReceipt"]["circle_id"] == binding["circleId"]
    expected = dict(
        zip(ACTIONS, ["renamed", "removed", "left", "deleted", "accepted", "declined"], strict=True)
    )
    assert first["operationReceipt"]["result"] == expected[action]
    before = snapshot(db)
    db.execute_raw("UPDATE one_action_directive_ledger SET expires_at=NOW()-INTERVAL '1 minute'")
    assert execute(service, binding, command) == first
    assert snapshot(db) == before
    if action == "accept_circle_invite":
        assert db.execute_raw(
            "SELECT status FROM one_location_circle_memberships WHERE user_id='owner'"
        ).data == [{"status": "active"}]
        assert db.execute_raw(
            "SELECT origin_kind FROM connection_origins ORDER BY origin_kind"
        ).data == [
            {"origin_kind": "circle_member"},
            {"origin_kind": "direct_request"},
            {"origin_kind": "named_circle"},
        ]
        assert len(db.execute_raw("SELECT id FROM one_location_events").data) == 1
        assert db.execute_raw("SELECT id FROM one_location_share_grants").data == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("action", "notifier_name", "expected_type"),
    [
        ("rename_circle", "send_circle_renamed_push", "renamed"),
        ("delete_circle", "send_circle_deleted_push", "deleted"),
    ],
)
async def test_rename_and_delete_notify_the_exact_locked_roster_after_commit(
    db, monkeypatch, action, notifier_name, expected_type
):
    service, binding = circle_fixture(db, monkeypatch, action)
    command = await claim(db, monkeypatch, binding)
    if action == "rename_circle":
        # Rename does not need the roster in its reviewed effect terms, so add
        # a member after confirmation to prove delivery uses the roster locked
        # at commit time instead of a stale review-time snapshot.
        db.execute_raw(
            """INSERT INTO one_location_circle_memberships(circle_id,user_id,role,status)
            VALUES(CAST(:circle AS UUID),'other','member','active')""",
            {"circle": binding["circleId"]},
        )
    delivered: list[dict] = []
    from hushh_mcp.services import push_notifications

    monkeypatch.setattr(
        push_notifications,
        notifier_name,
        lambda **kwargs: delivered.append(kwargs) or 1,
    )

    result = execute(service, binding, command)
    replay = execute(service, binding, command)

    assert result["operationReceipt"]["result"] == expected_type
    assert replay == result
    assert len(delivered) == 2
    assert {delivery["user_id"] for delivery in delivered} == {"owner", "other"}
    assert (
        next(delivery for delivery in delivered if delivery["user_id"] == "owner")["show_alert"]
        is False
    )
    assert (
        next(delivery for delivery in delivered if delivery["user_id"] == "other")["show_alert"]
        is True
    )
    assert {delivery["circle_id"] for delivery in delivered} == {binding["circleId"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ACTIONS)
async def test_receipt_failure_rolls_back_every_coupled_circle_effect(db, monkeypatch, action):
    service, binding = circle_fixture(db, monkeypatch, action)
    command = await claim(db, monkeypatch, binding)
    before = snapshot(db)

    def fail(*_):
        raise RuntimeError("synthetic failure before receipt")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", fail)
    with pytest.raises((RuntimeError, OneLocationCircleError)):
        execute(service, binding, command)
    assert snapshot(db) == before
    assert db.execute_raw("SELECT effect_receipt FROM one_action_directive_ledger").data == [
        {"effect_receipt": None}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["owner", "action", "name", "circle", "cancel", "roster", "membership", "invitation"]
)
async def test_changed_review_is_rejected_without_effect(db, monkeypatch, change):
    action = {
        "roster": "delete_circle",
        "membership": "remove_from_circle",
        "invitation": "accept_circle_invite",
    }.get(change, "rename_circle")
    service, binding = circle_fixture(db, monkeypatch, action)
    command = await claim(db, monkeypatch, binding)
    if change == "owner":
        command["command_binding"] = {**binding, "owner": "other"}
    elif change == "action":
        command["command_binding"] = {**binding, "action": "location.delete_circle"}
    elif change == "name":
        binding["newName"] = "Not reviewed"
    elif change == "circle":
        binding["circleId"] = str(uuid4())
    elif change == "cancel":
        db.execute_raw("UPDATE one_adk_sessions SET command_status='cancelled'")
    elif change == "roster":
        db.execute_raw(
            "UPDATE one_location_circle_memberships SET status='left' WHERE user_id='other'"
        )
    elif change == "membership":
        db.execute_raw(
            "UPDATE one_location_circle_memberships SET joined_at=joined_at+INTERVAL '1 second' WHERE user_id='other'"
        )
    else:
        db.execute_raw(
            "UPDATE one_location_circle_member_invites SET expires_at=expires_at+INTERVAL '1 second'"
        )
    before = snapshot(db)
    with pytest.raises(OneLocationCircleError):
        execute(service, binding, command)
    assert snapshot(db) == before


@pytest.mark.asyncio
async def test_expiry_while_acceptance_waits_for_profile_rolls_back_membership_and_receipt(
    db, monkeypatch
):
    service, binding = circle_fixture(db, monkeypatch, "accept_circle_invite")
    command = await claim(db, monkeypatch, binding)
    before = snapshot(db)
    db.execute_raw(
        "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()+INTERVAL '2 seconds'"
    )
    # Hold a domain lock acquired after the first receipt checks. The expiry
    # transaction is separate and committed before the blocked writer resumes.
    with db.engine.begin() as conn:
        conn.execute(text("SELECT user_id FROM actor_profiles WHERE user_id='owner' FOR UPDATE"))
        task = asyncio.create_task(asyncio.to_thread(execute, service, binding, command))
        for _ in range(100):
            blocked = await asyncio.to_thread(
                db.execute_raw,
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%actor_profiles%' AND pid<>pg_backend_pid()",
            )
            if blocked.data:
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("The writer did not reach the profile lock")
        await asyncio.sleep(2.1)
    with pytest.raises(OneLocationCircleError):
        await task
    assert snapshot(db) == before
    assert db.execute_raw("SELECT effect_receipt FROM one_action_directive_ledger").data == [
        {"effect_receipt": None}
    ]
