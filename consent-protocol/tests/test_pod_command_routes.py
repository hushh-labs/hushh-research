"""Direct command admission keeps device roles and queued work outside semantics."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_commands
from tests.test_pod_session_authority import Subject, World, _binding
from tests.test_pod_session_authority import hub_key as hub_key


async def test_direct_transcription_requires_an_app_scope_before_model_access(
    tmp_path, hub_key, monkeypatch
):
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
