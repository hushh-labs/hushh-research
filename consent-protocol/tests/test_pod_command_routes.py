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


async def test_memory_preparation_refuses_wrong_owner_and_device_before_generation(
    tmp_path, hub_key, monkeypatch
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
    generator = AsyncMock(return_value=payload)
    monkeypatch.setattr(
        preparation,
        "OwnerPkmPreparation",
        lambda **kw: SimpleNamespace(generate_structure_preview=generator),
    )
    app_subject, device = Subject("app", "web"), Subject("device", "macos")
    app_token, _ = await world.admit(app_subject, _binding(app_subject))
    device_token, _ = await world.admit(device, _binding(device))
    app = FastAPI()
    app.include_router(preparation.router)
    with TestClient(app) as client:
        for token, owner in ((device_token, USER), (app_token, "someone-else")):
            response = client.post(
                "/api/one/pod/memory/proposals",
                json={"user_id": owner, "message": "Synthetic notebook preference"},
                headers={"Authorization": "Bearer " + token},
            )
            assert response.status_code == 403
        model_builder.assert_not_called()
        generator.assert_not_awaited()
        response = client.post(
            "/api/one/pod/memory/proposals",
            json={"user_id": USER, "message": "Synthetic notebook preference"},
            headers={"Authorization": "Bearer " + app_token},
        )
        assert response.status_code == 200
        generator.assert_awaited_once()
        assert generator.call_args.kwargs["user_id"] == USER

        async def changed_selection(**kw):
            pod_ai_selection.set_active_ai_selection(None)
            pod_ai_selection.set_active_ai_selection(None)
            return payload

        generator.side_effect = changed_selection
        response = client.post(
            "/api/one/pod/memory/proposals",
            json={"user_id": USER, "message": "Synthetic notebook preference"},
            headers={"Authorization": "Bearer " + app_token},
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "OWNER_AI_SELECTION_CHANGED"


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
