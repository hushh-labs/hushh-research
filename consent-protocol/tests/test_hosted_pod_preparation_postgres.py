"""Project preparation shares the retained owner operation and monotonic CAS."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from tests.test_hosted_pilot_admission_postgres import _claim, _Client, _policy
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


@pytest.mark.parametrize("expire_after_ack", [False, True])
def test_project_preparation_has_one_intent_winner_and_refuses_foreign_readback(
    pg, expire_after_ack
):
    _policy(pg, preparation=True, ttl="2 seconds" if expire_after_ack else "1 day")
    reservation = _claim(pg)
    admission = reservation["hostedAdmission"]
    assignment = admission["assignment"]
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
        result = {
            "step": "create_project",
            "status": 200,
            "ok": True,
            "resourceObservation": {
                "type": "gcp_project",
                "id": assignment["project"],
                "disposition": "created",
                "identity": {
                    "projectId": assignment["project"],
                    "projectNumber": assignment["projectNumber"],
                    "lifecycleState": "ACTIVE",
                    "parent": {"type": "folder", "id": "123456789"},
                    "labels": {
                        "created-by": "hussh-one",
                        "tenancy": "hussh-hosted",
                        "hussh-environment": "dev",
                        "hussh-provision-attempt": reservation["attemptId"],
                    },
                },
            },
        }
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
