"""Project preparation shares the retained owner operation and monotonic CAS."""

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from tests.fixtures.hosted_prefix_failure import _creation_receipt
from tests.test_hosted_pilot_admission_postgres import _claim, _Client, _policy
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


def test_provider_account_transition_journal_is_cas_fenced_and_archived(pg, monkeypatch, tmp_path):
    import psycopg2

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")

    from tests.hosted_pilot_readiness_cases import (
        _apply_hosted_predecessor_migrations,
        _create_runtime_roles,
    )
    from tests.hosted_pod_support import (
        hosted_preparation_contract,
        hosted_project_authorization,
        preparation_results,
    )
    from tests.test_hosted_pilot_admission_postgres import ROOT
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    image_digest = "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
    project_data = [
        {
            "owner": "owner-a",
            "hushhId": "ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq",
            "project": "hussh-hp-7da5778b-261027a",
            "projectNumber": "1010592650891",
            "attemptId": "95af9d1fdab94601a1e45554e4774fd3",
            "operationId": "777fe0a3-eaa2-42b3-97d2-3b6549a20290",
            "serviceUid": "fec811ba-2456-495d-ab66-a0d926077ae1",
            "runtimePrincipal": "one-pod-ha1-t6cqxavpt-rkntchve@hussh-hp-7da5778b-261027a.iam.gserviceaccount.com",
        },
        {
            "owner": "owner-b",
            "hushhId": "ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh",
            "project": "hussh-hp-a3a6730e-261027b",
            "projectNumber": "349132050484",
            "attemptId": "67ce0564b4b541a69abb31b336e51352",
            "operationId": "9df62f66-f271-491d-ab34-406823292f5d",
            "serviceUid": "e14040de-505a-4fc6-9a4a-e391ea1d6026",
            "runtimePrincipal": "one-pod-ha1-sdhll3ua5-rqghnwhy@hussh-hp-a3a6730e-261027b.iam.gserviceaccount.com",
        },
    ]
    _create_runtime_roles(pg)
    _apply_hosted_predecessor_migrations(pg, lambda: False)
    for migration in (
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
    ):
        pg.apply_file(ROOT / "db/migrations/parked" / migration)
    from db.hosted_custody_adoption import _successor_qualification

    pg.execute(_successor_qualification())

    from hushh_mcp.managed_ai_config import load_profile, profile_hash

    profile = load_profile("dev")
    assignments = []
    contract = hosted_preparation_contract()
    contract["billingAccount"] = "billingAccounts/014D7F-FD970D-D2459E"
    for item in project_data:
        assignment = {
            "ownerHash": "sha256:" + hashlib.sha256(item["owner"].encode()).hexdigest(),
            "hushhId": item["hushhId"],
            "project": item["project"],
            "projectNumber": item["projectNumber"],
            "region": "us-central1",
            "preparationContract": contract,
        }
        assignment["bootstrapContract"] = _approved_bootstrap(assignment)
        assignments.append(assignment)
    pg.execute(
        "INSERT INTO hosted_pod_pilot_policy(policy_id,environment,source_revision,image_digest,"
        "assignments,model_binding,work_budget_cents,cleanup_reserve_cents,created_at,expires_at)"
        " VALUES ('11111111-1111-4111-8111-111111111111','dev',%s,%s,%s::jsonb,%s::jsonb,"
        "40000,10000,now()-interval '2 days',now()+interval '1 day')",
        (
            "a" * 40,
            image_digest,
            json.dumps(assignments),
            json.dumps(
                {
                    "provider": "gemini",
                    "project": profile["project"],
                    "model": profile["text_model"],
                    "profileHash": profile_hash(profile),
                }
            ),
        ),
    )
    reservations = {}
    for item in project_data:
        desired = {
            "user_id": item["owner"],
            "hushh_id": item["hushhId"],
            "phone_e164_hash": "sha256:synthetic-" + item["owner"],
            "deployment_target": "gcp",
            "model_credential_mode": "fleet_adc",
        }
        reservations[item["owner"]] = pg.execute(
            "SELECT claim_hosted_pod_pilot_provision(%s,%s,NULL,%s::jsonb)",
            (item["owner"], item["attemptId"], json.dumps(desired)),
        )[0][0]

    # Fixture only: represent the two already provisioned placements and retain
    # their original creation/link_billing receipts before exercising 982.
    pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    try:
        for item in project_data:
            attempt = reservations[item["owner"]]
            completed, identity = preparation_results(attempt)
            service_account = {
                "type": "gcp_service_account",
                "id": item["runtimePrincipal"],
                "disposition": "created",
                "identity": {
                    "projectId": item["project"],
                    "email": item["runtimePrincipal"],
                    "name": f"projects/{item['project']}/serviceAccounts/{item['runtimePrincipal']}",
                },
            }
            attempt.setdefault("evidence", {}).setdefault("reserved", {})["hostedCheckpoint"] = {
                "completed": [
                    {
                        "step": "pod_service_account",
                        "ok": True,
                        "resourceObservation": service_account,
                    }
                ]
            }
            model_project = attempt["hostedAdmission"]["modelBinding"]["project"]
            completed.extend(
                {
                    "step": step,
                    "status": 200,
                    "ok": True,
                    "resourceObservation": service_account,
                    "bindingObservations": [
                        {
                            "step": step,
                            "policyResource": (
                                "https://cloudresourcemanager.googleapis.com/v1/projects/"
                                f"{model_project}:getIamPolicy"
                            ),
                            "role": role,
                            "member": f"serviceAccount:{item['runtimePrincipal']}",
                            "disposition": "added",
                            "beforeEtag": "before",
                            "afterEtag": "after",
                        }
                    ],
                }
                for step, role in (
                    ("inference_vertex", "roles/aiplatform.user"),
                    ("inference_quota", "roles/serviceusage.serviceUsageConsumer"),
                )
            )
            attempt["phase"] = "provisioned"
            attempt.setdefault("evidence", {}).setdefault("reserved", {})["projectObservation"] = {
                "projectId": item["project"],
                "projectNumber": item["projectNumber"],
                "lifecycleState": "ACTIVE",
            }
            attempt["evidence"]["reserved"]["projectAuthorization"] = hosted_project_authorization(
                attempt
            )
            attempt["evidence"]["reserved"]["hostedPreparation"] = {
                "version": 1,
                "ownerId": item["owner"],
                "attemptId": item["attemptId"],
                "generation": 10,
                "phase": "observed",
                "step": "inference_quota",
                "planDigest": attempt["hostedAdmission"]["preparationContractHash"],
                "completed": completed,
            }
            row = pg.execute(
                "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s",
                (item["owner"],),
            )[0][0]
            metadata = row["backend_metadata"]
            metadata.update(
                {
                    "tenancy": "hussh-hosted",
                    "project": item["project"],
                    "serviceUid": item["serviceUid"],
                    "runtime_service_account": item["runtimePrincipal"],
                    "provisionAttempt": attempt,
                }
            )
            pg.execute(
                "UPDATE personal_agent_registry SET status='provisioned',backend_metadata=%s::jsonb "
                "WHERE user_id=%s",
                (json.dumps(metadata), item["owner"]),
            )
    finally:
        pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")

    # Confirm rollback is safe before evidence exists, and prove the archive
    # function returns to its exact 979 source body.
    migration = ROOT / "db/migrations/parked/982_hosted_provider_account_transition.sql"
    rollback = ROOT / "db/migrations/rollback/982_hosted_provider_account_transition.rollback.sql"
    archive_definition_before = pg.execute(
        "SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)"
    )[0][0]
    pg.apply_file(migration)
    pg.apply_file(rollback)
    archive_definition_after_rollback = pg.execute(
        "SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)"
    )[0][0]
    import difflib

    assert archive_definition_after_rollback == archive_definition_before, "".join(
        difflib.unified_diff(
            archive_definition_before.splitlines(keepends=True),
            archive_definition_after_rollback.splitlines(keepends=True),
        )
    )
    pg.apply_file(migration)
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "d" * 40)
    client = _Client(pg)
    journal = HostedPodJournal(client)

    def make_intent(item, *, delta=0):
        now = datetime.now(timezone.utc)
        if delta:
            from datetime import timedelta

            now -= timedelta(minutes=delta)
        return {
            "version": 1,
            "ownerId": item["owner"],
            "attemptId": item["attemptId"],
            "placementEpoch": 0,
            "operationId": item["operationId"],
            "projectId": item["project"],
            "projectNumber": item["projectNumber"],
            "oldBillingAccount": "billingAccounts/014D7F-FD970D-D2459E",
            "targetBillingAccount": "billingAccounts/013848-8258FA-2D068F",
            "actorPrincipal": "user:kushaltrivedi97@gmail.com",
            "actorVerification": {
                "version": 1,
                "provider": "google",
                "issuer": "https://accounts.google.com",
                "subject": "synthetic-google-subject",
                "principal": "user:kushaltrivedi97@gmail.com",
                "email": "kushaltrivedi97@gmail.com",
                "emailVerified": True,
                "audience": "hushh-pda-dev",
                "verificationMethod": "google_id_token_verified",
                "tokenSha256": "e" * 64,
                "verifiedAt": now.isoformat(),
            },
            "serviceUid": item["serviceUid"],
            "runtimePrincipal": item["runtimePrincipal"],
            "imageDigest": image_digest,
            "intentAt": now.isoformat(),
        }

    intent = make_intent(project_data[0])
    item_a = project_data[0]
    item_b = project_data[1]
    retained_row = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    assert pg.execute(
        "SELECT hosted_pod_retained_admitted('owner-a',%s::jsonb)",
        (json.dumps(retained_row),),
    )[0][0]
    mismatched_admission = deepcopy(retained_row)
    mismatched_admission["backend_metadata"]["provisionAttempt"]["hostedAdmission"][
        "environment"
    ] = "prod"
    assert not pg.execute(
        "SELECT hosted_pod_retained_admitted('owner-a',%s::jsonb)",
        (json.dumps(mismatched_admission),),
    )[0][0]
    assert not pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb)",
        (json.dumps(mismatched_admission), json.dumps(intent)),
    )[0][0]
    invalid_retained_rows = []
    wrong_checkpoint_owner = deepcopy(retained_row)
    wrong_checkpoint_owner["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["ownerId"] = "foreign-owner"
    invalid_retained_rows.append(wrong_checkpoint_owner)
    wrong_checkpoint_generation = deepcopy(retained_row)
    wrong_checkpoint_generation["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["generation"] = 8
    invalid_retained_rows.append(wrong_checkpoint_generation)
    wrong_checkpoint_digest = deepcopy(retained_row)
    wrong_checkpoint_digest["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["planDigest"] = "f" * 64
    invalid_retained_rows.append(wrong_checkpoint_digest)
    wrong_final_step = deepcopy(retained_row)
    wrong_final_step["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["completed"][4]["step"] = "authorize_project"
    invalid_retained_rows.append(wrong_final_step)
    assert [
        pg.execute(
            "SELECT valid_hosted_preparation_result(%s::jsonb,%s::jsonb)",
            (json.dumps(retained_row["backend_metadata"]["provisionAttempt"]), json.dumps(receipt)),
        )[0][0]
        for receipt in retained_row["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
            "hostedPreparation"
        ]["completed"]
    ] == [True] * 5
    for invalid_row in invalid_retained_rows:
        assert not pg.execute(
            "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb)",
            (json.dumps(invalid_row), json.dumps(intent)),
        )[0][0]
    wrong_operation = make_intent(project_data[0])
    wrong_operation["operationId"] = "00000000-0000-4000-8000-000000000000"
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=item_a["attemptId"], intent=wrong_operation
        )
    )
    history_before = pg.execute(
        "SELECT (backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract')::text,"
        "(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text "
        "FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a",
            attempt_id=item_a["attemptId"],
            intent={**intent, "projectNumber": "999999999999"},
        )
    )
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-b", attempt_id=item_b["attemptId"], intent=intent
        )
    )
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id="f" * 32, intent=intent
        )
    )
    stale = make_intent(item_a, delta=11)
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=item_a["attemptId"], intent=stale
        )
    )
    assert asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=item_a["attemptId"], intent=intent
        )
    )
    assert not asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=item_a["attemptId"], intent=intent
        )
    )

    transition = pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' "
        "FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert transition["phase"] == "intent" and transition["generation"] == 1
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="provider account transition"):
        pg.execute("SELECT reserve_personal_agent_erasure('owner-a','unresolved-erasure')")

    unknown = {
        "version": 1,
        "outcome": "unknown",
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    aged_intent = deepcopy(intent)
    aged_at = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    aged_intent["intentAt"] = aged_at
    aged_intent["actorVerification"]["verifiedAt"] = aged_at
    aged_intent["minimumSourceRevision"] = "d" * 40
    aged_state = {
        "version": 1,
        "generation": 2,
        "phase": "unknown",
        "intent": aged_intent,
        "settlements": [unknown],
    }
    assert pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(to_jsonb(r),%s::jsonb),"
        "valid_hosted_provider_account_transition(to_jsonb(r),%s::jsonb) "
        "FROM personal_agent_registry r WHERE user_id='owner-a'",
        (json.dumps(aged_intent), json.dumps(aged_state)),
    )[0] == (True, True)
    row_for_append = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    previous_state = row_for_append["backend_metadata"]["provisionAttempt"][
        "providerAccountTransition"
    ]
    unknown_state = {
        **previous_state,
        "generation": 2,
        "phase": "unknown",
        "settlements": [unknown],
    }
    row_after_append = deepcopy(row_for_append)
    row_after_append["backend_metadata"]["provisionAttempt"]["providerAccountTransition"] = (
        unknown_state
    )
    assert pg.execute(
        "SELECT valid_hosted_provider_account_transition(%s::jsonb,%s::jsonb),"
        "valid_hosted_provider_account_transition_append(%s::jsonb,%s::jsonb)",
        (
            json.dumps(row_after_append),
            json.dumps(unknown_state),
            json.dumps(row_for_append),
            json.dumps(row_after_append),
        ),
    )[0] == (True, True)
    assert asyncio.run(
        journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=unknown,
        )
    )
    assert not asyncio.run(
        journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=unknown,
        )
    )
    settled = {
        "version": 1,
        "outcome": "settled",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "projectId": item_a["project"],
        "projectNumber": item_a["projectNumber"],
        "billingAccountName": "billingAccounts/013848-8258FA-2D068F",
        "billingEnabled": True,
        "actorPrincipal": "user:kushaltrivedi97@gmail.com",
        "operationId": item_a["operationId"],
    }
    assert not asyncio.run(
        journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=settled,
        )
    )
    assert asyncio.run(
        journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=item_a["attemptId"],
            expected_generation=2,
            expected_phase="unknown",
            settlement=settled,
        )
    )
    transition = pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' "
        "FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert transition["phase"] == "settled" and transition["generation"] == 3
    history_after = pg.execute(
        "SELECT (backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract')::text,"
        "(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text "
        "FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    assert history_after == history_before
    pg.execute(
        "UPDATE personal_agent_registry SET last_heartbeat_at=clock_timestamp() "
        "WHERE user_id='owner-a'"
    )
    with pytest.raises(
        psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{provisionAttempt,hostedAdmission,assignment,preparationContract,operatorPrincipal}',"
            "to_jsonb('user:rewritten@example.test'::text)) WHERE user_id='owner-a'"
        )
    with pytest.raises(
        psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{provisionAttempt,evidence,reserved,hostedPreparation,completed,1,billingObservation,billingAccountName}',"
            "to_jsonb('billingAccounts/rewritten'::text)) WHERE user_id='owner-a'"
        )
    with pytest.raises(
        psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{serviceUid}',to_jsonb('rewritten-service-uid'::text)) WHERE user_id='owner-a'"
        )

    # Existing removal admission owns the same locks. It blocks while the row
    # owner is serialized, then refuses to freeze an unresolved provider state.
    intent_b = make_intent(item_b)
    assert asyncio.run(
        journal.record_provider_account_transition_intent(
            owner_id="owner-b", attempt_id=item_b["attemptId"], intent=intent_b
        )
    )
    lock_owner = psycopg2.connect(host=pg.dir, port=pg.port, user="hushh", dbname="postgres")
    lock_owner.autocommit = False
    lock_cursor = lock_owner.cursor()
    lock_cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('owner-b',171))")
    lock_cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('owner-b',198))")
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            future = workers.submit(
                pg.execute,
                "SELECT reserve_personal_agent_erasure('owner-b','blocked-removal')",
            )
            import time

            time.sleep(0.1)
            assert not future.done()
            lock_owner.commit()
            with pytest.raises(
                psycopg2.errors.InsufficientPrivilege, match="provider account transition"
            ):
                future.result(timeout=10)
    finally:
        lock_owner.rollback()
        lock_cursor.close()
        lock_owner.close()
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="provider account transition"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{provisionAttempt,attemptId}',to_jsonb('f'::text||repeat('0',31))) WHERE user_id='owner-b'"
        )

    current = pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition',"
        "(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text "
        "FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    erasure = pg.execute("SELECT reserve_personal_agent_erasure('owner-a','settled-erasure')")[0][0]
    archive = pg.execute(
        "SELECT personal_agent_erasure_archive(%s::jsonb,NULL)", (json.dumps(erasure),)
    )[0][0]
    assert archive["receipts"]["providerAccountTransition"] == current[0]
    assert current[1] == history_before[1]
    archive_transition_sha = pg.execute(
        "SELECT encode(sha256(convert_to(pg_get_functiondef("
        "'public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure),'UTF8')),'hex')"
    )[0][0]
    assert (
        archive_transition_sha == "aef9e2ea2a5757e2601c3853c062625c56a2df889b29e6aac3d7d192367a466a"
    )
    with pytest.raises(psycopg2.errors.RaiseException, match="explicit Dev profile required"):
        pg.execute(_successor_qualification())

    # The exact 982 family is accepted only by the explicit Dev owner profile.
    pg.execute("DROP OWNED BY service_role; DROP ROLE service_role")
    pg.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
    import db.hosted_custody_qualification as custody_qualification
    from db.hosted_custody_adoption import (
        HOSTED_FILES_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
        _successor_qualification,
        qualified_hosted_custody_family,
    )
    from db.hosted_custody_qualification import (
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        HostedCustodyProfile,
        hosted_custody_profile_from_environment,
    )
    from tests.helpers.private_agent_adoption import canonical_database, install_legacy_guards
    from tests.pkm_conformance import postgres_harness
    from tests.pkm_conformance.postgres_harness import TempPostgres
    from tests.test_hosted_pilot_admission_postgres import _dev_custody_environment

    source_profile = HostedCustodyProfile(
        DEV_CONTROL_PLANE_OWNER_PROFILE, DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256
    )
    transition_family = qualified_hosted_custody_family(source_profile)
    assert not set(HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED).issubset(
        qualified_hosted_custody_family()
    )
    assert set(HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED).issubset(transition_family)
    assert (
        qualified_hosted_custody_family()["personal_agent_erasure_archive(jsonb,jsonb)"]
        == (HOSTED_FILES_QUALIFIED["personal_agent_erasure_archive(jsonb,jsonb)"])
    )
    assert transition_family["personal_agent_erasure_archive(jsonb,jsonb)"] == (
        "aef9e2ea2a5757e2601c3853c062625c56a2df889b29e6aac3d7d192367a466a"
    )
    for signature in transition_family:
        name, _, arguments = signature.partition("(")
        pg.execute(f'ALTER FUNCTION public."{name}"({arguments} OWNER TO hushh_uat_app')
    pg.execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
    pg.execute(
        "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
    )
    from tests.hosted_pilot_readiness_cases import (
        _copy_custody_family,
        _copy_rollback_marker_and_trigger,
        _custody_family_catalog,
        _later_owned_trigger_definitions,
        _registry_trigger_catalog,
        _replay_420_421,
    )

    empty_prelude = tmp_path / "empty-postgres-prelude.sql"
    empty_prelude.write_text("SELECT 1;\n", encoding="utf-8")
    monkeypatch.setattr(postgres_harness, "PRELUDE", empty_prelude)
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    target_server = TempPostgres()
    target_server.start()
    owner_connection = None
    try:
        canonical_connection, database = canonical_database(
            target_server, monkeypatch, database="postgres"
        )
        install_legacy_guards(canonical_connection)
        target_server.execute("CREATE ROLE hushh_uat_app LOGIN SUPERUSER")
        canonical_connection.close()
        owner_connection = psycopg2.connect(
            host=target_server.dir,
            port=target_server.port,
            user="hushh_uat_app",
            dbname=database,
        )
        owner_connection.autocommit = True

        def owner_execute(statement, params=None):
            with owner_connection.cursor() as cursor:
                cursor.execute(statement, params)
                return cursor.fetchall() if cursor.description is not None else []

        owner_execute("SET check_function_bodies=off")
        owner_execute("ALTER TABLE public.personal_agent_registry OWNER TO hushh_uat_app")
        _copy_custody_family(pg, owner_connection, transition_family)
        _copy_rollback_marker_and_trigger(pg, owner_connection, owner_execute)
        owner_execute("SET check_function_bodies=on")
        target_server.execute("DROP OWNED BY service_role; DROP ROLE service_role")

        target_system_identifier_hash = owner_execute(
            "SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') "
            "FROM pg_control_system()"
        )[0][0]
        monkeypatch.setattr(
            custody_qualification,
            "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
            target_system_identifier_hash,
        )
        for key, value in _dev_custody_environment().items():
            monkeypatch.setenv(key, value)
        profile = hosted_custody_profile_from_environment()
        owner_execute(
            "ALTER TABLE public.hosted_files_executor_976_rollback_source OWNER TO hushh_uat_app"
        )
        owner_execute(_successor_qualification(profile))

        # Definition drift, a missing member, an overload, and an ACL grant each
        # invalidate the closed Dev family before 420/421 can replay it.
        drift_signature = "valid_hosted_provider_account_transition_settlement(jsonb,jsonb)"
        source_definition = owner_execute(
            "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + drift_signature,)
        )[0][0]
        owner_execute(
            "CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_settlement("
            "p_intent jsonb,p_settlement jsonb) RETURNS boolean LANGUAGE plpgsql STABLE "
            "SET search_path=public AS $$ BEGIN RETURN true; END; $$"
        )
        with pytest.raises(psycopg2.errors.RaiseException, match="function definition or ACL"):
            owner_execute(_successor_qualification(profile))
        owner_execute(source_definition)

        owner_execute(
            "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement(jsonb,jsonb) "
            "RENAME TO valid_hosted_provider_account_transition_settlement_missing"
        )
        with pytest.raises(psycopg2.errors.RaiseException, match="overload or missing function"):
            owner_execute(_successor_qualification(profile))
        owner_execute(
            "ALTER FUNCTION public.valid_hosted_provider_account_transition_settlement_missing(jsonb,jsonb) "
            "RENAME TO valid_hosted_provider_account_transition_settlement"
        )
        owner_execute(
            "CREATE FUNCTION public.record_hosted_provider_account_transition_intent(integer) "
            "RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT true $$"
        )
        with pytest.raises(psycopg2.errors.RaiseException, match="overload or missing function"):
            owner_execute(_successor_qualification(profile))
        owner_execute(
            "DROP FUNCTION public.record_hosted_provider_account_transition_intent(integer)"
        )
        acl_signature = "public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)"
        owner_execute(f"GRANT EXECUTE ON FUNCTION {acl_signature} TO anon")
        with pytest.raises(psycopg2.errors.RaiseException, match="function definition or ACL"):
            owner_execute(_successor_qualification(profile))
        owner_execute(f"REVOKE ALL ON FUNCTION {acl_signature} FROM anon")
        owner_execute(_successor_qualification(profile))

        transition_catalog_before = _custody_family_catalog(owner_connection, transition_family)
        trigger_catalog_before = _registry_trigger_catalog(owner_connection)
        later_trigger_definitions_before = _later_owned_trigger_definitions(owner_connection)
        assert len(later_trigger_definitions_before) == 4
        _replay_420_421(
            pg,
            owner_connection,
            database,
            transition_family,
            database_user="hushh_uat_app",
            replay_server=target_server,
        )
        assert _custody_family_catalog(owner_connection, transition_family) == (
            transition_catalog_before
        )
        trigger_catalog_after = set(_registry_trigger_catalog(owner_connection))
        assert set(trigger_catalog_before).issubset(trigger_catalog_after)
        later_trigger_definitions_after = _later_owned_trigger_definitions(owner_connection)
        assert later_trigger_definitions_after == later_trigger_definitions_before
        assert len(later_trigger_definitions_after) == 4
    finally:
        if owner_connection is not None:
            owner_connection.close()
        target_server.stop()

    with pytest.raises(psycopg2.errors.ObjectNotInPrerequisiteState, match="forward recovery"):
        pg.apply_file(rollback)
    client._engine.dispose()


def test_normal_hosted_erasure_requires_destroyed_keys_and_owner_bound_retirement(pg, monkeypatch):
    from tests.fixtures.hosted_erasure import admitted_erasure

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture, client in admitted_erasure(pg):

            def complete(fixture=fixture):
                return pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[
                    0
                ][0]

            assert not complete()
            fixture.memory_compute_writer()
            await fixture.model_grants(client)
            fixture.destroy_owner_resources()
            fixture.release_project_grants()
            fixture.release_bootstrap()
            assert not complete()  # Grant release is not project retirement evidence.
            await fixture.retire(client)
            assert complete()
            reservation = fixture.reservation()
            assert reservation["memoryDeletion"]["status"] == "provider_deleted"
            assert reservation["kmsErasure"]["inventory"]["versionNames"]
            assert reservation["kmsErasure"]["completion"]["status"] == "destroyed"
            assert reservation["managedProjectRetirement"]["deletion"]["status"] == (
                "retirement_pending_provider_purge"
            )
            assert pg.execute("SELECT count(*) FROM byoc_setup_jobs")[0][0] == 0
            archive = pg.execute(
                "SELECT personal_agent_erasure_archive(%s::jsonb,NULL)",
                (json.dumps(reservation),),
            )[0][0]
            assert archive["receipts"]["hostingMode"] == "hussh_hosted"
            assert (
                archive["receipts"]["managedModelGrantErasure"]
                == (reservation["managedModelGrantErasure"])
            )

    asyncio.run(scenario())


@pytest.mark.parametrize("expire_after_ack", [False, True])
def test_project_preparation_has_one_intent_winner_and_refuses_foreign_readback(
    pg, expire_after_ack
):
    _policy(pg, preparation=True, ttl="2 seconds" if expire_after_ack else "1 day")
    reservation = _claim(pg)
    admission = reservation["hostedAdmission"]
    client = _Client(pg)
    checkpoint = {
        "version": 1,
        "ownerId": "owner-a",
        "attemptId": reservation["attemptId"],
        "expectedGeneration": 0,
        "generation": 1,
        "planDigest": admission["preparationContractHash"],
        "phase": "intent",
        "step": "create_project",
        "completed": [],
    }

    def publish(value, kind="preparation"):
        return asyncio.run(
            HostedPodJournal(client).publish(
                owner_id="owner-a",
                attempt_id=reservation["attemptId"],
                kind=kind,
                checkpoint=value,
            )
        )

    try:
        assert not publish(checkpoint, "bootstrap")
        with ThreadPoolExecutor(max_workers=2) as workers:
            assert sorted(workers.map(publish, [checkpoint, checkpoint])) == [False, True]
        assert not publish(checkpoint)
        result = _creation_receipt(reservation)
        observed = {
            **checkpoint,
            "expectedGeneration": 1,
            "generation": 2,
            "phase": "observed",
            "completed": [result],
        }
        foreign = deepcopy(observed)
        foreign["completed"][0]["resourceObservation"]["identity"]["parent"]["id"] = "987654321"
        assert not publish(foreign)
        assert publish(observed)
        assert publish(observed)
        if expire_after_ack:
            pg.execute(
                "SELECT pg_sleep(greatest(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.05) FROM hosted_pod_pilot_policy"
            )
        project_observation = {
            key: result["resourceObservation"]["identity"][key]
            for key in ("projectId", "projectNumber", "lifecycleState")
        }
        assert asyncio.run(
            HostedPodJournal(client).retain_project(
                owner_id="owner-a",
                attempt_id=reservation["attemptId"],
                observation=project_observation,
            )
        )
        assert not asyncio.run(
            HostedPodJournal(client).retain_project(
                owner_id="owner-a",
                attempt_id=reservation["attemptId"],
                observation={**project_observation, "projectNumber": "999999999999"},
            )
        )
        next_step = {
            **observed,
            "expectedGeneration": 2,
            "generation": 3,
            "phase": "intent",
            "step": "link_billing",
        }
        assert publish(next_step) is (not expire_after_ack)
        assert not publish(next_step)
    finally:
        client._engine.dispose()


@pytest.mark.parametrize("steps", [1, 2])
def test_partial_project_cleanup_never_manufactures_bootstrap_authority(pg, steps, monkeypatch):
    from tests.hosted_pod_support import prepared_project_journal
    from tests.test_hosted_pilot_admission_postgres import ROOT
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    client = _Client(pg)
    try:
        attempt = asyncio.run(prepared_project_journal(pg, _claim(pg), client, steps=steps))
        row = pg.execute(
            "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
        )[0][0]
        reservation = {
            "ownerId": "owner-a",
            "hushhId": row["hushh_id"],
            "attemptId": "cleanup",
            "registrySnapshot": row,
        }

        def coordinates(value):
            return pg.execute(
                "SELECT managed_preparation_cleanup_coordinates(%s::jsonb)", (json.dumps(value),)
            )[0][0]

        assert (
            coordinates(reservation)["project"]
            == attempt["hostedAdmission"]["assignment"]["project"]
        )
        assert (
            pg.execute("SELECT erasure_private_coordinates(%s::jsonb)", (json.dumps(reservation),))[
                0
            ][0]
            is None
        )
        assert (
            pg.execute(
                "SELECT erasure_authorization_history(%s::jsonb,NULL)", (json.dumps(reservation),)
            )[0][0]
            == {}
        )
        forged = deepcopy(reservation)
        forged["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
            "hostedPreparation"
        ]["phase"] = "intent"
        assert coordinates(forged) is None
        forged = deepcopy(reservation)
        forged["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
            "hostedCheckpoint"
        ] = {}
        assert coordinates(forged) is None
        forged = deepcopy(reservation)
        forged["registrySnapshot"]["user_id"] = "foreign-owner"
        assert coordinates(forged) is None
    finally:
        client._engine.dispose()


async def test_lost_preparation_result_observes_without_repeating_mutation(pg, monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.hosted_project_preparation import prepare_project_step
    from tests.hosted_pod_support import preparation_results
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    reservation = _claim(pg)
    result = preparation_results(reservation)[0][0]
    client = _Client(pg)
    journal = HostedPodJournal(client)
    mutate = AsyncMock(side_effect=TimeoutError("synthetic lost acknowledgement"))
    observe = AsyncMock(return_value=result)
    try:
        with pytest.raises(TimeoutError):
            await prepare_project_step(
                journal, reservation, step="create_project", mutate=mutate, observe=observe
            )
        retained = pg.execute(
            "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        assert retained["evidence"]["reserved"]["hostedPreparation"]["phase"] == "intent"
        assert (
            await prepare_project_step(
                journal, retained, step="create_project", mutate=mutate, observe=observe
            )
            == result
        )
        assert mutate.await_count == 1
        assert observe.await_count == 1
        retained = pg.execute(
            "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        assert (
            await prepare_project_step(
                journal, retained, step="create_project", mutate=mutate, observe=observe
            )
            == result
        )
        assert mutate.await_count == observe.await_count == 1
    finally:
        client._engine.dispose()


def test_operator_refuses_wrong_actor_and_revoked_mutation_before_http(pg, monkeypatch):
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_project_gcp_operator import GcpPreparationOperator
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    reservation = _claim(pg)
    session = Mock()
    guard = Mock(side_effect=ProvisionReconciliationRequired("revoked"))
    terms = dict(token="synthetic", session=session, guard=guard, step="create_project")  # noqa: S106 -- inert fixture credential
    with pytest.raises(ValueError, match="operator"):
        GcpPreparationOperator(reservation, actor="user:foreign@example.test", **terms)
    operator = GcpPreparationOperator(reservation, actor="user:operator@example.test", **terms)
    with pytest.raises(ProvisionReconciliationRequired, match="retained preparation step"):
        operator.link_billing()
    with pytest.raises(ProvisionReconciliationRequired, match="revoked"):
        operator.create()
    session.request.assert_not_called()


@pytest.mark.parametrize("prefix", range(19))
def test_managed_prefix_abort_cleans_every_entered_core_prefix(pg, monkeypatch, prefix):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort, retire_prefix

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture in admitted_prefix_abort(pg, prefix):
            inventory = fixture.freeze_inventory()
            assert not pg.execute(
                "SELECT managed_prefix_abort_complete(%s::jsonb)",
                (json.dumps(fixture.reservation()),),
            )[0][0]
            before = fixture.reservation()
            original = before["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
            premature = fixture.prefix_base(
                authorization=original["evidence"]["reserved"]["projectAuthorization"]["receipt"],
                status="admitted",
            )
            assert not fixture.retain_abort("bootstrap", "bootstrap", "admission", premature)
            assert fixture.reservation() == before
            fixture.erase_prefix_items(inventory)
            assert not pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[
                0
            ][0]
            retire_prefix(fixture)
            assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]
            assert fixture.reservation()["registrySnapshot"] == before["registrySnapshot"]
            assert "computeDeletion" not in fixture.reservation()
            assert "memoryDeletion" not in fixture.reservation()
            assert pg.execute("SELECT count(*) FROM byoc_setup_jobs")[0][0] == 0

    asyncio.run(scenario())


def test_managed_prefix_abort_includes_bridge_and_substrate_phase(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort, retire_prefix

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture in admitted_prefix_abort(pg, 18, substrate=True, bridge=True):
            inventory = fixture.freeze_inventory()
            assert {"inference_vertex", "inference_quota"} <= {
                item["step"] for item in inventory["bindings"]
            }
            fixture.erase_prefix_items(inventory)
            retire_prefix(fixture)
            assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]

    asyncio.run(scenario())


def test_managed_prefix_abort_refuses_pending_host_and_changed_native_absence(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture in admitted_prefix_abort(pg, 8):
            before = fixture.reservation()
            for phase in ("host_requested", "host_acknowledged", "connecting"):
                candidate = deepcopy(before)
                candidate["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"][
                    phase
                ] = {}
                assert (
                    pg.execute(
                        "SELECT managed_prefix_abort_context(%s::jsonb)", (json.dumps(candidate),)
                    )[0][0]
                    is None
                )
            candidate = deepcopy(before)
            candidate["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"][
                "reserved"
            ]["hostedCheckpoint"]["phase"] = "intent"
            assert (
                pg.execute(
                    "SELECT managed_prefix_abort_context(%s::jsonb)", (json.dumps(candidate),)
                )[0][0]
                is None
            )
            inventory = fixture.native_inventory()
            inventory["noHost"]["projectNumber"] = "999999999999"
            assert not fixture.retain_abort("inventory", "", "admission", inventory)
            assert fixture.reservation() == before

    asyncio.run(scenario())


def test_prefix_memory_catalogue_covers_every_scope_without_treating_errors_as_empty(
    pg, monkeypatch
):
    from tests.fixtures.hosted_engine_location_contract import verify_all_memory_inventory

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(verify_all_memory_inventory(pg, monkeypatch))


def test_prefix_abort_reservation_waits_for_pending_provider_reconciliation(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort
    from tests.fixtures.hosted_prefix_failure import reconcile_pending_resource

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture in admitted_prefix_abort(pg, 2, reserve=False):
            await reconcile_pending_resource(fixture)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "step",
    [
        "artifact_repo",
        "kms_key",
        "pod_service_account",
        "cmek_bucket",
        "pod_signing_secret",
        "artifact_repo_grant_copy_writer",
        "artifact_repo_grant_run_agent_reader",
        "iam_bootstrap_can_run_as_pod",
        "iam_gcs_agent_on_key",
        "iam_pod_sa_on_key",
        "iam_pod_sa_on_signing_secret",
        "iam_pod_sa_on_bucket",
        "iam_pod_sa_vertex",
        "iam_pod_sa_quota",
    ],
)
def test_failed_native_step_requires_independent_absence_before_abort(pg, monkeypatch, step):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort
    from tests.fixtures.hosted_prefix_failure import (
        bootstrap_calls,
        failed_prefix,
        finish_failed_prefix,
    )
    from tests.test_hosted_pilot_admission_postgres import _assignment
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        # Every test uses the actual authored plan/order; no synthetic success for the failed call.
        steps = _approved_bootstrap(_assignment("owner-a", 1))["steps"]
        async for fixture in admitted_prefix_abort(pg, steps.index(step), reserve=False):
            assert bootstrap_calls(fixture)[steps.index(step)]["step"] == step
            observed, call = await failed_prefix(fixture)
            finish_failed_prefix(fixture, observed, call)

    asyncio.run(scenario())


def test_failed_server_outcome_cannot_authorize_prefix_abort(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort
    from tests.fixtures.hosted_prefix_failure import assert_reservation_refused, failed_prefix

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    async def scenario():
        async for fixture in admitted_prefix_abort(pg, 2, reserve=False):
            await failed_prefix(fixture, status=500)
            assert_reservation_refused(fixture)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "step,status,failed_phase",
    [
        ("link_billing", 403, False),
        ("authorize_project", 403, True),
        ("authorize_project", 500, False),
    ],
)
def test_failed_preparation_cleanup_requires_native_reconciliation(
    pg, monkeypatch, step, status, failed_phase
):
    from tests.fixtures.hosted_preparation_failure import verify_failed_preparation_cleanup

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(verify_failed_preparation_cleanup(pg, step, status, failed_phase=failed_phase))


def test_native_prefix_operator_preserves_authority_through_restart(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_operator import verify_prefix_operator

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(verify_prefix_operator(pg))


@pytest.mark.parametrize(
    "case",
    [
        "clean",
        "lost_ack",
        "bootstrap_present",
        "iam_present",
        "denied_iam",
        "foreign_project",
        "incomplete_memory",
        "authority_changed",
    ],
)
def test_native_preparation_cleanup_preserves_authority(pg, monkeypatch, case):
    from tests.fixtures.hosted_preparation_failure import verify_failed_preparation_cleanup

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(
        verify_failed_preparation_cleanup(
            pg, "authorize_project", 403, failed_phase=True, native_case=case
        )
    )


def test_native_prefix_inventory_refuses_unknown_resources(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_inventory import verify_native_prefix_inventory

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(verify_native_prefix_inventory(pg, monkeypatch))


def test_prefix_binding_authority_matches_frozen_calls(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_binding_contract import verify_binding_contract

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    asyncio.run(verify_binding_contract(pg))
