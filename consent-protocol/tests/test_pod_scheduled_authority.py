"""Real sealed claims and signed bindings, without minting a browser session."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
from hushh_mcp.services.pod_scheduled_lease import ScheduledExecutionLease
from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks
from tests.test_pod_scheduled_tasks import schedule_request
from tests.test_pod_session_authority import OWNER, USER, Subject, World, _binding
from tests.test_pod_session_authority import hub_key as hub_key


@pytest.fixture
async def admitted_task(tmp_path, hub_key, monkeypatch):
    world = World(tmp_path)
    authority = await world.boot()
    subject = Subject("scheduled-owner", "web")
    session_token, session_claims = await world.admit(
        subject, _binding(subject, scopes=["pod.act", "pkm.read", "pod.status"])
    )
    monkeypatch.setenv("HUSSH_ID", OWNER)
    clock = [int(time.time())]
    grants = ScheduledGrantAuthority(
        authority, USER, authority.require_held, clock=lambda: clock[0]
    )
    runtime = ScheduledTasks(
        access=ScheduleAccess(USER, OWNER, "epoch", authority.require_held),
        log=world.log,
        capabilities={
            "agent_one.execute_task.v1": SimpleNamespace(
                required_scopes=("pod.act", "pkm.read"),
                max_active_seconds=600,
                prepare=AsyncMock(
                    return_value={
                        "source_revision": 1,
                        "agent_version": "1.0.0",
                        "model_binding": {
                            "provider": "gemini",
                            "model": "synthetic",
                            "runtime_mode": "byok",
                            "selection_revision": 1,
                        },
                    }
                ),
            )
        },
        delivery=SimpleNamespace(require_ready=lambda: None, offer=AsyncMock()),
        admission=SimpleNamespace(),
        check_grant=grants.check_grant,
        clock=lambda: clock[0],
    )
    created = await runtime.create(
        schedule_request(
            capability="agent_one.execute_task.v1",
            first_run_at=clock[0] + 1,
            authorization_expires_at=clock[0] + 600,
        ),
        grant={"subject_id": subject.subject_id, "version": 1, "scopes": ["pod.upgrade"]},
    )
    clock[0] += 2
    delivery = runtime.delivery.offer.call_args.args
    claimed = await runtime.runner._claim(*delivery[:3], 600)
    lease = ScheduledExecutionLease(runtime.journal, claimed)
    return SimpleNamespace(
        world=world,
        authority=authority,
        subject=subject,
        session_token=session_token,
        session_claims=session_claims,
        runtime=runtime,
        invocation=grants.invocation(lease),
        lease=lease,
        clock=clock,
        row=created,
    )


async def test_task_admission_attenuates_scopes_and_closes_the_private_handle(admitted_task):
    task = admitted_task
    invocation = task.invocation
    with invocation.bind() as reference:
        token = resolve_request_secret(reference)
        assert not token.startswith("pod-session:")
        from hushh_mcp.services.pod_session_authority import PodSessionRefused

        with pytest.raises(PodSessionRefused):
            task.authority.verify_session(token)
        assert (await invocation.verify(token, expected_scope="pkm.read")).valid
        assert not (await invocation.verify(reference, expected_scope="pkm.read")).valid
        for scope in ("pod.status", "pod.upgrade", "files.manage", "browser.invoke", ""):
            assert not (await invocation.verify(token, expected_scope=scope)).valid
        await invocation.owner_read_admission(USER, token)
        with pytest.raises(PermissionError):
            await invocation.owner_read_admission("another-owner", token)
        public = await task.runtime.get(task.row["id"])
        assert "grant" not in public and "terms" not in public
        assert token not in str(await task.world.log.replay())
    assert resolve_request_secret(reference) == ""
    assert not (await invocation.verify(token, expected_scope="pkm.read")).valid


async def test_closing_task_handle_during_authority_read_refuses(admitted_task, monkeypatch):
    invocation = admitted_task.invocation
    entered, release = asyncio.Event(), asyncio.Event()
    original = invocation.grants.binding

    async def delayed(grant):
        binding = await original(grant)
        entered.set()
        await release.wait()
        return binding

    monkeypatch.setattr(invocation.grants, "binding", delayed)
    with invocation.bind() as reference:
        token = resolve_request_secret(reference)
        reading = asyncio.create_task(invocation.verify(token, expected_scope="pkm.read"))
        try:
            await asyncio.wait_for(entered.wait(), 2)
        except BaseException:
            reading.cancel()
            await asyncio.gather(reading, return_exceptions=True)
            raise
    release.set()
    assert not (await asyncio.wait_for(reading, 2)).valid


@pytest.mark.parametrize(
    "change",
    [
        "revoked",
        "superseded",
        "expiry",
        "lease",
        "terms",
        "claim",
        "scopes",
        "owner",
        "incarnation",
        "horizon",
    ],
)
async def test_current_occurrence_and_grant_required_on_every_access(admitted_task, change):
    task = admitted_task
    with task.invocation.bind() as reference:
        token = resolve_request_secret(reference)
        assert (await task.invocation.verify(token, expected_scope="pkm.read")).valid
        if change == "revoked":
            await task.authority.revoke_subject(task.subject.subject_id)
        elif change == "superseded":
            await task.world.admit(task.subject, _binding(task.subject, version=2))
        elif change in {"expiry", "lease"}:
            task.clock[0] = task.lease.claimed["last_run"][
                "deadline_at" if change == "expiry" else "lease_until"
            ]
        else:

            def edit(rows):
                row = rows[task.row["id"]]
                if change == "claim":
                    row["last_run"]["claim_id"] = "a" * 32
                elif change == "scopes":
                    row["grant"]["scopes"].append("pod.upgrade")
                else:
                    key, value = {
                        "terms": ("terms", {"source_revision": 2}),
                        "owner": ("owner_id", "different-owner"),
                        "incarnation": ("incarnation", "replacement"),
                        "horizon": ("authorization_expires_at", task.clock[0] + 1200),
                    }[change]
                    row[key] = value
                row["revision"] += 1
                return row

            await task.runtime.journal.change(edit)
        assert not (await task.invocation.verify(token, expected_scope="pkm.read")).valid


async def test_task_authority_uses_specialist_owner_read_port_without_a_fake_session(
    admitted_task, monkeypatch
):
    from hushh_mcp.services import pod_owner_read_ports
    from hushh_mcp.services.pod_specialist_runtime import build_pod_specialist_runtime

    task = admitted_task
    captured = []
    original = pod_owner_read_ports.owner_read_ports

    def ports(*args, **kwargs):
        result = original(*args, feed=SimpleNamespace(), **kwargs)
        captured.append(result)
        return result

    monkeypatch.setattr(pod_owner_read_ports, "owner_read_ports", ports)
    with task.invocation.bind() as reference:
        token = resolve_request_secret(reference)
        runtime = build_pod_specialist_runtime(
            user_id=USER,
            hushh_id=OWNER,
            consent_token=token,
            provider="gemini",
            model="synthetic",
            runtime_mode="byok",
            credential=None,
            credential_transport="developer_api",
            vertex_project=None,
            vertex_location=None,
            data_door_grants={},
            verifier=task.invocation.verify,
            invocation_deadline_ms=task.invocation.deadline_ms,
            owner_read_admission=task.invocation.owner_read_admission,
        )
        assert await runtime.admit_owner(USER, token) == task.invocation.deadline_ms
        assert task.invocation.deadline_ms > int(time.time() * 1000) + 180_000
        await captured[0].consent_center.authorize_owner_tool(USER, token)
        await task.authority.revoke_subject(task.subject.subject_id)
        with pytest.raises(PermissionError):
            await captured[0].consent_center.authorize_owner_tool(USER, token)


@pytest.mark.parametrize("deadline", [True, 0, -1, 10**15])
def test_specialist_refuses_an_unbounded_task_deadline(deadline):
    from hushh_mcp.services.pod_specialist_runtime import _invocation_deadline

    with pytest.raises(PermissionError):
        _invocation_deadline(deadline)


async def test_connector_task_context_cannot_change_the_configured_owner(
    admitted_task, monkeypatch
):
    from hushh_mcp.one_adk import pod_connector_tools as tools

    task = admitted_task
    monkeypatch.setattr(tools, "owner_cloud_agent", lambda: True)
    monkeypatch.setattr(tools, "pod_owner_user_id", lambda: USER)
    with task.invocation.bind() as reference:
        context = SimpleNamespace(
            user_id=USER,
            invocation_id="scheduled_" + task.lease.claimed["last_run"]["id"],
            state={
                "hussh:user_id": USER,
                "hussh:conversation_id": "scheduled_" + task.lease.claimed["last_run"]["id"],
                "temp:one_execution_surface": "scheduled_task",
                "hussh:consent_token": reference,
            },
        )
        assert await tools.pod_tool_owner(context, "gmail") == USER
        monkeypatch.setattr(tools, "pod_owner_user_id", lambda: "another-owner")
        assert await tools.pod_tool_owner(context, "gmail") is None
    monkeypatch.setattr(tools, "pod_owner_user_id", lambda: USER)
    assert await tools.pod_tool_owner(context, "gmail") is None


async def test_scheduled_model_uses_sealed_identity_across_cache_restart(
    admitted_task, monkeypatch
):
    from hushh_mcp.services import pod_ai_selection as selections
    from hushh_mcp.services import pod_owner_cloud
    from hushh_mcp.services.pod_ai_selection_seal import OpenedSelection
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
    from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model

    task = admitted_task
    monkeypatch.setattr(pod_owner_cloud, "owner_cloud_agent", lambda: True)
    opened = OpenedSelection(
        provider="openai",
        model="synthetic-model",
        api_key="PRIVATE_MODEL_KEY",
        transport=None,
        vertex_project=None,
        vertex_location=None,
        issued_at_ms=1,
        selection_id="00000000-0000-4000-8000-000000000001",
    )
    try:
        await selections.record_ai_selection(
            task.world.log, hushh_id=OWNER, opened=opened, checked_at_ms=1
        )
        model = await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)
        assert model.binding.model == "synthetic-model" and model.binding.selection_revision == 1
        assert "PRIVATE_MODEL_KEY" not in repr(model) + model.binding.model_dump_json()
        selections.set_active_ai_selection(None)  # process reload is not a persisted clear
        again = await resolve_scheduled_model(
            task.world.log, pod_id=OWNER, check=task.lease.check, expected=model.binding
        )
        assert again.binding == model.binding
        await selections.clear_ai_selection(task.world.log, hushh_id=OWNER)
        with pytest.raises(ScheduleRefused, match="SCHEDULE_MODEL_CHANGED"):
            await resolve_scheduled_model(
                task.world.log, pod_id=OWNER, check=task.lease.check, expected=model.binding
            )
        # An unreadable latest selection must not look like a cleared key.
        await task.world.log.append(
            selections.POD_AI_SELECTION_RECORD_KIND,
            {"hushh_id": OWNER, "issuedAtMs": 2, "private": "PRIVATE_INVALID"},
        )
        with pytest.raises(ScheduleRefused, match="^SCHEDULE_MODEL_UNAVAILABLE$"):
            await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)
    finally:
        selections.set_active_ai_selection(None)


async def test_scheduled_model_and_one_task_prepare_allow_activating_older_saved_provider(
    admitted_task, monkeypatch
):
    from hushh_mcp.services import pod_ai_selection as selections
    from hushh_mcp.services import pod_owner_cloud
    from hushh_mcp.services.pod_ai_selection_seal import (
        STALE_SELECTION,
        AiSelectionRefused,
        OpenedSelection,
    )
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
    from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model
    from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask

    task = admitted_task
    monkeypatch.setattr(pod_owner_cloud, "owner_cloud_agent", lambda: True)
    gemini_opened = OpenedSelection(
        provider="gemini",
        model="gemini-2.5-flash",
        api_key="PRIVATE_GEMINI_KEY",
        transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        issued_at_ms=10,
        selection_id="00000000-0000-4000-8000-000000000010",
    )
    openai_opened = OpenedSelection(
        provider="openai",
        model="synthetic-model",
        api_key="PRIVATE_OPENAI_KEY",
        transport=None,
        vertex_project=None,
        vertex_location=None,
        issued_at_ms=20,
        selection_id="00000000-0000-4000-8000-000000000020",
    )
    try:
        await selections.record_ai_selection(
            task.world.log, hushh_id=OWNER, opened=gemini_opened, checked_at_ms=10
        )
        await selections.record_ai_selection(
            task.world.log, hushh_id=OWNER, opened=openai_opened, checked_at_ms=20
        )
        await selections.activate_saved_ai_selection(
            task.world.log, hushh_id=OWNER, provider="gemini", checked_at_ms=30
        )

        resolved = await resolve_scheduled_model(
            task.world.log, pod_id=OWNER, check=task.lease.check
        )
        assert resolved.binding.provider == "gemini"
        assert resolved.binding.selection_revision == 20
        assert resolved.binding.selection_issued_at_ms == 10

        one_task = ScheduledOneTask(task.invocation.grants, task.world.log, task.lease.check)
        prepared = await one_task.prepare({"goal": "Rebalance Q4"})
        assert prepared["model_binding"]["provider"] == "gemini"
        assert prepared["model_binding"]["selection_revision"] == 20
        assert prepared["model_binding"]["selection_issued_at_ms"] == 10

        await selections.delete_provider_ai_selection(
            task.world.log, hushh_id=OWNER, provider="openai"
        )
        prepared_after_delete = await one_task.prepare({"goal": "Rebalance Q4"})
        assert prepared_after_delete["model_binding"]["provider"] == "gemini"

        # Negative control: non-positive issued_at_ms is refused.
        await task.world.log.append(
            selections.POD_AI_SELECTION_RECORD_KIND,
            {
                "hushh_id": OWNER,
                "version": 1,
                "provider": "openai",
                "apiKey": "PRIVATE_BOGUS_ZERO",
                "issuedAtMs": 0,
                "selectionId": "00000000-0000-4000-8000-000000000030",
            },
        )
        with pytest.raises(ScheduleRefused, match="^SCHEDULE_MODEL_SELECTION_INVALID$"):
            await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)

        # Negative control: issued_at_ms > floor (non-int issuedAtMs skipped by floor) is refused.
        await task.world.log.append(
            selections.POD_AI_SELECTION_RECORD_KIND,
            {
                "hushh_id": OWNER,
                "version": 1,
                "provider": "openai",
                "apiKey": "PRIVATE_BOGUS_HIGH",
                "issuedAtMs": "999",
                "selectionId": "00000000-0000-4000-8000-000000000040",
            },
        )
        with pytest.raises(ScheduleRefused, match="^SCHEDULE_MODEL_SELECTION_INVALID$"):
            await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)

        # Negative control: clearing preserves floor so replaying an older envelope fails.
        await selections.clear_ai_selection(task.world.log, hushh_id=OWNER)
        with pytest.raises(AiSelectionRefused, match=STALE_SELECTION):
            await selections.record_ai_selection(
                task.world.log, hushh_id=OWNER, opened=gemini_opened, checked_at_ms=40
            )
    finally:
        selections.set_active_ai_selection(None)


@pytest.mark.parametrize("cloud", ["gcp", "azure"])
async def test_scheduled_cloud_model_binds_provider_and_destination(
    admitted_task, monkeypatch, cloud
):
    from hushh_mcp import runtime_settings
    from hushh_mcp.runtime_providers import azure_openai, factory
    from hushh_mcp.services import (
        agent_chat_service,
        pod_inference_bridge,
        pod_owner_cloud,
        pod_workload_identity,
    )
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
    from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model

    task = admitted_task
    configured = SimpleNamespace(provider="openai", name="synthetic-model")
    monkeypatch.setattr(pod_owner_cloud, "owner_cloud_agent", lambda: True)
    monkeypatch.setattr(runtime_settings, "pod_user_adc_enabled", lambda: True)
    monkeypatch.setattr(
        agent_chat_service,
        "load_one_agent_runtime_manifest",
        lambda: SimpleNamespace(model=configured),
    )
    monkeypatch.setattr(pod_inference_bridge, "owner_inference_bridge", lambda: None)
    monkeypatch.setattr(
        factory.ManagedGeminiRuntimeBinding,
        "from_environment",
        lambda: SimpleNamespace(
            auth_mode="vertex_adc", project="synthetic-project", primary_location="us-central1"
        ),
    )
    topology = SimpleNamespace(
        endpoint="https://synthetic.openai.azure.com/", deployment="synthetic-deployment"
    )
    monkeypatch.setattr(
        azure_openai, "azure_openai_topology", lambda: topology if cloud == "azure" else None
    )
    identity = ["synthetic-identity"]
    monkeypatch.setattr(pod_workload_identity, "workload_client_id", lambda: identity[0])
    if cloud == "gcp":
        with pytest.raises(ScheduleRefused, match="SCHEDULE_MODEL_UNAVAILABLE"):
            await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)
        configured.provider = "gemini"
    target = await resolve_scheduled_model(task.world.log, pod_id=OWNER, check=task.lease.check)
    assert target.binding.runtime_mode == ("user_adc" if cloud == "gcp" else "user_azure_mi")
    assert target.binding.provider == ("gemini" if cloud == "gcp" else "azure_openai")
    if cloud == "gcp":
        monkeypatch.setattr(
            pod_inference_bridge,
            "owner_inference_bridge",
            lambda: SimpleNamespace(
                project="synthetic-bridge",
                service_account="synthetic@synthetic-project.iam.gserviceaccount.com",
            ),
        )
    else:
        identity[0] = "replacement-identity"
    with pytest.raises(ScheduleRefused, match="SCHEDULE_MODEL_CHANGED"):
        await resolve_scheduled_model(
            task.world.log, pod_id=OWNER, check=task.lease.check, expected=target.binding
        )


async def test_active_scheduled_tasks_registers_one_goal_capability_and_sentinel_model_without_chat_key(
    tmp_path, hub_key, monkeypatch
):
    from hushh_mcp.services import (
        agent_chat_service,
        pod_memory_service,
        pod_owner_cloud,
        pod_scheduled_runtime,
        pod_session_authority,
    )
    from hushh_mcp.services.chat_key import request_has_chat_key
    from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model
    from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask
    from hushh_mcp.services.pod_scheduled_tasks import KIND

    world = World(tmp_path)
    authority = await world.boot()
    subject = Subject("scheduled-goal-owner", "web")
    await world.admit(subject, _binding(subject, scopes=["pod.act", "pkm.read", "pod.status"]))

    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_URL", "http://127.0.0.1:8082")
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_TOKEN", "surrogate-token")
    monkeypatch.setenv("HUSSH_SENTINEL_VERTEX_PROJECT", "hushh-pda-dev")
    monkeypatch.setenv("HUSSH_SENTINEL_VERTEX_LOCATION", "global")
    monkeypatch.setattr(pod_session_authority, "active_session_authority", lambda: authority)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: world.log)
    monkeypatch.setattr(pod_owner_cloud, "hosted_ace_runtime", lambda: True)
    monkeypatch.setattr(
        agent_chat_service,
        "load_one_agent_runtime_manifest",
        lambda: SimpleNamespace(model=SimpleNamespace(provider="gemini", name="gemini-2.5-flash")),
    )

    assert request_has_chat_key(USER) is False

    runtime = pod_scheduled_runtime.active_scheduled_tasks()
    assert "agent_files.organize_file.v1" in runtime.capabilities
    assert "agent_one.execute_task.v1" in runtime.capabilities
    assert isinstance(runtime.capabilities["agent_one.execute_task.v1"], ScheduledOneTask)

    # List endpoint exposes all registered capabilities cleanly:
    from api.routes.one import pod_scheduled_tasks as route_module

    monkeypatch.setattr(runtime.delivery, "require_ready", lambda: None)
    monkeypatch.setattr(runtime.delivery, "offer", AsyncMock())
    monkeypatch.setattr(
        route_module,
        "verified_session",
        lambda *_args, **_kwargs: (
            authority,
            {"user_id": USER, "subject_id": subject.subject_id, "version": 1},
        ),
    )
    listed = await route_module.list_tasks(SimpleNamespace(headers={}), authorization="Bearer ok")
    assert listed["available"] is True
    assert listed["templates"] == ["agent_files.organize_file.v1", "agent_one.execute_task.v1"]

    # Sentinel model resolves cleanly without X-Hussh-Chat-Key:
    resolved = await resolve_scheduled_model(world.log, pod_id=OWNER, check=authority.require_held)
    assert resolved.binding.runtime_mode == "sentinel_vertex"
    assert resolved.binding.provider == "gemini"
    assert resolved.binding.destination["project"] == "hushh-pda-dev"

    # Scheduling a goal via agent_one.execute_task.v1 seals it in PodCommitLog with zero plaintext on disk:
    now = int(time.time())
    goal_secret = "SECRET_SCHEDULED_GOAL_REBALANCE_99"
    created = await runtime.create(
        schedule_request(
            capability="agent_one.execute_task.v1",
            parameters={"goal": goal_secret},
            first_run_at=now + 60,
            authorization_expires_at=now + 600,
        ),
        grant={"subject_id": subject.subject_id, "version": 1},
    )
    assert created["capability"] == "agent_one.execute_task.v1"
    replayed = await world.log.replay()
    task_records = [r for r in replayed if r["kind"] == KIND]
    assert len(task_records) >= 1
    assert task_records[-1]["payload"]["state"] == "scheduled"
    assert task_records[-1]["payload"]["terms"]["goal"] == goal_secret
    assert (
        task_records[-1]["payload"]["terms"]["model_binding"]["runtime_mode"] == "sentinel_vertex"
    )

    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert goal_secret.encode("utf-8") not in path.read_bytes()


def test_active_scheduled_tasks_refuses_non_dev_or_fenced_authority(tmp_path, hub_key, monkeypatch):
    from hushh_mcp.services import pod_memory_service, pod_scheduled_runtime, pod_session_authority
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

    monkeypatch.setattr(pod_session_authority, "active_session_authority", lambda: None)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: None)
    with pytest.raises(ScheduleRefused, match="SCHEDULE_AUTHORITY_UNAVAILABLE"):
        pod_scheduled_runtime.active_scheduled_tasks()

    prod_authority = SimpleNamespace(environment="production")
    monkeypatch.setattr(pod_session_authority, "active_session_authority", lambda: prod_authority)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: object())
    with pytest.raises(ScheduleRefused, match="SCHEDULE_AUTHORITY_UNAVAILABLE"):
        pod_scheduled_runtime.active_scheduled_tasks()
