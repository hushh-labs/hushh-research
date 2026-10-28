"""Managed bootstrap intent/result CAS uses the existing PostgreSQL operation."""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests.test_hosted_pilot_admission_postgres import _claim, _policy
from tests.test_hosted_pilot_admission_postgres import pg as _pilot_pg

pg = _pilot_pg


def test_bootstrap_checkpoint_has_one_cas_winner_and_retains_successful_prefix(pg):
    from copy import deepcopy

    _policy(pg, bootstrap=True)
    reservation = _claim(pg)
    checkpoint = {
        "version": 1,
        "ownerId": "owner-a",
        "attemptId": "a" * 32,
        "expectedGeneration": 0,
        "generation": 1,
        "planDigest": reservation["hostedAdmission"]["bootstrapContractHash"],
        "phase": "intent",
        "step": "enable_services",
        "completed": [],
    }

    def publish(value):
        return pg.execute(
            "SELECT publish_hosted_pod_bootstrap_checkpoint(%s,%s,%s::jsonb)",
            ("owner-a", "a" * 32, json.dumps(value)),
        )[0][0]

    for changed in (
        {"ownerId": "owner-b"},
        {"planDigest": "b" * 64},
        {"step": "foreign_mutation"},
        {"step": None},
    ):
        assert not publish({**checkpoint, **changed})
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(publish, [checkpoint, checkpoint])) == [False, True]
    assert not publish(checkpoint)
    observed = {
        **checkpoint,
        "expectedGeneration": 1,
        "generation": 2,
        "phase": "observed",
        "completed": [{"step": "enable_services", "status": 200, "ok": True}],
    }
    assert publish(observed)
    assert publish(observed)
    changed = deepcopy(observed)
    changed["completed"][0]["status"] = 201
    assert not publish(changed)
    next_intent = {
        **observed,
        "expectedGeneration": 2,
        "generation": 3,
        "phase": "intent",
        "step": "kms_key",
    }
    assert publish(next_intent)
    assert not publish({**next_intent, "expectedGeneration": 3, "generation": 4})
    saved = pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedCheckpoint' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert saved == next_intent


def test_bootstrap_cannot_continue_after_a_failed_observation(pg):
    _policy(pg, bootstrap=True)
    reservation = _claim(pg)
    checkpoint = {
        "version": 1,
        "ownerId": "owner-a",
        "attemptId": "a" * 32,
        "expectedGeneration": 0,
        "generation": 1,
        "planDigest": reservation["hostedAdmission"]["bootstrapContractHash"],
        "phase": "intent",
        "step": "enable_services",
        "completed": [],
    }

    def publish(value):
        return pg.execute(
            "SELECT publish_hosted_pod_bootstrap_checkpoint(%s,%s,%s::jsonb)",
            ("owner-a", "a" * 32, json.dumps(value)),
        )[0][0]

    assert publish(checkpoint)
    failed = {
        **checkpoint,
        "expectedGeneration": 1,
        "generation": 2,
        "phase": "observed",
        "completed": [{"step": "enable_services", "status": 503, "ok": False}],
    }
    assert publish(failed)
    assert not publish(
        {**failed, "expectedGeneration": 2, "generation": 3, "phase": "intent", "step": "kms_key"}
    )


def test_bootstrap_worker_retains_prefix_and_refuses_unacknowledged_continuation(pg, monkeypatch):

    from hushh_mcp.services.hosted_gcp_checkpoint import (
        bind_bootstrap_checkpoint,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from tests.test_hosted_pilot_admission_postgres import _Client

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")

    _policy(pg, bootstrap=_approved_bootstrap)
    reservation = _claim(pg)
    contract = reservation["hostedAdmission"]["assignment"]["bootstrapContract"]
    client = _Client(pg)
    effects = []

    async def scenario():
        repo = PersonalAgentRegistryRepo(client)
        checkpoint, prefix = bind_bootstrap_checkpoint(
            registry=repo, reservation=reservation, plan=contract["plan"]
        )
        assert prefix == []
        with pytest.raises(RuntimeError, match="worker"):
            checkpoint("intent", contract["steps"][0], [])

        def execute():
            step = contract["steps"][0]
            checkpoint("intent", step, [])
            effects.append(step)
            checkpoint("observed", step, [{"step": step, "status": 200, "ok": True}])

        await asyncio.to_thread(execute)
        retained = pg.execute(
            "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        resumed, prefix = bind_bootstrap_checkpoint(
            registry=repo, reservation=retained, plan=contract["plan"]
        )
        assert prefix == [{"step": contract["steps"][0], "status": 200, "ok": True}]
        with pytest.raises(ValueError, match="contract"):
            bind_bootstrap_checkpoint(
                registry=repo,
                reservation=retained,
                plan={**contract["plan"], "tenancy": "user-owned"},
            )
        # Retained intent blocks restart until provider outcome is reconciled.
        await asyncio.to_thread(resumed, "intent", contract["steps"][1], prefix)
        retained = pg.execute(
            "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        with pytest.raises(RuntimeError, match="reconciliation"):
            bind_bootstrap_checkpoint(registry=repo, reservation=retained, plan=contract["plan"])
        # Lost current admission cannot advance the existing worker either.
        pg.execute(
            "SELECT publish_personal_agent_provision('owner-a',%s,'reserved','failed','{}')",
            ("a" * 32,),
        )
        with pytest.raises(RuntimeError, match="not acknowledged"):
            await asyncio.to_thread(
                resumed,
                "observed",
                contract["steps"][1],
                prefix + [{"step": contract["steps"][1], "status": 200, "ok": True}],
            )

    try:
        asyncio.run(scenario())
    finally:
        client._engine.dispose()
    assert effects == [contract["steps"][0]]


def _approved_bootstrap(assignment):
    from dataclasses import replace

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.hosted_gcp_checkpoint import bootstrap_contract
    from tests.test_hosted_gcp_backend import _hosted_deployment
    from tests.test_user_gcp_model_access_boundary import _spec

    deployment = replace(
        _hosted_deployment(),
        owner=assignment["hushhId"],
        project=assignment["project"],
        image=f"us-central1-docker.pkg.dev/{assignment['project']}/one-pod/consent-protocol-pod@sha256:"
        + "b" * 64,
    )
    plan = HostedGcpBackend(
        deployment=deployment,
        publication_source="gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64,
    ).render_bootstrap_plan(
        replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp", ingress="direct")
    )
    return bootstrap_contract(plan)


def test_completed_bootstrap_resumes_without_cloud_authentication_or_mutation(pg, monkeypatch):
    from hushh_mcp.services.byoc_bootstrap_execution import BootstrapContinuation
    from hushh_mcp.services.byoc_substrate import HushhFederatedSubstrate
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.hosted_gcp_checkpoint import bind_bootstrap_checkpoint
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from tests.test_hosted_pilot_admission_postgres import _Client

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")
    _policy(pg, bootstrap=_approved_bootstrap)
    reservation = _claim(pg)
    contract = reservation["hostedAdmission"]["assignment"]["bootstrapContract"]
    client = _Client(pg)

    def forbid_auth(**kwargs):
        pytest.fail("A fully observed bootstrap must not authenticate to the cloud")

    async def scenario():
        repo = PersonalAgentRegistryRepo(client)
        checkpoint, _ = bind_bootstrap_checkpoint(
            registry=repo, reservation=reservation, plan=contract["plan"]
        )

        def retain_complete():
            prefix = []
            for step in contract["steps"]:
                checkpoint("intent", step, prefix)
                prefix.append({"step": step, "status": 200, "ok": True})
                checkpoint("observed", step, prefix)

        await asyncio.to_thread(retain_complete)
        retained = pg.execute(
            "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        resume, prefix = bind_bootstrap_checkpoint(
            registry=repo, reservation=retained, plan=contract["plan"]
        )
        target = contract["plan"]["target"]
        ensurer = HushhFederatedSubstrate(
            project=target["project"],
            region=target["region"],
            plan_renderer=lambda _spec: contract["plan"],
            token_minter=forbid_auth,
            dry_run=False,
            bootstrap_sa=contract["plan"]["federation"]["impersonation"][
                "bootstrap_service_account"
            ],
            continuation=BootstrapContinuation(resume, prefix),
        )
        # Missing resource observations still cannot become deletion authority.
        receipt = await ensurer.ensure(
            PodSpec(
                hushh_id=reservation["intent"]["hushh_id"],
                phone_e164_hash="synthetic",
                pod_pubkey="",
            )
        )
        assert len(receipt.steps) == len(prefix)
        current = pg.execute(
            "SELECT backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedCheckpoint' FROM personal_agent_registry WHERE user_id='owner-a'"
        )[0][0]
        assert current == retained["evidence"]["reserved"]["hostedCheckpoint"]

    try:
        asyncio.run(scenario())
    finally:
        client._engine.dispose()


@pytest.mark.parametrize("refuse", [None, "general", "notification", "notification_observed"])
def test_hosted_mail_composes_both_intent_authorities_before_provider_call(monkeypatch, refuse):
    from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap
    from tests.test_byoc_bootstrap_and_custody import BORROWED, _Response, _Session

    session = _Session([_Response(200), _Response(200)])
    executor = UserGcpBootstrap(project="hussh-pilot-owner-1", token=BORROWED, session=session)
    monkeypatch.setattr(
        executor,
        "plan_calls",
        lambda _plan: [
            {"step": "core", "method": "POST", "url": "https://example.test/core"},
            {
                "step": "mail",
                "method": "POST",
                "url": "https://example.test/mail",
                "capability": "gmail_notifications",
            },
        ],
    )
    events = []

    def general(phase, step, completed):
        events.append(("general", phase, step, len(session.calls)))
        if refuse == "general" and phase == "intent" and step == "mail":
            raise RuntimeError("General admission refused")

    def notification(phase, step, completed):
        events.append(("notification", phase, step, len(session.calls)))
        assert all(item["step"] == "mail" for item in completed)
        if (refuse == "notification" and phase == "intent") or (
            refuse == "notification_observed" and phase == "observed"
        ):
            raise RuntimeError("Notification admission refused")

    arguments = {"dry_run": False, "checkpoint": general, "notification_checkpoint": notification}
    if refuse:
        with pytest.raises(RuntimeError, match="admission refused"):
            executor.apply({"tenancy": "hussh-hosted"}, **arguments)
    else:
        executor.apply({"tenancy": "hussh-hosted"}, **arguments)
    assert len(session.calls) == (1 if refuse in {"general", "notification"} else 2)
    assert ("general", "intent", "mail", 1) in events
    if refuse != "general":
        assert ("notification", "intent", "mail", 1) in events
    if refuse == "notification_observed":
        assert not any(event[:3] == ("general", "observed", "mail") for event in events)


@pytest.mark.asyncio
@pytest.mark.usefixtures("legacy_shared_files_absent")
async def test_checkpoint_conflict_does_not_terminate_the_current_provision_attempt(monkeypatch):
    from hushh_mcp.runtime_settings import get_core_security_settings
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
    from tests.test_byoc_substrate import _FakeGrant, _FakeRegistry, _RecordingBackend

    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()

    class PendingSubstrate:
        async def ensure(self, spec):
            raise ProvisionReconciliationRequired("Unresolved provider observation")

    registry, backend = _FakeRegistry(), _RecordingBackend()
    service = PersonalAgentProvisioningService(
        registry=registry, grant=_FakeGrant(), backend=backend, substrate=PendingSubstrate()
    )
    try:
        with pytest.raises(ProvisionReconciliationRequired):
            await service.provision(user_id="u1", phone_e164="+15550100")
        assert not backend.provisioned
        assert registry.rows[-1]["backend_metadata"]["provisionAttempt"]["phase"] == "reserved"
    finally:
        get_core_security_settings.cache_clear()


def test_admitted_spec_routes_to_the_existing_durable_substrate_executor(pg, monkeypatch):
    from dataclasses import replace

    from hushh_mcp.services.byoc_substrate import resolve_substrate_ensurer
    from hushh_mcp.services.compute_backend_resolution import bind_reserved_spec
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from tests.test_hosted_pilot_admission_postgres import ROOT, _Client
    from tests.test_user_gcp_model_access_boundary import _spec

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")

    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    reservation = _claim(pg)
    client = _Client(pg)

    async def scenario():
        from tests.hosted_pod_support import prepared_project_journal

        retained = await prepared_project_journal(pg, reservation, client)
        repo = PersonalAgentRegistryRepo(client)
        assert not await repo.hosted_execution_current(
            purpose="provision",
            owner_id=retained["ownerId"],
            attempt_id=retained["attemptId"],
            admission=retained["hostedAdmission"],
            project_observation=retained["evidence"]["reserved"]["projectObservation"],
        )
        bound = await bind_reserved_spec(
            replace(
                _spec(),
                hushh_id=reservation["intent"]["hushh_id"],
                deployment_target="gcp",
                provision_attempt_id=reservation["attemptId"],
            ),
            retained,
            registry=PersonalAgentRegistryRepo(client),
            purpose="bootstrap",
            release={
                "sourceRevision": "a" * 40,
                "image": "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64,
            },
        )
        assert bound.ingress == "direct"
        substrate = resolve_substrate_ensurer(bound)
        authority = bound.hosted_admission_guard
        assert substrate._continuation is authority.continuation
        assert (
            substrate._render_plan(bound)
            == reservation["hostedAdmission"]["assignment"]["bootstrapContract"]["plan"]
        )
        assert substrate._dry_run is False
        # Classification/plan construction must never authenticate or mutate.
        with pytest.raises(RuntimeError, match="worker"):
            authority()

    try:
        asyncio.run(scenario())
    finally:
        client._engine.dispose()
