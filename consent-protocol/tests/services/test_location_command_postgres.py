"""Real transaction tests. Run with ONE_COMMAND_TEST_DATABASE_URL pointing to an isolated test DB."""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.agent_chat_service import AgentChatService
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict, CommandCheckpointStore


@pytest.fixture
def db():
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    engine = create_engine(url)
    schema = f"command_test_{uuid4().hex}"
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})

    class Database:
        engine = scoped

        def execute_raw(self, sql, params=None):
            with scoped.begin() as conn:
                result = conn.execute(text(sql), params or {})
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

    database = Database()
    database.execute_raw(
        "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); INSERT INTO actor_profiles VALUES('owner'),('other'); CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY)"
    )
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for name in (
        "114_one_action_directive_ledger.sql",
        "184_encrypted_one_adk_sessions.sql",
        "212_location_command_runtime.sql",
        "212_location_command_runtime.sql",
        "213_location_command_workflow_binding.sql",
        "213_location_command_workflow_binding.sql",
        "215_location_command_resource_receipt.sql",
        "215_location_command_resource_receipt.sql",
        "216_location_command_membership_receipts.sql",
        "217_location_command_effect_receipts.sql",
        "218_location_command_audience_receipts.sql",
        "216_location_command_membership_receipts.sql",
        "217_location_command_effect_receipts.sql",
        "218_location_command_audience_receipts.sql",
    ):
        database.execute_raw((migrations / name).read_text())
    yield database
    scoped.dispose()
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    engine.dispose()


async def ready(db, confirmation=True):
    ledger = ActionDirectiveStore(db=db, hmac_key="command-test-key")
    checkpoint = CommandCheckpointStore(
        db=db, cipher=AgentChatService(db=db, vault_key_hex="12" * 32)
    )
    state = await checkpoint.create(
        "owner",
        "command",
        {
            "status": "ready",
            "plan_digest": "plan",
            "next_step": 0,
            "step_count": 1,
            "step_digests": [],
            "capsule": {"ciphertext": "owner-encrypted-secret"},
        },
    )
    args = dict(
        user_id="owner",
        command_id="command",
        step=0,
        action={
            "action_id": "location.create_circle",
            "execution_policy": "confirm_required" if confirmation else "allow_direct",
            "command": {"result_resource": "circle"},
        },
        slots={"name": "Personal circle name"},
        context_revision="context",
        checkpoint_revision=state["revision"],
        plan_digest="plan",
        resource_binding={"target": "Alice"},
    )
    return ledger, checkpoint, state, args


async def nearby_command(db, monkeypatch):
    from hushh_mcp.services import location_command_effect_receipts as receipts
    from hushh_mcp.services import one_location_nearby_presence_service as nearby

    db.execute_raw(
        (
            Path(__file__).resolve().parents[2]
            / "db/migrations/126_one_location_nearby_presence.sql"
        ).read_text()
    )
    db.execute_raw("CREATE TABLE one_location_events(event_type TEXT)")
    db.execute_raw(
        (
            Path(__file__).resolve().parents[2] / "db/migrations/190_one_location_place_ratings.sql"
        ).read_text()
    )
    db.execute_raw(
        (
            Path(__file__).resolve().parents[2]
            / "db/migrations/219_location_presence_rating_visit.sql"
        ).read_text()
    )
    ledger, checkpoint, state, args = await ready(db)
    monkeypatch.setattr(receipts, "ActionDirectiveStore", lambda: ledger)
    monkeypatch.setattr(nearby, "get_db", lambda: db)
    args["action"] = {
        "action_id": "location.confirm_nearby_check_in",
        "execution_policy": "confirm_required",
    }
    args["slots"] = {}
    issued = await ledger.issue_command(**args)
    confirmation = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    terms = {
        "placeId": "provider-place",
        "durationMinutes": 60,
        "consentVersion": nearby.NEARBY_PRESENCE_CONSENT_VERSION,
        "allowConnectionRequests": False,
    }
    claimed = await ledger.claim_command(
        **args,
        confirmation_receipt=confirmation.receipt,
        effect_request_hmac=ledger._hmac([args["action"]["action_id"], terms]),
    )
    values = dict(
        user_id="owner",
        command_operation_id=claimed["operation_id"],
        place_id="provider-place",
        allow_connection_requests=False,
        consent_version=nearby.NEARBY_PRESENCE_CONSENT_VERSION,
        duration_minutes=60,
        radius_meters=500,
        anchor_envelope={
            "ciphertext": "synthetic-sealed-venue",
            "iv": "iv",
            "tag": "tag",
            "algorithm": "aes-256-gcm",
            "key_id": "fixture",
        },
        anchor_cell_epoch=1,
        anchor_cell_token="opaque-cell",  # noqa: S106 - synthetic spatial token
    )
    return nearby.PostgresNearbyPresenceStore(), values, ledger, claimed, receipts


async def nearby_checkout_command(db, monkeypatch, *, empty=False):
    store, check_in, ledger, _, receipts = await nearby_command(db, monkeypatch)
    check_in.pop("command_operation_id")
    row = None if empty else store.upsert_presence(**check_in)
    checkpoint = CommandCheckpointStore(
        db=db, cipher=AgentChatService(db=db, vault_key_hex="12" * 32)
    )
    state = await checkpoint.create(
        "owner",
        "checkout",
        {
            "status": "ready",
            "plan_digest": "checkout-plan",
            "next_step": 0,
            "step_count": 1,
            "step_digests": [],
            "capsule": {"ciphertext": "fixture"},
        },
    )
    args = dict(
        user_id="owner",
        command_id="checkout",
        step=0,
        action={"action_id": "location.checkout_nearby", "execution_policy": "confirm_required"},
        slots={},
        context_revision="context",
        checkpoint_revision=state["revision"],
        plan_digest="checkout-plan",
        resource_binding={},
    )
    issued = await ledger.issue_command(**args)
    confirmation = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id="location.checkout_nearby",
        context_revision="context",
        session_id="checkout",
        trusted_activation=True,
    )
    terms = {
        "presenceId": str(row["id"]) if row else None,
        "presenceVersion": row["version"] if row else 0,
    }
    claimed = await ledger.claim_command(
        **args,
        confirmation_receipt=confirmation.receipt,
        effect_request_hmac=ledger._hmac(["location.checkout_nearby", terms]),
    )
    checkout = dict(
        user_id="owner",
        command_operation_id=claimed["operation_id"],
        presence_id=terms["presenceId"],
        presence_version=terms["presenceVersion"],
    )
    return store, check_in, checkout, receipts


@pytest.mark.asyncio
async def test_checkout_retries_commit_once_and_cannot_end_a_newer_check_in(db, monkeypatch):
    store, check_in, checkout, _ = await nearby_checkout_command(db, monkeypatch)
    results = await asyncio.gather(
        *[asyncio.to_thread(store.checkout, **checkout) for _ in range(3)]
    )
    assert results[0] == results[1] == results[2]
    ended = db.execute_raw(
        "SELECT status,version,anchor_ciphertext FROM one_location_nearby_presences"
    ).data[0]
    assert ended == {"status": "checked_out", "version": 2, "anchor_ciphertext": None}
    newer = store.upsert_presence(**check_in)
    assert newer["version"] == 3
    # Receipts remain readable after authority expiry, without borrowing it for
    # a newer visit or mutating another domain such as the optional rating log.
    db.execute_raw("UPDATE one_action_directive_ledger SET expires_at=NOW()-INTERVAL '1 minute'")
    assert store.checkout(**checkout) == results[0]
    assert db.execute_raw("SELECT status,version FROM one_location_nearby_presences").data == [
        {"status": "active", "version": 3}
    ]


@pytest.mark.asyncio
async def test_checkout_receipt_failure_rolls_back_and_changed_presence_rejects(db, monkeypatch):
    store, check_in, checkout, receipts = await nearby_checkout_command(db, monkeypatch)
    save = receipts.CommandEffectReceipt.save

    def fail(*_args):
        raise RuntimeError("fixture receipt failure")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", fail)
    with pytest.raises(RuntimeError, match="fixture receipt"):
        store.checkout(**checkout)
    assert db.execute_raw("SELECT status,version FROM one_location_nearby_presences").data == [
        {"status": "active", "version": 1}
    ]
    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", save)
    store.upsert_presence(**check_in)
    with pytest.raises(ActionDirectiveAuthorityError, match="Nearby changed"):
        store.checkout(**checkout)
    with pytest.raises(ActionDirectiveAuthorityError):
        store.checkout(**{**checkout, "presence_version": 2})
    with pytest.raises(ActionDirectiveAuthorityError):
        store.checkout(**{**checkout, "user_id": "other"})
    assert db.execute_raw("SELECT status,version FROM one_location_nearby_presences").data == [
        {"status": "active", "version": 2}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("block", ["cancel", "expire", "new_check_in", "none"])
async def test_checkout_absent_presence_is_authoritative_and_never_clears_a_later_visit(
    db, monkeypatch, block
):
    store, check_in, checkout, _ = await nearby_checkout_command(db, monkeypatch, empty=True)
    if block == "cancel":
        db.execute_raw(
            "UPDATE one_adk_sessions SET command_status='cancelled' WHERE session_id='checkout'"
        )
    elif block == "expire":
        db.execute_raw(
            "UPDATE one_action_directive_ledger SET expires_at=NOW()-INTERVAL '1 minute'"
        )
    elif block == "new_check_in":
        store.upsert_presence(**check_in)
    if block != "none":
        with pytest.raises(ActionDirectiveAuthorityError):
            store.checkout(**checkout)
    else:
        receipt = store.checkout(**checkout)
        assert receipt["checked_out"] and receipt["presence_id"] is None
        store.upsert_presence(**check_in)
        assert store.checkout(**checkout) == receipt
    if block in {"new_check_in", "none"}:
        assert db.execute_raw("SELECT status,version FROM one_location_nearby_presences").data == [
            {"status": "active", "version": 1}
        ]


@pytest.mark.asyncio
async def test_nearby_effect_and_receipt_commit_once_under_concurrent_response_retries(
    db, monkeypatch
):
    store, values, ledger, claimed, _ = await nearby_command(db, monkeypatch)
    results = await asyncio.gather(
        *[asyncio.to_thread(store.upsert_presence, **values) for _ in range(3)]
    )
    assert len({result["_command_receipt"]["presence_id"] for result in results}) == 1
    assert sum(bool(result.get("_command_replayed")) for result in results) == 2
    assert db.execute_raw("SELECT version FROM one_location_nearby_presences").data == [
        {"version": 1}
    ]
    outcome = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    assert outcome["settlement_status"] == "succeeded"
    assert outcome["effect_receipt"]["operation_id"] == claimed["operation_id"]
    assert "provider-place" not in repr(
        db.execute_raw("SELECT * FROM one_action_directive_ledger").data
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        store.upsert_presence(**{**values, "allow_connection_requests": True})
    with pytest.raises(ActionDirectiveAuthorityError):
        store.upsert_presence(**{**values, "user_id": "other"})


@pytest.mark.asyncio
async def test_nearby_receipt_failure_rolls_back_presence_and_same_operation_can_retry(
    db, monkeypatch
):
    store, values, _, _, receipts = await nearby_command(db, monkeypatch)
    original = receipts.CommandEffectReceipt.save

    def lost_before_commit(*_args):
        raise RuntimeError("fixture crash before receipt")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", lost_before_commit)
    with pytest.raises(RuntimeError, match="fixture crash"):
        store.upsert_presence(**values)
    assert db.execute_raw("SELECT version FROM one_location_nearby_presences").data == []
    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", original)
    saved = store.upsert_presence(**values)
    assert saved["_command_receipt"]["version"] == 1
    assert store.upsert_presence(**values)["_command_replayed"] is True


@pytest.mark.asyncio
async def test_confirmation_renewal_and_concurrent_claim_are_one_time(db):
    ledger, _, _, args = await ready(db)
    issued = await ledger.issue_command(**args)
    receipt = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    unchanged = await ledger.issue_command(**args)
    assert unchanged["directive_id"] == issued["directive_id"]
    renewed = await ledger.issue_command(**args, renew=True)
    assert (
        renewed["directive_id"] != issued["directive_id"]
        and renewed["operation_id"] == issued["operation_id"]
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(**args, confirmation_receipt=receipt.receipt)
    receipt = await ledger.confirm(
        directive_id=renewed["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    outcomes = await asyncio.gather(
        *[ledger.claim_command(**args, confirmation_receipt=receipt.receipt) for _ in range(4)],
        return_exceptions=True,
    )
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    won = next(value for value in outcomes if isinstance(value, dict))
    await ledger.settle_command(
        user_id="owner",
        command_id="command",
        step=0,
        operation_id=won["operation_id"],
        execution_receipt=won["execution_receipt"],
        status="succeeded",
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(**args, confirmation_receipt=receipt.receipt)
    row = db.execute_raw("SELECT * FROM one_action_directive_ledger").data[0]
    assert "Personal circle name" not in repr(row) and "Alice" not in repr(row)


@pytest.mark.asyncio
async def test_cancel_and_replan_fences_and_owner_isolation(db):
    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    state = await checkpoints.update(
        "owner", "command", state["revision"], {**state, "plan_digest": "different"}, replan_from=0
    )
    assert await ledger.command_outcome(user_id="owner", command_id="command", step=0) is None
    assert await checkpoints.get("other", "command") is None
    cancelled = await checkpoints.update(
        "owner", "command", state["revision"], {**state, "status": "cancelled", "capsule": None}
    )
    assert cancelled["capsule"] is None
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.issue_command(**args)
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(**args)


@pytest.mark.asyncio
async def test_binding_change_invalidates_displayed_confirmation(db):
    ledger, _, _, args = await ready(db)
    first = await ledger.issue_command(**args)
    await ledger.issue_command(**{**args, "resource_binding": {"target": "Bob"}})
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.confirm(
            directive_id=first["directive_id"],
            user_id="owner",
            action_id=args["action"]["action_id"],
            context_revision="context",
            session_id="command",
            trusted_activation=True,
        )


@pytest.mark.asyncio
async def test_transactional_cancel_commits_without_returning_rows(db, monkeypatch):
    from hushh_mcp.services import location_command_workflow as workflow

    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    monkeypatch.setattr(workflow, "get_db", lambda: db)
    saved = await workflow.cancel_bound_command(
        user_id="owner",
        command_id="command",
        state=state,
        cipher=checkpoints.cipher,
    )
    assert saved["status"] == "cancelled" and saved["capsule"] is None
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "state"
    ] == "cancelled"
    assert (await checkpoints.get("owner", "command"))["status"] == "cancelled"
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(**args)


@pytest.mark.asyncio
async def test_one_workflow_binding_rolls_back_a_second_claim(db):
    from sqlalchemy.exc import IntegrityError

    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    db.execute_raw("""CREATE TABLE one_capability_runs(run_id TEXT PRIMARY KEY,
        user_id TEXT, capability_id TEXT, capability_version INT)""")
    run_id = "run_" + "a" * 32
    db.execute_raw(
        "INSERT INTO one_capability_runs VALUES(:run,'owner','workflow.setup.location',2)",
        {"run": run_id},
    )
    args["action"] = {
        "action_id": "workflow.setup.location",
        "execution_policy": "allow_direct",
        "_command_effect": "workflow",
    }
    args["slots"] = {}
    await ledger.issue_command(**args)
    with db.engine.begin() as connection:
        bound = ActionDirectiveStore(connection=connection, hmac_key="command-test-key")
        await bound.claim_command(**args)
        await bound.bind_command_workflow(
            user_id="owner", command_id="command", step=0, run_id=run_id
        )
    second = await checkpoints.create(
        "owner",
        "second",
        {key: value for key, value in state.items() if key not in {"command_id", "revision"}},
    )
    other_args = {**args, "command_id": "second", "checkpoint_revision": second["revision"]}
    await ledger.issue_command(**other_args)
    with pytest.raises(IntegrityError):
        with db.engine.begin() as connection:
            bound = ActionDirectiveStore(connection=connection, hmac_key="command-test-key")
            await bound.claim_command(**other_args)
            await bound.bind_command_workflow(
                user_id="owner", command_id="second", step=0, run_id=run_id
            )
    assert (await ledger.command_outcome(user_id="owner", command_id="second", step=0))[
        "state"
    ] == "issued"
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "workflow_run_id"
    ] == run_id


@pytest.mark.asyncio
async def test_expiry_removes_sensitive_capsule_and_rollback_preserves_receipts(db):
    ledger, checkpoints, _, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    db.execute_raw("UPDATE one_adk_sessions SET created_at=NOW()-INTERVAL '25 hours'")
    assert await checkpoints.get("owner", "command") is None
    assert db.execute_raw("SELECT * FROM one_adk_sessions").data == []
    assert await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    rollback = (
        Path(__file__).resolve().parents[2]
        / "db/migrations/rollback/212_location_command_runtime.rollback.sql"
    )
    db.execute_raw(rollback.read_text())
    assert len(db.execute_raw("SELECT * FROM one_command_receipts_212_archive").data) == 1


@pytest.mark.asyncio
async def test_effect_and_receipt_commit_or_rollback_together(db, monkeypatch):
    from hushh_mcp.services import location_command_execution as command_execution

    ledger, _, _, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    db.execute_raw("CREATE TABLE command_test_effect(id TEXT PRIMARY KEY)")
    monkeypatch.setattr(command_execution, "get_db", lambda: db)
    # The worker's bound ledger must use the same signing authority as admission.
    monkeypatch.setattr(
        command_execution,
        "ActionDirectiveStore",
        lambda **kw: ActionDirectiveStore(hmac_key="command-test-key", **kw),
    )

    def failing(connection, _user, _slots):
        connection.execute(text("INSERT INTO command_test_effect VALUES('one')"))
        raise RuntimeError("injected failure before receipt")

    monkeypatch.setitem(command_execution.BACKEND_BINDINGS, "location.create_circle", failing)
    with pytest.raises(RuntimeError):
        await command_execution.execute_atomic(binding="location.create_circle", authority=args)
    assert db.execute_raw("SELECT * FROM command_test_effect").data == []
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "state"
    ] == "issued"
    created_id = str(uuid4())

    def succeeded(conn, user, slots):
        conn.execute(text("INSERT INTO command_test_effect VALUES('one')"))
        return {"kind": "circle", "id": created_id}

    monkeypatch.setitem(command_execution.BACKEND_BINDINGS, "location.create_circle", succeeded)
    outcomes = await asyncio.gather(
        *[
            command_execution.execute_atomic(binding="location.create_circle", authority=args)
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    assert db.execute_raw("SELECT * FROM command_test_effect").data == [{"id": "one"}]
    receipts = await ledger.command_results(user_id="owner", command_id="command")
    assert len(receipts) == 1 and receipts[0]["id"] == created_id
    assert await ledger.command_results(user_id="other", command_id="command") == []
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "state"
    ] == "settled"


@pytest.mark.asyncio
async def test_saving_a_capsule_cannot_unlock_an_admitted_plan_for_replacement(db):
    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    state = await checkpoints.update(
        "owner", "command", state["revision"], state, preserve_admission=True
    )
    assert (
        db.execute_raw("SELECT command_status FROM one_adk_sessions").data[0]["command_status"]
        == "admitted"
    )
    args["checkpoint_revision"] = state["revision"]
    await ledger.claim_command(**args)
    with pytest.raises(CommandCheckpointConflict):
        await checkpoints.update(
            "owner",
            "command",
            state["revision"],
            {**state, "plan_digest": "replacement"},
            replan_from=0,
        )


@pytest.mark.asyncio
async def test_claim_and_replan_have_exactly_one_winner(db):
    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    results = await asyncio.gather(
        ledger.claim_command(**args),
        checkpoints.update(
            "owner", "command", state["revision"], {**state, "plan_digest": "new"}, replan_from=0
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(result, dict) for result in results) == 1
    outcome = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    if isinstance(results[0], dict):
        assert outcome["state"] == "consumed"
        assert (await checkpoints.get("owner", "command"))["plan_digest"] == "plan"
    else:
        assert outcome is None
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.claim_command(**args)


@pytest.mark.asyncio
async def test_replan_preserves_receipt_even_if_legacy_status_was_cancelled(db):
    ledger, checkpoints, state, args = await ready(db, confirmation=False)
    await ledger.issue_command(**args)
    await ledger.claim_command(**args)
    db.execute_raw("UPDATE one_action_directive_ledger SET state='cancelled'")
    with pytest.raises(CommandCheckpointConflict):
        await checkpoints.update(
            "owner", "command", state["revision"], {**state, "plan_digest": "new"}, replan_from=0
        )
    assert db.execute_raw("SELECT execution_receipt_hash FROM one_action_directive_ledger").data[0][
        "execution_receipt_hash"
    ]


@pytest.mark.asyncio
async def test_replan_revokes_old_confirmation_and_rolls_back_deleted_authority_on_failure(db):
    ledger, checkpoints, state, args = await ready(db)
    issued = await ledger.issue_command(**args)
    receipt = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    db.execute_raw("""CREATE FUNCTION reject_test_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_plan_hmac='injected-failure' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON one_adk_sessions FOR EACH ROW EXECUTE FUNCTION reject_test_checkpoint()""")
    with pytest.raises(RuntimeError):
        await checkpoints.update(
            "owner",
            "command",
            state["revision"],
            {**state, "plan_digest": "injected-failure"},
            replan_from=0,
        )
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "directive_id"
    ] == issued["directive_id"]
    state = await checkpoints.update(
        "owner",
        "command",
        state["revision"],
        {**state, "plan_digest": "replacement"},
        replan_from=0,
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await ledger.claim_command(**args, confirmation_receipt=receipt.receipt)
    next_args = {**args, "plan_digest": "replacement", "checkpoint_revision": state["revision"]}
    renewed = await ledger.issue_command(**next_args)
    assert renewed["directive_id"] != issued["directive_id"]
    assert renewed["operation_id"] == issued["operation_id"]


def test_circle_service_reuses_same_name_inside_owning_transaction(db):
    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    db.execute_raw("""CREATE TABLE one_location_circles(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT, name TEXT, kind TEXT, status TEXT, member_limit INT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, metadata JSONB);
        CREATE TABLE one_location_circle_memberships(circle_id UUID, user_id TEXT, role TEXT, status TEXT, joined_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, metadata JSONB)""")
    service = OneLocationCircleService(db=db)
    with db.engine.begin() as conn:
        first = service.create_circle_in_transaction(
            conn, owner_user_id="owner", name="Family", reuse_existing=True
        )
    with db.engine.begin() as conn:
        second = service.create_circle_in_transaction(
            conn, owner_user_id="owner", name=" family ", reuse_existing=True
        )
    assert first == second
    assert len(db.execute_raw("SELECT id FROM one_location_circles").data) == 1


def test_request_receipt_survives_approval_and_rolls_back_with_effect(db):
    from contextlib import contextmanager

    from hushh_mcp.services.one_location_agent_service import (
        OneLocationAgentError,
        OneLocationAgentService,
    )

    db.execute_raw("""CREATE TABLE one_location_access_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT, requester_user_id TEXT,
      referred_by_user_id TEXT, status TEXT, message TEXT, requested_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, metadata JSONB,
      requested_duration_hours DOUBLE PRECISION, requested_duration_mode TEXT,
      extends_grant_id UUID, approved_grant_id UUID, request_revision INT)""")

    class Service(OneLocationAgentService):
        def __init__(self):
            self.fail_event = False

        @contextmanager
        def _event_bound_writer(self):
            with db.engine.begin() as connection:
                self.connection = connection
                yield

        def _execute_one(self, sql, params=None):
            row = self.connection.execute(text(sql), params or {}).mappings().first()
            return dict(row) if row else None

        def _active_grant_between(self, **kwargs):
            return None

        def _repair_legacy_direct_request_deadlines(self, _owner):
            pass

        def _identity_row(self, _user):
            return None

        def _insert_event(self, **kwargs):
            if self.fail_event:
                raise RuntimeError("event rejected")

    service = Service()
    args = dict(
        requester_user_id="other",
        owner_user_id="owner",
        requested_duration_hours=1,
        requested_duration_mode="timed",
        client_operation_id="command-operation",
        notify_owner=False,
    )
    first = service.request_access(**args)
    db.execute_raw("UPDATE one_location_access_requests SET status='approved',resolved_at=NOW()")
    replay = service.request_access(**args)
    assert replay["id"] == first["id"] and replay["status"] == "approved"
    assert len(db.execute_raw("SELECT id FROM one_location_access_requests").data) == 1
    with pytest.raises(OneLocationAgentError):
        service.request_access(**{**args, "requested_duration_hours": 2})
    service.fail_event = True
    with pytest.raises(RuntimeError):
        service.request_access(**{**args, "client_operation_id": "second"})
    rows = db.execute_raw("SELECT metadata FROM one_location_access_requests").data
    assert len(rows) == 1 and "second" not in rows[0]["metadata"]["command_operations"]


@pytest.mark.asyncio
@pytest.mark.parametrize("already_member", [False, True])
async def test_membership_batches_are_atomic_owner_bound_and_recoverable(
    db, monkeypatch, already_member
):
    from hushh_mcp.services import location_command_membership_receipts as batches

    ledger, checkpoint, state, args = await ready(db, confirmation=False)
    args["action"] = {"action_id": "location.add_to_circle", "execution_policy": "allow_direct"}
    import hashlib
    import json

    circle_id = str(uuid4())
    binding_json = json.dumps(
        {
            "owner": "owner",
            "circleId": circle_id,
            "circleName": "Circle",
            "people": [{"userId": "person-a", "displayName": "Person A", "member": False}],
            "sourceReceipt": None,
        }
    )
    preparation = batches.MembershipPreparation(nonce="ab" * 32, binding_json=binding_json)
    digest = hashlib.sha256(f"{preparation.nonce}:{binding_json}".encode()).hexdigest()
    args["resource_binding"] = {"digest": digest}
    plan = batches.prepare_membership_plan(
        preparation, owner="owner", binding_digest=digest, store=ledger
    )
    await ledger.issue_command(**args)
    claim = await ledger.claim_command(**args, membership_plan=plan)
    operation = claim["operation_id"]
    monkeypatch.setattr(batches, "ActionDirectiveStore", lambda: ledger)
    db.execute_raw("CREATE TABLE batch_effects(member TEXT PRIMARY KEY)")
    options = dict(
        owner="owner", operation_id=operation, batch=0, circle_id=circle_id, people=["person-a"]
    )

    def apply(fail=False, **changed):
        with db.engine.begin() as conn:
            receipt = batches.MembershipBatchReceipt(conn, **{**options, **changed})
            prior = receipt.claim()
            if prior is not None:
                return prior
            conn.execute(text("INSERT INTO batch_effects VALUES('person-a')"))
            result = (
                {
                    "addedUserIds": [],
                    "skippedUserIds": ["person-a"],
                    "skippedReasons": {"person-a": "already_member"},
                }
                if already_member
                else {"addedUserIds": ["person-a"], "skippedUserIds": [], "skippedReasons": {}}
            )
            receipt.save(result)
            if fail:
                raise RuntimeError("injected lost commit")
            return result

    with pytest.raises(RuntimeError):
        apply(fail=True)
    assert db.execute_raw("SELECT * FROM batch_effects").data == []
    assert apply() == apply()  # Repeat retrieves receipt, never repeats INSERT.
    assert len(db.execute_raw("SELECT * FROM batch_effects").data) == 1
    with pytest.raises(ActionDirectiveAuthorityError):
        apply(owner="other")
    with pytest.raises(ActionDirectiveAuthorityError):
        apply(people=["person-b"])
    with pytest.raises(ActionDirectiveAuthorityError):
        apply(circle_id=str(uuid4()))
    assert await ledger.reconcile_membership_command(user_id="owner", command_id="command", step=0)
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "settlement_status"
    ] == "succeeded"
    db.execute_raw("UPDATE one_adk_sessions SET command_status='cancelled'")
    with pytest.raises(ActionDirectiveAuthorityError):
        apply(batch=1, batch_count=2)


def sms_schema(db):
    """Real Circle migrations; adjacent tables expose their consumed columns."""
    db.execute_raw("""
        CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY, display_name TEXT, email TEXT,
            custom_photo_url TEXT, photo_url TEXT);
        INSERT INTO actor_identity_cache VALUES('owner','Owner',NULL,NULL,NULL),('other','Contact',NULL,NULL,NULL);
        CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id TEXT, user_b_id TEXT,
            status TEXT, source TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ, UNIQUE(user_a_id,user_b_id));
        CREATE TABLE connection_requests(requester_user_id TEXT,addressee_user_id TEXT,status TEXT,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,metadata JSONB);
        INSERT INTO connections(user_a_id,user_b_id,status,source) VALUES('owner','other','active','request');
        CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT,
            recipient_user_id TEXT, status TEXT, updated_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
        CREATE TABLE one_location_events(id UUID DEFAULT gen_random_uuid(),owner_user_id TEXT,actor_user_id TEXT,
            recipient_user_id TEXT,event_type TEXT,metadata JSONB);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for name in (
        "116_one_location_sms_contacts.sql",
        "134_one_location_named_circles.sql",
        "135_one_location_circle_connection_origins.sql",
        "136_one_location_circle_member_invites.sql",
        "160_one_location_system_circles.sql",
        "163_one_location_system_circle_kinds.sql",
    ):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(
                (migrations / name).read_text(), execution_options={"no_parameters": True}
            )


@pytest.mark.asyncio
async def test_emergency_roster_receipt_and_feed_commit_once_and_removal_cannot_resurrect(
    db, monkeypatch
):
    from hushh_mcp.services import location_command_effect_receipts as receipts
    from hushh_mcp.services import one_location_agent_service as agents
    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    sms_schema(db)
    ledger, _, _, args = await ready(db)
    monkeypatch.setattr(receipts, "ActionDirectiveStore", lambda: ledger)
    monkeypatch.setattr(agents, "get_db", lambda: db)
    args["action"] = {
        "action_id": "location.add_emergency_contact",
        "execution_policy": "confirm_required",
    }
    args["slots"] = {}
    issued = await ledger.issue_command(**args)
    confirmation = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    claimed = await ledger.claim_command(
        **args,
        confirmation_receipt=confirmation.receipt,
        effect_request_hmac=ledger._hmac([args["action"]["action_id"], {"recipientId": "other"}]),
    )
    circles = OneLocationCircleService(db=db)
    values = dict(
        owner_user_id="owner",
        contact_user_id="other",
        added=True,
        operation_id=claimed["operation_id"],
    )
    original = receipts.CommandEffectReceipt.save

    def crash(*_args):
        raise RuntimeError("fixture crash before emergency receipt")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", crash)
    with pytest.raises(RuntimeError, match="fixture crash"):
        circles.set_sms_contact(**values)
    for table in (
        "one_location_circle_memberships",
        "one_location_sms_contacts",
        "one_location_events",
    ):
        assert db.execute_raw(f"SELECT * FROM {table}").data == []
    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", original)
    results = await asyncio.gather(
        *[asyncio.to_thread(circles.set_sms_contact, **values) for _ in range(3)]
    )
    assert sum(result["changed"] for result in results) == 1
    roster = agents.OneLocationAgentService()
    assert roster.list_sms_contact_ids(owner_user_id="owner") == ["other"]
    assert db.execute_raw(
        "SELECT recipient_user_id,event_type,metadata FROM one_location_events"
    ).data == [
        {
            "recipient_user_id": "other",
            "event_type": "location_sms_contact_added",
            "metadata": {"owner_label": "Owner", "counterpart_label": "Contact"},
        }
    ]
    assert circles.set_sms_contact(owner_user_id="owner", contact_user_id="other", added=False)[
        "changed"
    ]
    assert roster.list_sms_contact_ids(owner_user_id="owner") == []
    # Stale compatibility writes cannot override a removed membership.
    db.execute_raw(
        "INSERT INTO one_location_sms_contacts(owner_user_id,contact_user_id) VALUES('owner','other')"
    )
    assert roster.list_sms_contact_ids(owner_user_id="owner") == []
    assert not roster._is_sms_contact(owner_user_id="owner", contact_user_id="other")
    assert not circles.set_sms_contact(owner_user_id="owner", contact_user_id="other", added=False)[
        "changed"
    ]
    assert db.execute_raw(
        "SELECT event_type FROM one_location_events ORDER BY event_type"
    ).data == [
        {"event_type": "location_sms_contact_added"},
        {"event_type": "location_sms_contact_removed"},
    ]
    assert db.execute_raw("SELECT status FROM connections").data == [{"status": "active"}]
    assert db.execute_raw("SELECT origin_kind FROM connection_origins").data == [
        {"origin_kind": "direct_request"}
    ]
    # Reconcile an old committed add without executing it after a later removal.
    assert not circles.set_sms_contact(**values)["changed"]
    assert roster.list_sms_contact_ids(owner_user_id="owner") == []


@pytest.mark.asyncio
async def test_audience_fence_rejects_changed_terms_and_commits_receipt_once(db, monkeypatch):
    from hushh_mcp.services import location_command_audience_receipts as audience

    ledger, checkpoints, state, args = await ready(db)
    monkeypatch.setattr(audience, "ActionDirectiveStore", lambda: ledger)
    args["action"] = {
        "action_id": "location.share_selected",
        "execution_policy": "confirm_required",
    }
    args["slots"] = {}
    terms = audience.audience_terms(
        recipient="other", duration=2, mode="timed", message="Meet here", key="key", circle=None
    )
    plan = {
        ledger._hmac("other"): {
            "terms": ledger._hmac(["location.share_selected", terms]),
            "replacements": ledger._hmac([]),
        }
    }
    issued = await ledger.issue_command(**args)
    receipt = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=args["action"]["action_id"],
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    claimed = await ledger.claim_command(
        **args, confirmation_receipt=receipt.receipt, audience_plan=plan
    )
    options = dict(
        owner="owner",
        operation=claimed["operation_id"],
        action="location.share_selected",
        terms=terms,
    )
    db.execute_raw("CREATE TABLE audience_effect(id TEXT PRIMARY KEY)")

    def effect(**changed):
        with db.engine.begin() as conn:
            guard = audience.CommandAudienceReceipt(conn, **{**options, **changed})
            prior = guard.claim()
            if prior:
                return prior
            guard.verify_replacements([])
            conn.execute(text("INSERT INTO audience_effect VALUES('one')"))
            guard.save("one")

    for changed in (
        {"owner": "other"},
        {"terms": {**terms, "recipient": "unreviewed"}},
        {"terms": {**terms, "hours": 4.0}},
        {"terms": {**terms, "message": "Different"}},
    ):
        with pytest.raises(ActionDirectiveAuthorityError):
            effect(**changed)
    with db.engine.begin() as conn:
        guard = audience.CommandAudienceReceipt(conn, **options)
        guard.claim()
        with pytest.raises(ActionDirectiveAuthorityError):
            guard.verify_replacements([{"id": "new-share", "durationMode": "until_stopped"}])
    assert db.execute_raw("SELECT * FROM audience_effect").data == []
    original = audience.CommandAudienceReceipt.save

    def crash(*_args):
        raise RuntimeError("fixture crash")

    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", crash)
    with pytest.raises(RuntimeError):
        effect()
    assert db.execute_raw("SELECT * FROM audience_effect").data == []
    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", original)
    await asyncio.gather(*[asyncio.to_thread(effect) for _ in range(3)])
    assert db.execute_raw("SELECT * FROM audience_effect").data == [{"id": "one"}]
    outcome = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    assert outcome["settlement_status"] == "succeeded"
    assert len(outcome["audience_receipts"]) == 1
    assert "Meet here" not in repr(outcome) and '"other"' not in json_text(outcome["audience_plan"])


def json_text(value):
    import json

    return json.dumps(value)


def audience_writer_schema(db, monkeypatch):
    """Execute domain writers against real Location migrations and SQL tables."""
    from contextlib import contextmanager

    from hushh_mcp.services import one_location_agent_service as agents

    db.execute_raw("""CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,
        phone_number TEXT,phone_verified BOOLEAN,email TEXT,custom_photo_url TEXT,photo_url TEXT);
        INSERT INTO actor_identity_cache(user_id,display_name,phone_verified) VALUES('owner','Owner',TRUE),('other','Contact',TRUE),('third','Third',TRUE);
        CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_a_id TEXT,user_b_id TEXT,status TEXT,source TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),revoked_at TIMESTAMPTZ,UNIQUE(user_a_id,user_b_id));
        INSERT INTO connections(user_a_id,user_b_id,status,source) VALUES('owner','other','active','request'),('owner','third','active','request');
        CREATE TABLE connection_requests(requester_user_id TEXT,addressee_user_id TEXT,status TEXT,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,metadata JSONB);
        CREATE TABLE one_location_public_invite_submissions(request_id UUID);
        CREATE TABLE feed_events(user_id TEXT,source_domain TEXT,event_type TEXT,metadata JSONB,source_row_id TEXT);
    """)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for prefix in (61, 115, 116, 134, 135, 150, 154, 160, 163, 191):
        with db.engine.begin() as connection:
            connection.exec_driver_sql(
                next(migrations.glob(f"{prefix:03d}_*.sql")).read_text(),
                execution_options={"no_parameters": True},
            )
    db.execute_raw("""INSERT INTO one_location_recipient_keys(user_id,key_id,public_key_jwk)
        VALUES('other','key','{"kty":"EC"}'),('third','key-3','{"kty":"EC"}');""")

    @contextmanager
    def connection():
        with db.engine.begin() as conn:
            yield conn

    monkeypatch.setattr(agents, "get_db", lambda: db)
    monkeypatch.setattr(agents, "get_db_connection", connection)
    # Cryptographic token issuance and push transport are outside the SQL writer.
    monkeypatch.setattr(
        agents.OneLocationAgentService,
        "_mint_grant_capability_token",
        lambda *_args, **_kwargs: {"token": "fixture-capability"},
    )
    monkeypatch.setattr(
        agents.OneLocationAgentService,
        "_send_location_share_created_notification",
        lambda *_args, **_kwargs: None,
    )
    return agents.OneLocationAgentService


async def admit_audience(db, monkeypatch, action, people, message="Meet here"):
    from hushh_mcp.services import location_command_audience_receipts as audience

    ledger, checkpoint, state, args = await ready(db)
    monkeypatch.setattr(audience, "ActionDirectiveStore", lambda: ledger)
    args["action"] = {"action_id": action, "execution_policy": "confirm_required"}
    args["slots"] = {}
    plan = {}
    for person, key in people:
        terms = audience.audience_terms(
            recipient=person, duration=2, mode="timed", message=message, key=key
        )
        plan[ledger._hmac(person)] = {
            "terms": ledger._hmac([action, terms]),
            "replacements": ledger._hmac([]),
        }
    issued = await ledger.issue_command(**args)
    receipt = await ledger.confirm(
        directive_id=issued["directive_id"],
        user_id="owner",
        action_id=action,
        context_revision="context",
        session_id="command",
        trusted_activation=True,
    )
    claimed = await ledger.claim_command(
        **args, confirmation_receipt=receipt.receipt, audience_plan=plan
    )
    return ledger, checkpoint, claimed


@pytest.mark.asyncio
@pytest.mark.parametrize("share_kind", ["share", "check_in"])
async def test_actual_private_share_commits_ciphertext_events_and_audience_receipt_once(
    db, monkeypatch, share_kind
):
    from datetime import UTC, datetime

    from hushh_mcp.services import location_command_audience_receipts as audience

    Service = audience_writer_schema(db, monkeypatch)
    action = "location.share_selected" if share_kind == "share" else "location.send_check_in"
    message = "Meet here" if share_kind == "share" else "check_in"
    ledger, _, claimed = await admit_audience(
        db, monkeypatch, action, [("other", "key")], message=message
    )
    now = datetime.now(UTC)
    args = dict(
        owner_user_id="owner",
        recipient_user_id="other",
        recipient_key_id="key",
        duration_hours=2,
        duration_mode="timed",
        reason=message,
        share_kind=share_kind,
        enforce_connection=True,
        client_operation_id=claimed["operation_id"],
        command_operation_id=claimed["operation_id"],
        confirmed_at=now,
        envelope={
            "algorithm": "ECDH-P256-AES256-GCM",
            "recipientKeyId": "key",
            "ciphertext": "synthetic-ciphertext",
            "iv": "fixture-iv",
            "senderEphemeralPublicKeyJwk": {"kty": "EC"},
            "capturedAt": now.isoformat(),
            "sourcePlatform": "web",
            "metadata": {"plaintext": False},
        },
    )
    original = audience.CommandAudienceReceipt.save

    def crash(*_args):
        raise RuntimeError("fixture failure before receipt")

    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", crash)
    with pytest.raises(RuntimeError, match="fixture failure"):
        Service().create_grant_with_initial_envelope(**args)
    for table in ("one_location_share_grants", "one_location_envelopes", "one_location_events"):
        assert db.execute_raw(f"SELECT * FROM {table}").data == []
    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", original)
    results = await asyncio.gather(
        *[asyncio.to_thread(Service().create_grant_with_initial_envelope, **args) for _ in range(3)]
    )
    assert len({result["grant"]["id"] for result in results}) == 1
    assert sum(not result["idempotentReplay"] for result in results) == 1
    assert all(
        result["grant"]["latestEnvelopeId"] == result["envelope"]["id"] for result in results
    )
    assert len(db.execute_raw("SELECT * FROM one_location_share_grants").data) == 1
    assert len(db.execute_raw("SELECT * FROM one_location_envelopes").data) == 1
    assert len(db.execute_raw("SELECT * FROM one_location_events").data) == 2
    outcome = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    assert outcome["settlement_status"] == "succeeded"
    # Dropping the command marker cannot change the effect's reviewed kind.
    with pytest.raises(Exception, match="kind of share"):
        Service().create_grant_with_initial_envelope(
            **{**args, "command_operation_id": None, "share_kind": "sos"}
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("retirement", ["cancel", "expire"])
async def test_actual_requests_preserve_partial_audience_on_cancel_and_retry_after_approval(
    db, monkeypatch, retirement
):
    Service = audience_writer_schema(db, monkeypatch)
    ledger, _, claimed = await admit_audience(
        db, monkeypatch, "location.send_request", [("other", None), ("third", None)]
    )
    args = dict(
        requester_user_id="owner",
        owner_user_id="other",
        requested_duration_hours=2,
        requested_duration_mode="timed",
        message="Meet here",
        client_operation_id=claimed["operation_id"],
        command_operation_id=claimed["operation_id"],
        notify_owner=False,
    )
    service = Service()
    first = service.request_access(**args)
    outcome = await ledger.command_outcome(user_id="owner", command_id="command", step=0)
    assert outcome["state"] == "consumed" and len(outcome["audience_receipts"]) == 1
    db.execute_raw("UPDATE one_location_access_requests SET status='approved',resolved_at=NOW()")
    db.execute_raw(
        "UPDATE one_adk_sessions SET command_status='cancelled'"
        if retirement == "cancel"
        else "UPDATE one_action_directive_ledger SET expires_at=NOW()-INTERVAL '1 second'"
    )
    replay = Service().request_access(**args)
    assert replay["id"] == first["id"] and replay["status"] == "approved"
    with pytest.raises(ActionDirectiveAuthorityError):
        Service().request_access(**{**args, "owner_user_id": "third", "command_operation_id": None})
    assert len(db.execute_raw("SELECT * FROM one_location_access_requests").data) == 1
    assert len(db.execute_raw("SELECT * FROM one_location_events").data) == 1
    assert len(db.execute_raw("SELECT * FROM feed_events").data) == 1
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "state"
    ] == "consumed"


@pytest.mark.asyncio
async def test_request_command_clears_unreviewed_prior_note_and_rolls_back_on_receipt_failure(
    db, monkeypatch
):
    from hushh_mcp.services import location_command_audience_receipts as audience

    Service = audience_writer_schema(db, monkeypatch)
    args = dict(
        requester_user_id="owner",
        owner_user_id="other",
        requested_duration_hours=2,
        requested_duration_mode="timed",
        notify_owner=False,
    )
    prior = Service().request_access(**args, message="An older note")
    ledger, _, claimed = await admit_audience(
        db, monkeypatch, "location.send_request", [("other", None)], message=None
    )
    command_args = {
        **args,
        "command_operation_id": claimed["operation_id"],
        "client_operation_id": claimed["operation_id"],
    }
    original = audience.CommandAudienceReceipt.save

    def crash(*_args):
        raise RuntimeError("request receipt failure")

    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", crash)
    with pytest.raises(RuntimeError, match="request receipt failure"):
        Service().request_access(**command_args)
    assert db.execute_raw("SELECT message FROM one_location_access_requests").data == [
        {"message": "An older note"}
    ]
    monkeypatch.setattr(audience.CommandAudienceReceipt, "save", original)
    result = Service().request_access(**command_args)
    assert result["id"] == prior["id"] and not result["message"]
    assert db.execute_raw("SELECT message FROM one_location_access_requests").data == [
        {"message": None}
    ]
    assert (await ledger.command_outcome(user_id="owner", command_id="command", step=0))[
        "settlement_status"
    ] == "succeeded"


@pytest.mark.asyncio
async def test_sos_incident_guard_serialises_concurrent_arming_to_one_incident(db, monkeypatch):
    """Three arming attempts that race must yield one alert, not three.

    Each attempt does what the voice trigger does: take the owner's incident
    lock, re-read the live SOS lane, and only then create one grant per
    contact. Without the lock all three read "nothing live" and the per-pair
    lane replacement would leave a trail of revoked rows (and revoke pushes).
    """
    from hushh_mcp.services import one_location_agent_service as agents

    Service = audience_writer_schema(db, monkeypatch)
    db.execute_raw(
        "INSERT INTO actor_profiles(user_id) VALUES('third') ON CONFLICT DO NOTHING;"
        "INSERT INTO one_location_sms_contacts(owner_user_id,contact_user_id) "
        "VALUES('owner','other'),('owner','third');"
        "ALTER TABLE actor_profiles ADD COLUMN IF NOT EXISTS public_person_ref TEXT;"
        "CREATE TABLE IF NOT EXISTS ria_profiles(user_id TEXT, verification_status TEXT);"
        # Eligibility for the recipients read is a direct connection with a
        # non-Circle origin, as the real connections graph records it.
        "INSERT INTO connection_origins(connection_id, origin_kind, origin_key) "
        "SELECT id, 'direct_request', 'direct_request' FROM connections "
        "WHERE user_a_id = 'owner' ON CONFLICT DO NOTHING"
    )
    service = Service()
    # The roster-scoped recipients read the voice trigger uses: the real SQL
    # branch with the IN (...) filter, both contacts with their keys, and a
    # non-roster id never admitted.
    rows = service.list_verified_recipients(
        owner_user_id="owner", limit=100, user_ids=["other", "third", "stranger"]
    )
    assert sorted((row["userId"], row["keyId"], row["phoneVerified"]) for row in rows) == [
        ("other", "key", True),
        ("third", "key-3", True),
    ]
    assert service.list_verified_recipients(owner_user_id="owner", user_ids=[]) == []
    contacts = tuple(
        (row["userId"], row["keyId"]) for row in sorted(rows, key=lambda r: r["userId"])
    )

    def arm_once() -> str:
        with service.sos_incident_guard(owner_user_id="owner"):
            live = [
                grant
                for grant in service.list_active_owner_grants(owner_user_id="owner")
                if str(grant.get("shareKind") or "") == "sos" and grant.get("status") == "active"
            ]
            if live:
                return "already_active"
            for recipient, key in contacts:
                service.create_grant(
                    owner_user_id="owner",
                    recipient_user_id=recipient,
                    recipient_key_id=key,
                    duration_hours=8,
                    duration_mode="timed",
                    reason="sos_panic",
                    share_kind="sos",
                    require_recipient_phone_verified=True,
                    enforce_connection=False,
                )
            return "armed"

    outcomes = await asyncio.gather(*[asyncio.to_thread(arm_once) for _ in range(3)])
    assert sorted(outcomes) == ["already_active", "already_active", "armed"]
    rows = db.execute_raw(
        "SELECT recipient_user_id, status FROM one_location_share_grants ORDER BY recipient_user_id"
    ).data
    assert rows == [
        {"recipient_user_id": "other", "status": "active"},
        {"recipient_user_id": "third", "status": "active"},
    ]
    # A later explicit alert after this one ends is still possible: the lock
    # serialises, it never becomes a cooldown.
    for grant in service.list_active_owner_grants(owner_user_id="owner"):
        service.revoke_grant(owner_user_id="owner", grant_id=str(grant["id"]))
    assert arm_once() == "armed"
    assert (
        len(db.execute_raw("SELECT 1 FROM one_location_share_grants WHERE status = 'active'").data)
        == 2
    )
    assert agents.OneLocationAgentService is Service
