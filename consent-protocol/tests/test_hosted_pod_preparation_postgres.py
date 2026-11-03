"""Project preparation shares the retained owner operation and monotonic CAS."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from tests.fixtures.hosted_prefix_failure import _creation_receipt
from tests.test_hosted_pilot_admission_postgres import _claim, _Client, _policy
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


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
