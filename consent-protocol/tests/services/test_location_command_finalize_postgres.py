"""Real v5 authority/receipt transactions and encrypted PKM preservation.

The bounded failure adapter isolates authority failures; encrypted_pkm replaces
it with the authored v4/v3/v2 writer and process-local synthetic encryption.
Each test owns a disposable database. Neither fixture proves physical OS/UI behavior.
"""

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore
from hushh_mcp.services.agent_chat_service import AgentChatService
from hushh_mcp.services.capability_run_service import CapabilityRunStore
from hushh_mcp.services.command_checkpoints import CommandCheckpointStore
from hushh_mcp.services.location_onboarding_runtime import (
    LOCATION_APPROVED_SURFACE_CONTRACTS,
    LocationOnboardingConflictError,
    LocationOnboardingLedgerStore,
    derive_location_pre_vault_pkm_commit_id,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"


@pytest.fixture
def isolated_db():
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL server is required.")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "location_finalize_test_" + uuid4().hex
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{name}"')
    engine = create_engine(make_url(url).set(database=name), hide_parameters=True)

    class Database:
        def execute_raw(self, sql, params=None):
            with engine.begin() as connection:
                result = connection.execute(text(sql), params or {})
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

    db = Database()
    db.engine = engine
    try:
        db.execute_raw("""CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
            CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
            CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY);
            INSERT INTO actor_profiles VALUES('owner'),('other');""")
        for prefix in (
            201,
            114,
            184,
            209,
            210,
            212,
            213,
            214,
            215,
            216,
            217,
            218,
            213,
            214,
            215,
            216,
            217,
            218,
        ):
            with engine.begin() as connection:
                with connection.connection.cursor() as cursor:
                    cursor.execute(next(MIGRATIONS.glob(f"{prefix}_*.sql")).read_text())
        # Match the actual v4 signature. The adapter makes an observable effect
        # inside the caller's transaction and can inject a response conflict.
        signature = (
            (MIGRATIONS / "214_location_command_private_finalize.sql")
            .read_text()
            .split("CREATE OR REPLACE FUNCTION ", 1)[1]
            .split("RETURNS JSONB", 1)[0]
        )
        signature = signature.replace(
            "commit_pkm_domain_mutation_v5", "commit_pkm_domain_mutation_v4"
        ).replace(",\n  p_location_finalize_authorization JSONB DEFAULT NULL", "")
        db.execute_raw(
            "CREATE TABLE fixture_effects(commit_id UUID PRIMARY KEY); CREATE TABLE fixture_control(conflict BOOLEAN); INSERT INTO fixture_control VALUES(FALSE)"
        )
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE OR REPLACE FUNCTION "
                + signature
                + """RETURNS JSONB LANGUAGE plpgsql AS $$
                BEGIN
                  IF (SELECT conflict FROM fixture_control) THEN RETURN '{"success":false,"conflict":true}'::jsonb; END IF;
                  INSERT INTO fixture_effects VALUES(p_commit_id);
                  RETURN jsonb_build_object('success',true,'data_version',1,'manifest_revision',1,'commit_id',p_commit_id);
                END; $$;"""
            )
        yield db
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.dispose()


@pytest.fixture
def prepared(isolated_db):
    db = isolated_db
    suffix = uuid4().hex
    ids = {
        key: prefix + suffix
        for key, prefix in {
            "run": "run_",
            "lease": "loclease_",
            "directive": "locdirective_",
            "draft": "locdraft_",
            "auth": "locpkmauth_",
        }.items()
    }
    commit = str(uuid4())
    deadline = (datetime.now(UTC) + timedelta(hours=1)).replace(microsecond=123456)
    bearer = "locpkmtoken_" + suffix + "_" + "b" * 64
    digest = "a" * 64
    params = {
        **ids,
        "commit": commit,
        "deadline": deadline,
        "digest": digest,
        "token_hash": hashlib.sha256(bearer.encode()).hexdigest(),
    }
    db.execute_raw(
        """INSERT INTO one_capability_runs(run_id,user_id,capability_id,capability_version,
      graph_revision,status,step_cursor,pending_interaction,pending_directive_id,idempotency_key,slots_hmac,expires_at)
      VALUES(:run,'owner','workflow.setup.location',2,:digest,'interaction_required','location.onboarding.complete',
        'one.location.awaiting_vault_finalize.v2',:directive,:digest,:digest,:deadline);
      INSERT INTO one_location_onboarding_interactions(lease_id,directive_id,user_id,run_id,step_cursor,
        run_revision,surface_id,allowed_actions_digest,expires_at)
      VALUES(:lease,:directive,'owner',:run,'location.onboarding.complete',1,'one.location.awaiting_vault_finalize.v2',:digest,:deadline);
      INSERT INTO one_location_onboarding_drafts(draft_id,user_id,run_id,graph_revision,run_revision,content_digest,expires_at)
      VALUES(:draft,'owner',:run,:digest,1,:digest,:deadline);
      INSERT INTO one_location_pkm_finalize_authorizations(authorization_id,token_sha256,user_id,run_id,run_revision,
        lease_id,directive_id,draft_id,draft_digest,expected_commit_id,place_receipt_evidence_digest,interaction_result_digest,expires_at)
      VALUES(:auth,:token_hash,'owner',:run,1,:lease,:directive,:draft,:digest,:commit,:digest,:digest,:deadline);""",
        params,
    )
    ledger = ActionDirectiveStore(db=db, hmac_key="test-only-signing-key")
    checkpoints = CommandCheckpointStore(
        db=db, cipher=AgentChatService(db=db, vault_key_hex="12" * 32)
    )
    command = str(uuid4())

    async def bind():
        state = await checkpoints.create(
            "owner",
            command,
            {
                "status": "ready",
                "plan_digest": "plan",
                "next_step": 0,
                "step_count": 1,
                "step_digests": [],
                "capsule": {"ciphertext": "synthetic sealed capsule"},
            },
        )
        args = dict(
            user_id="owner",
            command_id=command,
            step=0,
            action={
                "action_id": "workflow.setup.location",
                "execution_policy": "allow_direct",
                "_command_effect": "workflow",
            },
            slots={},
            context_revision="context",
            checkpoint_revision=state["revision"],
            plan_digest="plan",
        )
        await ledger.issue_command(**args)
        claimed = await ledger.claim_command(**args)
        await ledger.bind_command_workflow(
            user_id="owner", command_id=command, step=0, run_id=ids["run"]
        )
        return claimed

    claim = asyncio.run(bind())
    authority = {
        "schema_version": "one.location_pkm_finalize_authorization.v1",
        "authorization_id": ids["auth"],
        "token": bearer,
        "run_id": ids["run"],
        "run_revision": 1,
        "lease_id": ids["lease"],
        "directive_id": ids["directive"],
        "draft_ref": ids["draft"],
        "draft_digest": digest,
        "expected_commit_id": commit,
        "expires_at": deadline.isoformat(),
    }
    provenance = {
        "authorization_mode": "owner_requested_workflow",
        "workflow_authority": {
            "command_id": command,
            "command_step": 0,
            "operation_id": claim["operation_id"],
            "workflow_id": "workflow.setup.location",
            "run_id": ids["run"],
        },
    }
    return SimpleNamespace(
        db=db,
        authority=authority,
        provenance=provenance,
        commit=commit,
        command=command,
        run=ids["run"],
        checkpoints=checkpoints,
    )


def finalize(fixture, *, provenance=None, owner="owner", fingerprint="c" * 64):
    events = [
        {
            "operation_type": "content_write",
            "metadata": {
                "provenance": provenance if provenance is not None else fixture.provenance
            },
        }
    ]
    return fixture.db.execute_raw(
        """SELECT public.commit_pkm_domain_mutation_v5(
        :owner,'location',0,1,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,
        CAST(:events AS jsonb),FALSE,ARRAY[]::text[],'[]'::jsonb,CAST(:commit AS uuid),'mutation',NULL,'{}'::jsonb,
        :fingerprint,CAST(:authority AS jsonb)) AS outcome""",
        {
            "owner": owner,
            "events": json.dumps(events),
            "commit": fixture.commit,
            "fingerprint": fingerprint,
            "authority": json.dumps(fixture.authority),
        },
    ).data[0]["outcome"]


def test_finalizer_atomically_commits_effect_receipt_and_purges_draft(prepared):
    result = finalize(prepared)
    assert result["success"] and result["location_run_revision"] == 2
    assert result["location_place_receipt_id"].startswith("locplace_")
    assert len(prepared.db.execute_raw("SELECT * FROM fixture_effects").data) == 1
    assert prepared.db.execute_raw("SELECT * FROM one_location_onboarding_drafts").data == []
    assert prepared.db.execute_raw(
        "SELECT outcome_code FROM one_location_onboarding_receipts"
    ).data == [{"outcome_code": "saved"}]
    with pytest.raises(DBAPIError, match="authorization_replayed"):
        finalize(prepared)


def test_finalizer_requires_exact_microsecond_expiry_before_any_effect(prepared):
    exact_expiry = prepared.authority["expires_at"]
    prepared.authority["expires_at"] = datetime.fromisoformat(exact_expiry).isoformat(
        timespec="milliseconds"
    )
    with pytest.raises(DBAPIError, match="authorization_binding_mismatch"):
        finalize(prepared)
    assert prepared.db.execute_raw("SELECT * FROM fixture_effects").data == []
    assert prepared.db.execute_raw("SELECT * FROM one_location_onboarding_receipts").data == []
    assert prepared.db.execute_raw(
        "SELECT consumed_at FROM one_location_pkm_finalize_authorizations"
    ).data == [{"consumed_at": None}]
    prepared.authority["expires_at"] = exact_expiry
    assert finalize(prepared)["success"] is True


@pytest.fixture
def renewable(prepared):
    ledger = LocationOnboardingLedgerStore(db=prepared.db, hmac_key="test-only-signing-key")
    contract = LOCATION_APPROVED_SURFACE_CONTRACTS["one.location.awaiting_vault_finalize.v2"]
    prepared.commit = derive_location_pre_vault_pkm_commit_id(
        user_id="owner", run_id=prepared.run, draft_digest=prepared.authority["draft_digest"]
    )
    prepared.authority["expected_commit_id"] = prepared.commit
    prepared.db.execute_raw(
        """UPDATE one_location_pkm_finalize_authorizations SET expected_commit_id=CAST(:commit AS uuid);
        UPDATE one_location_onboarding_interactions SET allowed_actions_digest=:digest""",
        {
            "commit": prepared.commit,
            "digest": ledger.digest(
                "location_allowed_actions", {"actions": list(contract.allowed_actions)}
            ),
        },
    )
    run = asyncio.run(CapabilityRunStore(db=prepared.db).get(user_id="owner", run_id=prepared.run))
    return prepared, ledger, contract, run


@pytest.mark.parametrize("expired", [False, True])
def test_renewal_fences_failed_attempt_and_keeps_same_draft_and_commit(renewable, expired):
    prepared, ledger, contract, run = renewable
    if expired:
        prepared.db.execute_raw("""UPDATE one_location_onboarding_interactions
            SET issued_at=NOW()-INTERVAL '2 hours', expires_at=NOW()-INTERVAL '1 hour'""")
    else:
        unchanged, lease = asyncio.run(ledger.issue_lease(run=run, contract=contract))
        assert unchanged.revision == run.revision
        assert lease.lease_id == prepared.authority["lease_id"]
    renewed, lease = asyncio.run(
        ledger.issue_lease(run=run, contract=contract, renew_finalizer=True)
    )
    assert renewed.revision == run.revision + 1
    if not expired:
        with pytest.raises(DBAPIError, match="authorization_inactive"):
            finalize(prepared)
    assert prepared.db.execute_raw("SELECT * FROM fixture_effects").data == []
    draft = asyncio.run(ledger.get_active_secure_draft(user_id="owner", run_id=run.run_id))
    assert draft.digest == prepared.authority["draft_digest"]
    fresh = asyncio.run(
        ledger.issue_pkm_finalize_authorization(run=renewed, lease=lease, draft=draft)
    )
    assert fresh.expected_commit_id == prepared.commit
    prepared.authority.update(
        authorization_id=fresh.authorization_id,
        token=fresh.token,
        run_revision=fresh.run_revision,
        lease_id=fresh.lease_id,
        directive_id=fresh.directive_id,
        expires_at=fresh.expires_at.isoformat(),
    )
    assert finalize(prepared)["success"] is True
    assert len(prepared.db.execute_raw("SELECT * FROM fixture_effects").data) == 1


def test_completed_save_wins_before_renewal_and_cannot_be_reopened(renewable):
    prepared, ledger, contract, run = renewable
    assert finalize(prepared)["success"] is True
    with pytest.raises(LocationOnboardingConflictError):
        asyncio.run(ledger.issue_lease(run=run, contract=contract, renew_finalizer=True))
    assert len(prepared.db.execute_raw("SELECT * FROM fixture_effects").data) == 1
    assert len(prepared.db.execute_raw("SELECT * FROM one_location_onboarding_receipts").data) == 1


def test_concurrent_resumes_renew_the_same_revision_once(renewable):
    from concurrent.futures import ThreadPoolExecutor

    prepared, ledger, contract, run = renewable

    def renew():
        try:
            return asyncio.run(ledger.issue_lease(run=run, contract=contract, renew_finalizer=True))
        except LocationOnboardingConflictError:
            return None

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: renew(), range(2)))
    assert sum(result is not None for result in results) == 1
    assert prepared.db.execute_raw("SELECT revision FROM one_capability_runs").data == [
        {"revision": 2}
    ]
    assert prepared.db.execute_raw("SELECT * FROM fixture_effects").data == []


@pytest.mark.parametrize(
    "change,reason",
    [
        ("downgrade", "authority_required"),
        ("operation", "finalize_inactive"),
        ("cancel", "finalize_inactive"),
        ("expiry", "finalize_inactive"),
        ("owner", "finalize_inactive"),
    ],
)
def test_finalizer_rejects_authority_changes_before_any_effect(prepared, change, reason):
    provenance = json.loads(json.dumps(prepared.provenance))
    owner = "owner"
    if change == "downgrade":
        provenance = {"authorization_mode": "owner_confirmed"}
    if change == "operation":
        provenance["workflow_authority"]["operation_id"] = "d" * 64
    if change == "cancel":
        prepared.db.execute_raw("UPDATE one_adk_sessions SET command_status='cancelled'")
    if change == "expiry":
        prepared.db.execute_raw("UPDATE one_adk_sessions SET created_at=NOW()-INTERVAL '25 hours'")
    if change == "owner":
        owner = "other"
    with pytest.raises(DBAPIError, match=reason):
        finalize(prepared, provenance=provenance, owner=owner)
    assert prepared.db.execute_raw("SELECT * FROM fixture_effects").data == []
    assert prepared.db.execute_raw("SELECT * FROM one_location_onboarding_receipts").data == []


def test_conflict_preserves_unconsumed_authority_and_draft(prepared):
    prepared.db.execute_raw("UPDATE fixture_control SET conflict=TRUE")
    assert finalize(prepared)["conflict"] is True
    assert prepared.db.execute_raw(
        "SELECT consumed_at FROM one_location_pkm_finalize_authorizations"
    ).data == [{"consumed_at": None}]
    assert len(prepared.db.execute_raw("SELECT * FROM one_location_onboarding_drafts").data) == 1
    prepared.db.execute_raw("UPDATE fixture_control SET conflict=FALSE")
    assert finalize(prepared)["success"] is True


def test_failure_after_effect_rolls_back_everything(prepared):
    prepared.db.execute_raw("""CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected_receipt_failure'; END; $$;
        CREATE TRIGGER fixture_reject_receipt BEFORE INSERT ON one_location_onboarding_receipts
        FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()""")
    with pytest.raises(DBAPIError, match="injected_receipt_failure"):
        finalize(prepared)
    assert prepared.db.execute_raw("SELECT * FROM fixture_effects").data == []
    assert prepared.db.execute_raw(
        "SELECT consumed_at FROM one_location_pkm_finalize_authorizations"
    ).data == [{"consumed_at": None}]


def test_concurrent_finalizers_commit_once(prepared):
    from concurrent.futures import ThreadPoolExecutor

    def attempt():
        try:
            return finalize(prepared)
        except DBAPIError:
            return None

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: attempt(), range(4)))
    assert sum(result is not None for result in results) == 1
    assert len(prepared.db.execute_raw("SELECT * FROM fixture_effects").data) == 1


def test_rollback_keeps_private_authority_and_existing_receipts(prepared):
    assert finalize(prepared)["success"]
    for name in (
        "213_location_command_workflow_binding.rollback.sql",
        "214_location_command_private_finalize.rollback.sql",
        "215_location_command_resource_receipt.rollback.sql",
    ):
        prepared.db.execute_raw((MIGRATIONS / "rollback" / name).read_text())
    assert len(prepared.db.execute_raw("SELECT * FROM one_location_onboarding_receipts").data) == 1
    with pytest.raises(DBAPIError, match="authority_required"):
        finalize(prepared, provenance={"authorization_mode": "owner_confirmed"})


def test_repeated_completed_commands_close_views_and_retain_historical_proof(
    isolated_db, monkeypatch
):
    from hushh_mcp.services import location_command_workflow as binding
    from hushh_mcp.services.capability_run_service import CapabilityRunStore
    from hushh_mcp.services.location_onboarding_runtime import (
        LocationOnboardingLedgerStore,
        LocationOnboardingRuntimeService,
    )

    db = isolated_db
    cipher = AgentChatService(db=db, vault_key_hex="12" * 32)
    runs = CapabilityRunStore(db=db, cipher=cipher, hmac_key="test-only-signing-key")
    receipts = LocationOnboardingLedgerStore(db=db, hmac_key="test-only-signing-key")
    runtime = LocationOnboardingRuntimeService(run_store=runs, ledger_store=receipts)
    monkeypatch.setattr(binding, "get_db", lambda: db)
    monkeypatch.setattr(
        binding,
        "CapabilityRunStore",
        lambda **kw: CapabilityRunStore(
            db=db, cipher=cipher, hmac_key="test-only-signing-key", **kw
        ),
    )
    monkeypatch.setattr(
        binding,
        "ActionDirectiveStore",
        lambda **kw: ActionDirectiveStore(db=db, hmac_key="test-only-signing-key", **kw),
    )
    monkeypatch.setattr(
        binding,
        "LocationOnboardingLedgerStore",
        lambda **kw: LocationOnboardingLedgerStore(db=db, hmac_key="test-only-signing-key", **kw),
    )

    async def exercise():
        # Synthetic owning receipts characterize lifecycle/retention only. They
        # do not stand in for the physical encrypted-save acceptance journey.
        source = await runtime._create_v2_run(
            user_id="owner",
            graph_revision="a" * 16,
            context_revision="ctx",
            idempotency_scope="completed-fixture",
        )
        for kind, outcome in {
            "permission": "observed",
            "place": "saved",
            "circle": "provisioned",
            "completion": "verified",
        }.items():
            await receipts.mint_server_receipt(
                run=source,
                receipt_kind=kind,
                outcome_code=outcome,
                issuer="fixture",
                evidence_digest="b" * 64,
            )
        source = await runtime._finalize(source)
        db.execute_raw(
            "UPDATE one_capability_runs SET expires_at=NOW()-INTERVAL '1 day' WHERE run_id=:run",
            {"run": source.run_id},
        )
        db.execute_raw(
            "UPDATE one_location_onboarding_receipts SET issued_at=NOW()-INTERVAL '2 days', consumed_at=NOW()-INTERVAL '2 days', expires_at=NOW()-INTERVAL '1 day'"
        )
        assert await runs.purge_expired() == 0
        assert runtime._is_bound_verified_completion(
            source, await receipts.list_receipts(user_id="owner", run_id=source.run_id)
        )
        views = []
        for _ in range(2):
            view = await runtime.reserve_run(
                user_id="owner", graph_revision="a" * 16, context_revision="ctx"
            )
            assert (
                view.run_id != source.run_id
                and view.slots["verified_prior_run_id"] == source.run_id
            )
            assert view.run_id not in views
            views.append(view.run_id)
            ledger = ActionDirectiveStore(db=db, hmac_key="test-only-signing-key")
            checkpoint = CommandCheckpointStore(db=db, cipher=cipher)
            command = str(uuid4())
            state = await checkpoint.create(
                "owner",
                command,
                {
                    "status": "ready",
                    "plan_digest": "plan",
                    "next_step": 0,
                    "step_count": 1,
                    "step_digests": [],
                    "capsule": {"ciphertext": "sealed"},
                },
            )
            args = dict(
                user_id="owner",
                command_id=command,
                step=0,
                action={
                    "action_id": "workflow.setup.location",
                    "execution_policy": "allow_direct",
                    "_command_effect": "workflow",
                },
                slots={},
                context_revision="ctx",
                checkpoint_revision=state["revision"],
                plan_digest="plan",
            )
            await ledger.issue_command(**args)
            await ledger.claim_command(**args)
            await ledger.bind_command_workflow(
                user_id="owner", command_id=command, step=0, run_id=view.run_id
            )
            await binding._settle_completed_view(
                user_id="owner", command_id=command, step=0, run_id=view.run_id
            )
            # Lost response: same command lookup/settlement is idempotent.
            await binding._settle_completed_view(
                user_id="owner", command_id=command, step=0, run_id=view.run_id
            )
            closed = await runs.get(user_id="owner", run_id=view.run_id, include_slots=True)
            assert (
                closed.status == "cancelled"
                and closed.slots["verified_prior_run_id"] == source.run_id
            )
            assert (await ledger.command_outcome(user_id="owner", command_id=command, step=0))[
                "state"
            ] == "settled"
        original = await runs.get(user_id="owner", run_id=source.run_id, include_slots=True)
        assert original.status == "verified_succeeded" and original.revision == source.revision
        assert len(await receipts.list_receipts(user_id="owner", run_id=source.run_id)) == 4
        assert db.execute_raw("SELECT * FROM fixture_effects").data == []
        db.execute_raw(
            "UPDATE one_capability_runs SET expires_at=NOW()-INTERVAL '1 day' WHERE status='cancelled'"
        )
        assert await runs.purge_expired() == 2
        assert await runs.get(user_id="owner", run_id=source.run_id) is not None

    asyncio.run(exercise())


@pytest.fixture
def encrypted_pkm(prepared):
    """Replace the failure adapter with the authored v4→v3→v2 PKM writer.

    All plaintext and the random vault key are synthetic and process-local.
    This proves storage/receipt atomicity, not physical microphone/OS behavior.
    """
    from hushh_mcp.vault.encrypt import encrypt_data

    db = prepared.db
    trigger_source = next(MIGRATIONS.glob("003_*.sql")).read_text()
    trigger = (
        "CREATE OR REPLACE FUNCTION update_updated_at_column()"
        + trigger_source.split("CREATE OR REPLACE FUNCTION update_updated_at_column()", 1)[1].split(
            "$$ language 'plpgsql';", 1
        )[0]
        + "$$ language 'plpgsql';"
    )
    db.execute_raw(trigger)
    for prefix in (9, 30, 33, 34, 35, 48, 63, 74, 88, 89, 96, 98):
        with db.engine.begin() as connection:
            with connection.connection.cursor() as cursor:
                cursor.execute(next(MIGRATIONS.glob(f"{prefix:03d}_*.sql")).read_text())
    key = os.urandom(32).hex()
    original = {
        "root": {"preferences": {"synthetic_setting": "keep"}},
        "saved_places": {
            "locations": [
                {
                    "id": "fixture-home",
                    "category": "home",
                    "label": "Home",
                    "latitude": 0,
                    "longitude": 0,
                },
                {
                    "id": "fixture-work",
                    "category": "work",
                    "label": "Work",
                    "latitude": 1,
                    "longitude": 1,
                },
            ]
        },
        "unrelated": {"synthetic_record": ["preserve", {"nested": True}]},
    }

    def payload(content, revision):
        segments = []
        for name, value in content.items():
            plaintext = json.dumps(value, sort_keys=True)
            segments.append(
                {
                    **encrypt_data(plaintext, key).model_dump(),
                    "segment_id": name,
                    "manifest_revision": revision,
                    "size_bytes": len(plaintext.encode()),
                }
            )
        now = datetime.now(UTC).isoformat()
        manifest = {
            "manifest_version": revision,
            "domain_contract_version": 4,
            "readable_summary_version": 1,
            "pkm_contract_version": "7.0.0",
            "readable_projection_version": "7.0.0",
            "structure_decision": {},
            "summary_projection": {},
            "segment_ids": list(content),
            "top_level_scope_paths": ["saved_places", "unrelated"],
            "externalizable_paths": [],
            "path_count": 2,
            "externalizable_path_count": 0,
            "last_structured_at": now,
            "last_content_at": now,
        }
        paths = [
            {
                "json_path": name,
                "parent_path": None,
                "path_type": "branch",
                "segment_id": name,
                "scope_handle": f"fixture-{name}",
                "exposure_eligibility": False,
                "consent_label": name,
                "sensitivity_label": "confidential",
                "source_agent": "agent_location",
            }
            for name in ("saved_places", "unrelated")
        ]
        scopes = [
            {
                "scope_handle": f"fixture-{name}",
                "scope_label": name,
                "segment_ids": [name],
                "sensitivity_tier": "confidential",
                "scope_kind": "subtree",
                "exposure_enabled": False,
                "manifest_version": revision,
                "summary_projection": {},
                "visibility_posture": "private",
            }
            for name in ("saved_places", "unrelated")
        ]
        return {
            "segments": segments,
            "manifest": manifest,
            "paths": paths,
            "scopes": scopes,
            "summary": {
                "saved_places_configured": True,
                "saved_places_count": len(content["saved_places"]["locations"]),
            },
        }

    def commit(values, *, final=False, expected=0, commit_id=None):
        params = {name: json.dumps(value) for name, value in values.items()}
        params.update(
            expected=expected,
            next=expected + 1,
            commit=commit_id or str(uuid4()),
            events=json.dumps(
                [
                    {
                        "operation_type": "content_write",
                        "metadata": {
                            "provenance": prepared.provenance
                            if final
                            else {"authorization_mode": "owner_confirmed"}
                        },
                    }
                ]
            ),
            authority=json.dumps(prepared.authority),
            fingerprint="f" * 64,
        )
        suffix = ",CAST(:authority AS jsonb)" if final else ""
        return db.execute_raw(
            f"""SELECT public.commit_pkm_domain_mutation_v{5 if final else 4}(
            'owner','location',:expected,:next,CAST(:segments AS jsonb),CAST(:manifest AS jsonb),
            CAST(:paths AS jsonb),CAST(:scopes AS jsonb),CAST(:summary AS jsonb),CAST(:events AS jsonb),
            FALSE,ARRAY[]::text[],'[]'::jsonb,CAST(:commit AS uuid),'mutation',NULL,'{{}}'::jsonb,
            :fingerprint{suffix}) AS outcome""",
            params,
        ).data[0]["outcome"]

    assert commit(payload(original, 1))["success"]
    updated = json.loads(json.dumps(original))
    updated["saved_places"]["locations"].append(
        {
            "id": "location-workflow-" + prepared.run,
            "category": "other",
            "label": "Current location",
            "latitude": 2,
            "longitude": 2,
        }
    )
    values = payload(updated, 2)
    return SimpleNamespace(
        **vars(prepared),
        key=key,
        original=original,
        updated=updated,
        values=values,
        commit_pkm=lambda expected=1: commit(
            values, final=True, expected=expected, commit_id=prepared.commit
        ),
    )


def decrypted_segments(fixture, *, archived=False):
    from hushh_mcp.types import EncryptedPayload
    from hushh_mcp.vault.encrypt import decrypt_data

    sql = (
        (
            "SELECT s.* FROM pkm_domain_revision_segments s JOIN pkm_domain_revisions r USING(revision_id) "
            "WHERE r.user_id='owner' AND r.source_content_revision=1"
        )
        if archived
        else "SELECT * FROM pkm_blobs WHERE user_id='owner'"
    )
    return {
        row["segment_id"]: json.loads(
            decrypt_data(
                EncryptedPayload(
                    **{name: row[name] for name in ("ciphertext", "iv", "tag", "algorithm")},
                    encoding="base64",
                ),
                fixture.key,
            )
        )
        for row in fixture.db.execute_raw(sql).data
    }


def test_real_encrypted_writer_preserves_existing_places_and_settles_receipt(encrypted_pkm):
    from hushh_mcp.services.location_onboarding_runtime import PkmLocationPlaceEvidenceAdapter

    fixture = encrypted_pkm
    before = datetime.now(UTC)
    result = fixture.commit_pkm()
    assert result["success"] and result["data_version"] == 2
    assert result["location_run_revision"] == 2
    assert decrypted_segments(fixture) == fixture.updated
    assert decrypted_segments(fixture, archived=True) == fixture.original
    assert fixture.db.execute_raw("SELECT * FROM one_location_onboarding_drafts").data == []
    assert (
        len(
            fixture.db.execute_raw(
                "SELECT * FROM pkm_domain_commits WHERE commit_id=CAST(:commit AS uuid)",
                {"commit": fixture.commit},
            ).data
        )
        == 1
    )
    assert fixture.db.execute_raw(
        "SELECT outcome_code FROM one_location_onboarding_receipts"
    ).data == [{"outcome_code": "saved"}]
    adapter = PkmLocationPlaceEvidenceAdapter(db=fixture.db, hmac_key="test-only-key")
    evidence = asyncio.run(
        adapter.verify_saved_place(
            user_id="owner", commit_reference=fixture.commit, not_before=before
        )
    )
    assert evidence.status == "verified"
    with pytest.raises(DBAPIError, match="authorization_replayed"):
        fixture.commit_pkm()
    assert decrypted_segments(fixture) == fixture.updated


def test_real_encrypted_writer_receipt_failure_rolls_back_storage_and_proof(encrypted_pkm):
    fixture = encrypted_pkm
    tables = (
        "pkm_blobs",
        "pkm_manifests",
        "pkm_manifest_paths",
        "pkm_scope_registry",
        "pkm_events",
        "pkm_domain_commits",
        "pkm_domain_revisions",
        "pkm_domain_revision_segments",
        "pkm_index",
    )
    before = {table: fixture.db.execute_raw(f"SELECT * FROM {table}").data for table in tables}
    fixture.db.execute_raw("""CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected_receipt_failure'; END; $$;
        CREATE TRIGGER fixture_reject_receipt BEFORE INSERT ON one_location_onboarding_receipts
        FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()""")
    with pytest.raises(DBAPIError, match="injected_receipt_failure"):
        fixture.commit_pkm()
    assert {
        table: fixture.db.execute_raw(f"SELECT * FROM {table}").data for table in tables
    } == before
    assert decrypted_segments(fixture) == fixture.original
    assert fixture.db.execute_raw(
        "SELECT consumed_at FROM one_location_pkm_finalize_authorizations"
    ).data == [{"consumed_at": None}]
    assert len(fixture.db.execute_raw("SELECT * FROM one_location_onboarding_drafts").data) == 1


def test_real_encrypted_writer_conflict_keeps_same_draft_for_retry(encrypted_pkm):
    fixture = encrypted_pkm
    assert fixture.commit_pkm(expected=0)["conflict"] is True
    assert decrypted_segments(fixture) == fixture.original
    assert fixture.db.execute_raw("SELECT * FROM one_location_onboarding_receipts").data == []
    assert len(fixture.db.execute_raw("SELECT * FROM one_location_onboarding_drafts").data) == 1
    assert fixture.commit_pkm()["success"]
