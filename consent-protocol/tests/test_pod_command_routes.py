"""Direct command admission keeps device roles and queued work outside semantics."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

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
