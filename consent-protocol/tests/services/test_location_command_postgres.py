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
        },
        slots={"name": "Personal circle name"},
        context_revision="context",
        checkpoint_revision=state["revision"],
        plan_digest="plan",
        resource_binding={"target": "Alice"},
    )
    return ledger, checkpoint, state, args


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
    monkeypatch.setitem(
        command_execution.BACKEND_BINDINGS,
        "location.create_circle",
        lambda conn, user, slots: conn.execute(
            text("INSERT INTO command_test_effect VALUES('one')")
        ),
    )
    outcomes = await asyncio.gather(
        *[
            command_execution.execute_atomic(binding="location.create_circle", authority=args)
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    assert db.execute_raw("SELECT * FROM command_test_effect").data == [{"id": "one"}]
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
