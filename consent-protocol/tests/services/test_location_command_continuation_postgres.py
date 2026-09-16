"""Crash and concurrency tests against the real directive/receipt transactions."""

import asyncio
import hashlib
import json
import threading
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services import location_command_audience_receipts as audience
from hushh_mcp.services import location_command_membership_receipts as membership
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.location_command_continuation import (
    inspect_remaining_command,
    pause_remaining_command,
    renew_remaining_command,
)
from tests.services.test_location_command_postgres import (  # noqa: F401 — shared isolated schema fixture
    db as db,
)
from tests.services.test_location_command_postgres import (
    ready,
)


async def partial(db, monkeypatch, kind):
    ledger, checkpoint, state, args = await ready(db)
    monkeypatch.setattr(audience, "ActionDirectiveStore", lambda: ledger)
    monkeypatch.setattr(membership, "ActionDirectiveStore", lambda: ledger)
    circle = str(uuid4())
    if kind == "audience":
        binding = {
            "owner": "owner",
            "recipientIds": ["first", "second"],
            "people": [
                {"id": name, "name": name, "ready": True, "keyId": None}
                for name in ["first", "second"]
            ],
            "duration": "1",
            "message": "fixture",
            "sourceCircleByRecipient": {},
            "replacements": [],
        }
        action = "location.send_request"
    else:
        binding = {
            "owner": "owner",
            "circleId": circle,
            "circleName": "Fixture circle",
            "sourceReceipt": None,
            "people": [
                {"userId": f"person-{index:02}", "displayName": "Fixture", "member": False}
                for index in range(41)
            ],
        }
        action = "location.add_to_circle"
    prep = membership.MembershipPreparation(nonce="ab" * 32, binding_json=json.dumps(binding))
    digest = hashlib.sha256(f"{prep.nonce}:{prep.binding_json}".encode()).hexdigest()
    args.update(
        action={"action_id": action, "execution_policy": "confirm_required"},
        slots={},
        resource_binding={"digest": digest},
    )
    plan = (
        audience.prepare_audience_plan(prep, action=action, owner="owner", binding_digest=digest)
        if kind == "audience"
        else membership.prepare_membership_plan(
            prep, owner="owner", binding_digest=digest, store=ledger
        )
    )
    plan_arg = {f"{kind}_plan": plan}
    issued = await ledger.issue_command(**args)
    confirm = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=action,
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    claim = await ledger.claim_command(**args, **plan_arg, confirmation_receipt=confirm.receipt)
    db.execute_raw("CREATE TABLE continuation_effects(unit INT PRIMARY KEY)")

    def effect(index, directive=None, started=None):
        with db.engine.begin() as conn:
            if started is not None:
                conn.execute(text("SELECT NOW()"))
                started.set()
            if kind == "audience":
                guard = audience.CommandAudienceReceipt(
                    conn,
                    owner="owner",
                    operation=claim["operation_id"],
                    action=action,
                    directive_id=directive,
                    terms=audience.audience_terms(
                        recipient=binding["recipientIds"][index],
                        duration=1,
                        mode="timed",
                        message="fixture",
                    ),
                )
            else:
                ids = [person["userId"] for person in binding["people"]][
                    index * 20 : index * 20 + 20
                ]
                guard = membership.MembershipBatchReceipt(
                    conn,
                    owner="owner",
                    operation_id=claim["operation_id"],
                    batch=index,
                    circle_id=circle,
                    people=ids,
                    batch_count=3,
                    directive_id=directive,
                )
            previous = guard.claim()
            if previous is not None:
                return previous
            conn.execute(text("INSERT INTO continuation_effects VALUES(:unit)"), {"unit": index})
            result = (
                {"addedUserIds": ids, "skippedUserIds": [], "skippedReasons": {}}
                if kind == "membership"
                else f"resource-{index}"
            )
            guard.save(result)
            return result

    effect(0)
    return ledger, checkpoint, state, args, prep, digest, plan_arg, claim, effect


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["audience", "membership"])
async def test_partial_pause_renew_claim_preserves_receipts_and_fences_old_attempts(
    db, monkeypatch, kind
):
    ledger, _, state, args, prep, digest, plan_arg, claim, effect = await partial(
        db, monkeypatch, kind
    )
    assert await pause_remaining_command(
        ledger,
        owner="owner",
        command="command",
        step=0,
        operation=claim["operation_id"],
        execution_receipt=claim["execution_receipt"],
    )
    prior = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    proof = inspect_remaining_command(
        ledger, owner="owner", outcome=prior, preparation=prep, binding_digest=digest
    )
    assert proof["completed_unit_indices"] == [0]
    assert proof["pending_unit_indices"] == list(range(1, 2 if kind == "audience" else 3))
    with pytest.raises(ActionDirectiveAuthorityError):
        effect(1, claim["directive_id"])
    renew = dict(
        owner="owner",
        command="command",
        step=0,
        checkpoint_revision=state["revision"],
        plan_digest="plan",
        action=args["action"],
        context_revision="new-context",
        preparation=prep,
        binding_digest=digest,
        snapshot=proof["snapshot"],
    )
    attempts = await asyncio.gather(
        *[renew_remaining_command(ledger, **renew) for _ in range(2)], return_exceptions=True
    )
    assert sum(isinstance(result, ActionDirectiveAuthorityError) for result in attempts) == 1
    renewed = next(result for result in attempts if isinstance(result, dict))
    assert (
        renewed["operation_id"] == claim["operation_id"]
        and renewed["directive_id"] != claim["directive_id"]
    )
    # A restart between renewal and confirmation can inspect the same original
    # plan; it cannot be mistaken for a never-started operation.
    after = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    assert after["consumed_at"] == prior["consumed_at"]
    assert inspect_remaining_command(
        ledger, owner="owner", outcome=after, preparation=prep, binding_digest=digest
    )["completed_unit_indices"] == [0]
    current_args = {**args, "context_revision": "new-context"}
    for change in [
        {"resource_binding": {"digest": "different-private-draft"}},
        {"context_revision": "another-context"},
        {"action": {**args["action"], "execution_policy": "allow_direct"}},
        {"renew": True},
    ]:
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.issue_command(**{**current_args, **change})
    same = await ledger.issue_command(**current_args)
    assert same["directive_id"] == renewed["directive_id"]
    assert same["resource_binding_hmac"] == prior["resource_binding_hmac"]
    receipt = await ledger.confirm(
        directive_id=renewed["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="new-context",
        session_id="command",
        trusted_activation=True,
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(
            **{**args, "context_revision": "new-context"},
            **{f"{kind}_plan": {}},
            confirmation_receipt=receipt.receipt,
        )
    current = await ledger.claim_command(
        **{**args, "context_revision": "new-context"},
        **plan_arg,
        confirmation_receipt=receipt.receipt,
    )
    for directive in [None, claim["directive_id"]]:
        with pytest.raises(ActionDirectiveAuthorityError):
            effect(1, directive)
    effect(0, claim["directive_id"])  # completed receipt is still readable
    for index in proof["pending_unit_indices"]:
        effect(index, current["directive_id"])
    assert len(db.execute_raw("SELECT * FROM continuation_effects").data) == proof["total_units"]
    with pytest.raises(ActionDirectiveAuthorityError):
        await renew_remaining_command(ledger, **renew)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed", ["owner", "plan", "capsule_revision", "cancel", "expired", "selection"]
)
async def test_remaining_authority_rejects_changed_owner_task_or_original_selection(
    db, monkeypatch, changed
):
    ledger, _, state, args, prep, digest, _, claim, _ = await partial(db, monkeypatch, "audience")
    prior = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    proof = inspect_remaining_command(
        ledger, owner="owner", outcome=prior, preparation=prep, binding_digest=digest
    )
    values = dict(
        owner="owner",
        command="command",
        step=0,
        checkpoint_revision=state["revision"],
        plan_digest="plan",
        action=args["action"],
        context_revision="new-context",
        preparation=prep,
        binding_digest=digest,
        snapshot=proof["snapshot"],
    )
    if changed == "owner":
        values["owner"] = "other"
    elif changed == "plan":
        values["plan_digest"] = "different"
    elif changed == "capsule_revision":
        values["checkpoint_revision"] += 1
    elif changed == "cancel":
        db.execute_raw("UPDATE one_adk_sessions SET command_status='cancelled'")
    elif changed == "expired":
        db.execute_raw("UPDATE one_adk_sessions SET created_at=NOW()-INTERVAL '25 hours'")
    else:
        binding = json.loads(prep.binding_json)
        binding["duration"] = "2"
        values["preparation"] = membership.MembershipPreparation(
            nonce=prep.nonce, binding_json=json.dumps(binding)
        )
    with pytest.raises(ActionDirectiveAuthorityError):
        await renew_remaining_command(ledger, **values)
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "directive_id"
    ] == claim["directive_id"]
    assert db.execute_raw("SELECT * FROM continuation_effects").data == [{"unit": 0}]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["audience", "membership"])
async def test_waiting_for_a_session_lock_cannot_extend_expired_execution_authority(
    db, monkeypatch, kind
):
    _, _, _, _, _, _, _, claim, effect = await partial(db, monkeypatch, kind)
    started = threading.Event()
    with db.engine.begin() as blocker:
        blocker.execute(text("SELECT session_id FROM one_adk_sessions FOR UPDATE"))
        blocker.execute(
            text(
                "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()+INTERVAL '200 milliseconds'"
            )
        )
        pending = asyncio.create_task(asyncio.to_thread(effect, 1, claim["directive_id"], started))
        assert await asyncio.to_thread(started.wait, 2)
        # The transaction starts while authority is valid but obtains the
        # shared session lock only after its actual deadline.
        await asyncio.sleep(0.3)
    with pytest.raises(ActionDirectiveAuthorityError):
        await pending
    assert db.execute_raw("SELECT * FROM continuation_effects").data == [{"unit": 0}]
