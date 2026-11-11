"""Direct command admission keeps device roles and queued work outside semantics."""

import asyncio
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_commands
from tests.test_pod_session_authority import Subject, World, _binding
from tests.test_pod_session_authority import hub_key as hub_key


@pytest.mark.parametrize("platform", ["gcp", "azure"])
async def test_direct_transcription_requires_an_app_scope_before_model_access(
    tmp_path, hub_key, monkeypatch, platform
):
    monkeypatch.setattr("api.routes.one.pod_capabilities.workload_platform", lambda: platform)
    world = World(tmp_path)
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        pod_commands, "ADMISSION", SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    )
    brain = SimpleNamespace(transcribe=AsyncMock(return_value="synthetic transcript"))
    model = AsyncMock(return_value=brain)
    monkeypatch.setattr(pod_commands, "_brain", model)
    app = FastAPI()
    app.include_router(pod_commands.router)
    app_subject = Subject("app", "web")
    device = Subject("device", "macos")
    valid, _ = await world.admit(app_subject, _binding(app_subject))
    device_token, _ = await world.admit(device, _binding(device))
    limited = Subject("limited", "web")
    limited_token, _ = await world.admit(limited, _binding(limited, scopes=["pod.status"]))
    with TestClient(app) as client:
        for token, code in [(device_token, "role_mismatch"), (limited_token, "scope_not_granted")]:
            result = client.post(
                "/api/one/pod/commands/transcriptions",
                json={"audio_base64": "a" * 64},
                headers={"Authorization": "Bearer " + token},
            )
            assert result.status_code == 403
            assert result.json()["detail"]["code"] == code
        model.assert_not_awaited()
        result = client.post(
            "/api/one/pod/commands/transcriptions",
            json={"audio_base64": "a" * 64},
            headers={"Authorization": "Bearer " + valid},
        )
        if platform == "azure":
            assert result.status_code == 503
            assert result.json()["detail"]["code"] == "COMMAND_MODEL_UNAVAILABLE"
            model.assert_not_awaited()
        else:
            assert result.status_code == 200
            assert result.json() == {"transcript": "synthetic transcript"}
            model.assert_awaited_once()
        permit.release.assert_awaited_once()


async def test_queued_command_deadline_releases_drain_permit_without_model_work(monkeypatch):
    authority = SimpleNamespace(require_held=AsyncMock())
    monkeypatch.setattr(
        pod_commands, "verified_session", lambda *args, **kwargs: (authority, {"user_id": "owner"})
    )
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        pod_commands, "ADMISSION", SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    )
    monkeypatch.setattr(pod_commands, "_slots", asyncio.Semaphore(0))
    timeout = asyncio.timeout
    monkeypatch.setattr(pod_commands.asyncio, "timeout", lambda _seconds: timeout(0.01))
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    with pytest.raises(HTTPException) as refused:
        async with pod_commands._admitted("Bearer synthetic", request):
            pytest.fail("queued request must not enter model stage")
    assert refused.value.detail["code"] == "COMMAND_PROVIDER_UNAVAILABLE"
    permit.release.assert_awaited_once()


@pytest.mark.parametrize("operation", ["proposals", "rewrite"])
async def test_memory_preparation_refuses_wrong_owner_and_device_before_generation(
    tmp_path, hub_key, monkeypatch, operation
):
    from api.routes.one import pod_pkm_preparation as preparation
    from tests.test_pod_session_authority import USER

    world = World(tmp_path)
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    monkeypatch.setattr(preparation, "_require_enabled", lambda: None)
    monkeypatch.setattr(preparation, "active_ai_selection", lambda: None)
    from hushh_mcp.services import pod_ai_selection

    monkeypatch.setattr(pod_ai_selection, "_REVISION", 1)
    monkeypatch.setattr(pod_ai_selection, "_ACTIVE", None)
    monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", False)
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        pod_commands, "ADMISSION", SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    )
    model = SimpleNamespace(provider="gemini", model="synthetic", runtime_mode="byok")
    model_builder = Mock(return_value=model)
    monkeypatch.setattr(preparation, "_owner_model", model_builder)
    payload = {
        "agent_id": "pkm_structure",
        "agent_name": "Structure",
        "model": "synthetic",
        "used_fallback": False,
        "candidate_payload": {},
        "structure_decision": {},
    }
    if operation == "rewrite":
        payload = preparation.RewriteMemoryResponse(markdown="# Memory\n- Notebook preference.\n")
    generator = AsyncMock(return_value=payload)
    if operation == "rewrite":
        monkeypatch.setattr(preparation, "rewrite_chat_memory", generator)
    else:
        monkeypatch.setattr(
            preparation,
            "OwnerPkmPreparation",
            lambda **kw: SimpleNamespace(generate_structure_preview=generator),
        )

    def body(owner):
        if operation == "proposals":
            return {"user_id": owner, "message": "Synthetic notebook preference"}
        return {
            "user_id": owner,
            "current_markdown": "",
            "messages": [
                {
                    "id": "new-1",
                    "conversationId": "chat-1",
                    "role": "user",
                    "content": "Synthetic notebook preference",
                }
            ],
        }

    app_subject, device = Subject("app", "web"), Subject("device", "macos")
    app_token, _ = await world.admit(app_subject, _binding(app_subject))
    device_token, _ = await world.admit(device, _binding(device))
    limited = Subject("limited", "web")
    limited_token, _ = await world.admit(limited, _binding(limited, scopes=["pod.status"]))
    app = FastAPI()
    app.include_router(preparation.router)
    with TestClient(app) as client:
        for token, owner, code in (
            (device_token, USER, "role_mismatch"),
            (app_token, "someone-else", "POD_MEMORY_OWNER_MISMATCH"),
            (limited_token, USER, "scope_not_granted"),
        ):
            response = client.post(
                f"/api/one/pod/memory/{operation}",
                json=body(owner),
                headers={"Authorization": "Bearer " + token},
            )
            assert response.status_code == 403
            assert response.json()["detail"]["code"] == code
        model_builder.assert_not_called()
        generator.assert_not_awaited()
        response = client.post(
            f"/api/one/pod/memory/{operation}",
            json=body(USER),
            headers={"Authorization": "Bearer " + app_token},
        )
        assert response.status_code == 200
        generator.assert_awaited_once()
        if operation == "rewrite":
            assert generator.call_args.kwargs["model"] is model
            assert response.headers["cache-control"] == "private, no-store"
        else:
            assert generator.call_args.kwargs["user_id"] == USER

        async def changed_selection(*_args, **_kw):
            pod_ai_selection.set_active_ai_selection(None)
            pod_ai_selection.set_active_ai_selection(None)
            return payload

        generator.side_effect = changed_selection
        response = client.post(
            f"/api/one/pod/memory/{operation}",
            json=body(USER),
            headers={"Authorization": "Bearer " + app_token},
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "OWNER_AI_SELECTION_CHANGED"
        if operation == "rewrite":
            generator.side_effect = RuntimeError("Private model details must stay private")
            response = client.post(
                "/api/one/pod/memory/rewrite",
                json=body(USER),
                headers={"Authorization": "Bearer " + app_token},
            )
            assert response.status_code == 503
            assert response.json() == {"detail": {"code": "MEMORY_REWRITE_UNAVAILABLE"}}


async def test_private_memory_model_port_never_builds_managed_fallback(monkeypatch):
    from hushh_mcp.services import pod_pkm_preparation as preparation

    access = AsyncMock()
    owned_model = object()
    monkeypatch.setattr(preparation, "build_single_turn_agent", lambda *a, **kw: kw["model"])
    monkeypatch.setattr(
        preparation, "run_single_turn", AsyncMock(side_effect=RuntimeError("unavailable"))
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pkm_agent_lab_service.build_managed_runtime_client",
        lambda *a, **kw: pytest.fail("an owner model must never fall back to managed inference"),
    )
    service = preparation.OwnerPkmPreparation(
        model=owned_model, user_id="owner", require_access=access
    )
    result = await service._run_agent_contract(
        manifest=SimpleNamespace(id="pkm_structure"), prompt="Synthetic fixture", response_schema={}
    )
    assert result is None
    assert access.await_count == 2
    preparation.run_single_turn.assert_awaited_once()


def test_memory_preparation_logs_one_content_free_outcome_per_attempt(monkeypatch, caplog):
    from api.routes.one import pod_pkm_preparation as preparation

    claims, queue = {"user_id": "owner"}, {"timed_out": False}

    @asynccontextmanager
    async def admitted(_authorization, _request):
        # The real queue deadline raises this before yielding (test above).
        if queue["timed_out"]:
            raise HTTPException(503, detail={"code": "COMMAND_PROVIDER_UNAVAILABLE"})
        yield claims

    authority = SimpleNamespace(require_held=AsyncMock())
    monkeypatch.setattr(preparation, "_require_enabled", lambda: None)
    monkeypatch.setattr(preparation, "_admitted", admitted)
    monkeypatch.setattr(preparation, "_selection", lambda: None)
    monkeypatch.setattr(preparation, "ai_selection_revision", lambda: 1)
    monkeypatch.setattr(preparation, "verified_session", lambda *a, **kw: (authority, claims))
    model = SimpleNamespace(provider="gemini", model="synthetic", runtime_mode="byok")
    monkeypatch.setattr(preparation, "_owner_model", lambda: model)
    payload = {
        "agent_id": "pkm_structure",
        "agent_name": "Structure",
        "model": "synthetic",
        "used_fallback": False,
        "candidate_payload": {},
        "structure_decision": {},
    }
    generator = AsyncMock(return_value=payload)
    monkeypatch.setattr(
        preparation,
        "OwnerPkmPreparation",
        lambda **kw: SimpleNamespace(generate_structure_preview=generator),
    )
    app = FastAPI()
    app.include_router(preparation.router)
    caplog.set_level(logging.INFO, logger="api.routes.one.pod_pkm_preparation")
    body = {"user_id": "owner", "message": "Synthetic notebook preference"}
    body["capture_source"] = "app_activity_digest"
    route = "/api/one/pod/memory/proposals"
    with TestClient(app) as client:
        refused = client.post(
            route, json={**body, "user_id": "someone-else"}, headers={"X-PKM-Chunk-Index": "1"}
        )
        assert refused.status_code == 403
        # A malformed logging-only header never refuses the request.
        assert client.post(route, json=body, headers={"X-PKM-Chunk-Index": "x"}).status_code == 200
        generator.return_value = {**payload, "used_fallback": True}
        assert client.post(route, json=body).status_code == 503
        unsupported = HTTPException(503, detail={"code": "POD_MEMORY_MODEL_UNAVAILABLE"})
        monkeypatch.setattr(preparation, "_owner_model", Mock(side_effect=unsupported))
        assert client.post(route, json=body).status_code == 503
        queue["timed_out"] = True
        assert client.post(route, json=body).status_code == 503
    # The logging-only source never reaches the memory agents.
    assert all("capture_source" not in call.kwargs for call in generator.call_args_list)
    lines = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("pkm.memory_proposal.outcome ")
    ]
    assert len(lines) == 5
    expected = (
        "outcome=refused status=403 chunk_index=1",
        "outcome=nothing_durable status=200 chunk_index=0",
        "outcome=unavailable status=503",
        "outcome=model_unselected status=503",
        # Not provider_unavailable: no provider was called.
        "outcome=queue_timeout status=503",
    )
    for line, fragment in zip(lines, expected, strict=True):
        assert "route=pod capture_source=app_activity_digest memory_profile=general " in line
        assert fragment in line
    assert "Synthetic notebook preference" not in caplog.text


@pytest.mark.parametrize(
    "cloud,provider,mode",
    [("azure", "azure_openai", "user_azure_mi"), ("gcp", "gemini", "user_adc")],
)
@pytest.mark.parametrize("attack", [None, "sibling", "runtime_change", "legacy_approval"])
async def test_private_paid_composition_uses_owner_model_and_sends_only_commitments(
    monkeypatch, cloud, provider, mode, attack
):
    from uuid import uuid4

    from api.routes.one import pod_answer_composition as route
    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.hushh_adk.manifest import ManifestLoader

    owner = {"user_id": "owner", "hushh_id": "agent"}

    @asynccontextmanager
    async def admitted(*_args):
        yield owner

    monkeypatch.setattr(route, "_require_enabled", lambda: None)
    monkeypatch.setattr(route, "_admitted", admitted)
    authority = SimpleNamespace(require_held=AsyncMock())
    monkeypatch.setattr(route, "verified_session", lambda *_args, **_kwargs: (authority, owner))
    revision = [2]
    monkeypatch.setattr(route, "_selection", lambda: None)
    monkeypatch.setattr(route, "ai_selection_revision", lambda: revision[0])
    runtime = {
        "version": 1,
        "provider": provider,
        "model": "gpt-fixture" if cloud == "azure" else "gemini-fixture",
        "mode": "private",
        "fingerprint": "a" * 64,
    }
    model = SimpleNamespace(provider=provider, model=runtime["model"], runtime_mode=mode)
    monkeypatch.setattr(route, "_owner_model", lambda: model)
    monkeypatch.setattr(route, "paid_answer_runtime", lambda: runtime)
    request_id = str(uuid4())
    scope = "attr.travel.trips"

    def read(*_args, params, **_kwargs):
        return {
            "readNonce": params["read_nonce"],
            "paidAnswer": {
                "requestId": request_id,
                "termsDigest": "b" * 64,
                "question": "Where did you travel?",
                "modelProcessingConsented": True,
                "processingRuntime": None if attack == "legacy_approval" else runtime,
                "approvedScopes": [scope],
                "omittedScopes": [],
                "period": None,
                "runtimeBinding": {
                    "owner": "sibling" if attack == "sibling" else "owner",
                    "hushh_id": "agent",
                    "service_uid": "service",
                    "signing_key_id": "key",
                    "image_digest": "c" * 64,
                    "placement_epoch": 0,
                },
                "authorityToken": "synthetic-authority",
            },
        }

    monkeypatch.setattr(route, "owner_feed_client", lambda: SimpleNamespace(read=read))
    gene = SimpleNamespace(
        id="one_paid_answer_writer",
        runtime=SimpleNamespace(adk_mode="single_turn"),
        privacy=SimpleNamespace(plaintext_telemetry=False),
        model=SimpleNamespace(provider="gemini"),
    )

    def load(path):
        assert __import__("pathlib").Path(path).is_file()
        return SimpleNamespace(subagents=[gene])

    monkeypatch.setattr(ManifestLoader, "load", load)
    build = Mock(return_value="agent")
    monkeypatch.setattr(single_turn, "build_single_turn_agent", build)

    async def run(*_args, **_kwargs):
        if attack == "runtime_change":
            revision[0] += 1
        return {"answer": "Tokyo.", "covers": [scope], "gaps": []}

    provider_call = AsyncMock(side_effect=run)
    monkeypatch.setattr(single_turn, "run_single_turn", provider_call)
    receipt = Mock(
        return_value=SimpleNamespace(
            status_code=200, json=lambda: {"compositionReceipt": "v2.synthetic.receipt"}
        )
    )
    monkeypatch.setattr(route, "PodHubClient", lambda **_kwargs: SimpleNamespace(post=receipt))
    body = route.ComposeRequest(
        requestId=request_id,
        projection={"memory": "Approved synthetic trip.", "values": {scope: {"trips": ["Tokyo"]}}},
    )
    if attack:
        with pytest.raises(HTTPException):
            await route.compose_private_answer(body, SimpleNamespace(), "synthetic-app-session")
        receipt.assert_not_called()
        if attack in {"sibling", "legacy_approval"}:
            provider_call.assert_not_awaited()
        return
    result = await route.compose_private_answer(body, SimpleNamespace(), "synthetic-app-session")
    assert result.status_code == 200
    assert build.call_args.kwargs["model"] is model
    callback = receipt.call_args.kwargs["json"]
    assert set(callback) == {
        "authorityToken",
        "processingRuntime",
        "selectionRevision",
        "runtimeMode",
        "answerDigest",
        "inputDigest",
    }
    assert callback["processingRuntime"] == runtime
    assert "Tokyo" not in __import__("json").dumps(callback)
