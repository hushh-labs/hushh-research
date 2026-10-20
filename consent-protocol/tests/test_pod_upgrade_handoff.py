from __future__ import annotations

import copy
import hashlib

import pytest

from hushh_mcp.services.pod_upgrade_handoff import (
    PodUpgradeHandoffClient,
    PodUpgradeHandoffUnavailable,
    retained_idle_evidence,
    service_incarnation,
)


@pytest.mark.parametrize("fault", [None, "missing", "partial", "hash", "order", "owner", "bool"])
def test_retained_idle_cursor_is_exact_and_legacy_updates_remain_compatible(fault):
    prefix, marker = {"seq": 2, "sha": "a" * 64}, {"seq": 3, "sha": "b" * 64}
    receipt = {
        "operationId": "operation-1",
        "incarnation": "incarnation-1",
        "runtimeEpoch": "runtime-1",
        "activeWork": 0,
        "committedCursor": prefix,
        "idleRecord": marker,
        "committedState": hashlib.sha256(
            f"operation-1|incarnation-1|2|{'a' * 64}|active=0".encode()
        ).hexdigest(),
    }
    changed = copy.deepcopy(receipt)
    if fault == "missing":
        changed.pop("idleRecord")
        changed.pop("committedCursor")
        assert retained_idle_evidence(changed, operation_id="operation-1") == {
            "handoffIncarnation": "incarnation-1"
        }
    elif fault == "partial":
        changed.pop("committedCursor")
    elif fault == "hash":
        changed["committedState"] = "c" * 64
    elif fault == "order":
        changed["idleRecord"]["seq"] = 2
    elif fault == "owner":
        changed["operationId"] = "another-operation"
    elif fault == "bool":
        changed["idleRecord"]["seq"] = True
    if fault:
        with pytest.raises(PodUpgradeHandoffUnavailable):
            retained_idle_evidence(changed, operation_id="operation-1", require_cursor=True)
        return
    result = retained_idle_evidence(changed, operation_id="operation-1", require_cursor=True)
    assert result == {
        "handoffIncarnation": "incarnation-1",
        "handoffRuntimeEpoch": "runtime-1",
        "handoffCommittedState": receipt["committedState"],
        "handoffCommittedCursor": prefix,
        "handoffIdleRecord": marker,
    }
    changed["idleRecord"]["sha"] = "d" * 64
    assert result["handoffIdleRecord"] == marker


def test_service_incarnation_uses_ready_revision_then_traffic() -> None:
    assert service_incarnation({"status": {"latestReadyRevisionName": "rev-a"}}) == "rev-a"
    assert service_incarnation({"status": {"traffic": [{"revisionName": "rev-b"}]}}) == "rev-b"
    assert service_incarnation({"status": {}}) is None


@pytest.mark.parametrize("boundary", ["budget", "release_guard", "prepare_guard"])
def test_handoff_rechecks_authority_after_identity_token_acquisition(boundary):
    admitted = [True]
    sent = []

    def guard():
        if not admitted[0]:
            raise PermissionError("worker cancelled during token acquisition")

    def budget():
        guard()
        return 10.0

    def token(_):
        admitted[0] = False
        return "synthetic-machine"

    class Session:
        def post(self, *args, **kwargs):
            sent.append(args)
            pytest.fail("cancelled lifecycle POST dispatched")

    client = PodUpgradeHandoffClient(
        url="https://pod.example",
        hushh_id="ha1-owner",
        session=Session(),
        identity_token_provider=token,
        request_budget=budget if boundary == "budget" else None,
    )
    with pytest.raises(PermissionError, match="cancelled"):
        operation = client.prepare_and_wait if boundary == "prepare_guard" else client.release
        operation(
            operation_id="synthetic-operation",
            incarnation="synthetic-generation",
            guard=None if boundary == "budget" else guard,
        )
    assert sent == []


def test_handoff_wait_rechecks_its_authority_before_each_observation():
    calls = []

    def guard():
        if len(calls) >= 2:
            raise PermissionError("synthetic worker revoked")

    client = PodUpgradeHandoffClient(url="https://pod.example", hushh_id="ha1-test")

    def request(method, path, **_):
        calls.append((method, path))
        return {}

    client._request = request
    with pytest.raises(PermissionError):
        client.prepare_and_wait(
            operation_id="operation-1", incarnation="revision-1", guard=guard, poll_seconds=0.05
        )
    assert calls == [
        ("POST", "/api/one/pod/upgrade/prepare"),
        ("GET", "/api/one/pod/upgrade/status"),
    ]


@pytest.mark.parametrize("refusal", [None, "owner", "revision", "operation", "epoch"])
def test_model_maintenance_admits_only_the_current_owner_runtime_and_operation(refusal):
    info = {"hushhId": "ha1-test", "revision": "rev-a", "podMode": True}
    status = {
        "incarnation": "rev-a",
        "state": "idle",
        "operationId": "model-attempt",
        "runtimeEpoch": "epoch-a",
    }
    if refusal == "owner":
        info["hushhId"] = "other-owner"
    elif refusal == "revision":
        info["revision"] = "rev-other"
    elif refusal == "operation":
        status["operationId"] = "different-operation"
    elif refusal == "epoch":
        status.pop("runtimeEpoch")
    client = PodUpgradeHandoffClient(url="https://pod.example", hushh_id="ha1-test")
    client._request = lambda method, path: info if path == "/pod/info" else status
    if refusal:
        with pytest.raises(PodUpgradeHandoffUnavailable):
            client.verify_maintenance_access(
                expected_revision="rev-a", operation_id="model-attempt"
            )
    else:
        client.verify_maintenance_access(expected_revision="rev-a", operation_id="model-attempt")


@pytest.mark.parametrize("refusal", [None, "owner", "revision", "model_identity"])
def test_model_maintenance_proves_runtime_and_inference_under_the_exact_pod_audience(refusal):
    calls = []
    info = {
        "hushhId": "ha1-test",
        "revision": "rev-new",
        "podMode": True,
        "memoryEnabled": True,
        "storageBackend": "commit_log",
    }
    diagnostic = {
        "provider": "azure_openai",
        "model": "one-chat",
        "reachable": True,
        "status": 200,
        "outcome": "reachable",
        "endpoint": "test.openai.azure.com",
    }
    if refusal == "owner":
        info["hushhId"] = "other-owner"
    elif refusal == "revision":
        info["revision"] = "rev-old"
    elif refusal == "model_identity":
        diagnostic["reachable"] = False

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    class Session:
        def get(self, url, *, headers, allow_redirects, **_):
            assert headers["Authorization"] == "Bearer synthetic-identity"
            assert allow_redirects is False
            calls.append(url)
            return Response(diagnostic if "/diagnostics/model?" in url else info)

    def identity(audience):
        assert audience == "https://pod.example"
        return "synthetic-identity"

    client = PodUpgradeHandoffClient(
        url="https://pod.example",
        hushh_id="ha1-test",
        session=Session(),
        identity_token_provider=identity,
    )
    if refusal:
        with pytest.raises(PodUpgradeHandoffUnavailable):
            client.verify_model(deployment="one-chat", expected_revision="rev-new")
    else:
        assert (
            client.verify_model(deployment="one-chat", expected_revision="rev-new")["reachable"]
            is True
        )
    assert calls[0] == "https://pod.example/pod/info"
    assert len(calls) == (1 if refusal in {"owner", "revision"} else 2)


@pytest.mark.parametrize("method", ["POST", "GET"])
def test_handoff_rejects_non_success_responses(monkeypatch, method: str) -> None:
    class Response:
        status_code = 401

        def json(self):
            return {"detail": "denied"}

    class Session:
        def post(self, *_args, **_kwargs):
            return Response()

        def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(
        "google.oauth2.id_token.fetch_id_token", lambda *_args, **_kwargs: "identity"
    )
    client = PodUpgradeHandoffClient(
        url="https://pod.example", hushh_id="ha1-test", session=Session()
    )
    with pytest.raises(PodUpgradeHandoffUnavailable, match="HTTP 401"):
        client._request(method, "/api/one/pod/upgrade/status")


def test_handoff_waits_for_idle_receipt_and_releases(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    responses = iter(
        [
            {"state": "draining", "operationId": "op_12345678"},
            {
                "state": "idle",
                "operationId": "op_12345678",
                "incarnation": "rev-a",
                "idleReceipt": {
                    "operationId": "op_12345678",
                    "incarnation": "rev-a",
                    "activeWork": 0,
                    "committedState": "state",
                    "runtimeEpoch": "epoch-a",
                },
            },
            {"state": "accepting"},
        ]
    )

    class Response:
        status_code = 200

        def json(self):
            return next(responses)

    class Session:
        def post(self, url, **_kwargs):
            calls.append(("POST", url))
            return Response()

        def get(self, url, **_kwargs):
            calls.append(("GET", url))
            return Response()

    monkeypatch.setattr(
        "google.oauth2.id_token.fetch_id_token", lambda *_args, **_kwargs: "identity"
    )
    client = PodUpgradeHandoffClient(
        url="https://pod.example", hushh_id="ha1-test", session=Session()
    )
    receipt = client.prepare_and_wait(
        operation_id="op_12345678", incarnation="rev-a", timeout_seconds=1
    )
    assert receipt["incarnation"] == "rev-a"
    client.release(operation_id="op_12345678", incarnation="rev-a")
    assert calls == [
        ("POST", "https://pod.example/api/one/pod/upgrade/prepare"),
        ("GET", "https://pod.example/api/one/pod/upgrade/status"),
        ("POST", "https://pod.example/api/one/pod/upgrade/release"),
    ]


@pytest.mark.parametrize("updating", [True, False])
async def test_pod_update_refusal_is_terminal_without_running_the_model(monkeypatch, updating):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from ag_ui.core import RunAgentInput

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
    from hushh_mcp.services.pod_upgrade_admission import (
        PodUpgradeAdmissionRefused,
        PodUpgradeInProgress,
    )

    refusal = PodUpgradeInProgress if updating else PodUpgradeAdmissionRefused
    monkeypatch.setattr(
        pod.ADMISSION, "acquire_turn", AsyncMock(side_effect=refusal("private details"))
    )
    sdk = AsyncMock()
    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    request = RunAgentInput(
        thread_id="synthetic-update-turn",
        run_id="synthetic-run",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )
    if updating:
        events = [event async for event in agent.run(request)]
        assert len(events) == 1
        assert events[0].code == "POD_CHAT_UPDATING"
        assert "private details" not in events[0].message
    else:
        with pytest.raises(PodUpgradeAdmissionRefused):
            await anext(agent.run(request))
    sdk.assert_not_called()
    assert request.thread_id not in pod._ACTIVE_THREADS


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["planned", "live"])
async def test_nonterminal_or_wrong_digest_provider_result_keeps_the_lease(monkeypatch, status):
    import asyncio

    from hushh_mcp.services import personal_agent_provisioning_service as pas
    from hushh_mcp.services.compute_backend import BackendHandle
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from tests.test_personal_agent_upgrade_authority import (
        NEW_IMAGE,
        OTHER_DIGEST,
        OTHER_IMAGE,
        OWNER,
        SERVICE,
        _approval,
        _ExecutingBackend,
        _ExecutionRegistry,
        _no_cloud,
        _row,
    )

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "1")
    monkeypatch.setattr(pas, "resolve_user_cloud", lambda *args, **kwargs: _no_cloud())
    row = _row(approval=_approval(_row()), lease=None)
    registry = _ExecutionRegistry(row)
    handle = BackendHandle(
        external_agent_id=SERVICE,
        a2a_route="https://a2a.invalid/owner",
        status=status,
        backend="fake",
        backend_metadata={"image": OTHER_IMAGE, "image_digest": OTHER_DIGEST},
    )
    backend = _ExecutingBackend(handle)
    idle = {
        "operationId": "op-original",
        "incarnation": "runtime-revision",
        "runtimeEpoch": "runtime-epoch",
        "activeWork": 0,
        "committedCursor": {"seq": 2, "sha": "d" * 64},
        "idleRecord": {"seq": 3, "sha": "e" * 64},
        "committedState": hashlib.sha256(
            f"op-original|runtime-revision|2|{'d' * 64}|active=0".encode()
        ).hexdigest(),
    }

    async def replacing(spec):
        await asyncio.to_thread(spec.on_upgrade_idle, idle)
        assert registry.row["backend_metadata"]["upgradeApproval"]["handoffIdleRecord"] == {
            "seq": 3,
            "sha": "e" * 64,
        }
        idle["idleRecord"]["sha"] = "changed-after-persistence"
        return handle

    monkeypatch.setattr(backend, "upgrade", replacing)
    service = PersonalAgentProvisioningService(registry=registry, backend=backend)

    with pytest.raises(RuntimeError, match="live terminal outcome|different image digest"):
        await service.upgrade_pod(user_id=OWNER, current_image=NEW_IMAGE)

    assert registry.row["backend_metadata"].get("upgradeLease")
    assert (
        registry.row["backend_metadata"]["upgradeApproval"]["handoffIdleRecord"]["sha"] == "e" * 64
    )
    assert registry.final_writes == []
