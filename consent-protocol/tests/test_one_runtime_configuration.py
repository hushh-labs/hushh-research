from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from api.routes.one import runtime


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": []})


def _body() -> runtime.GeminiCredentialValidationRequest:
    return runtime.GeminiCredentialValidationRequest(
        credential="test-key",
        transport="developer_api",
    )


@pytest.mark.asyncio
async def test_managed_readiness_uses_canonical_binding_and_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generate_content = AsyncMock(return_value=SimpleNamespace(text="ignored"))
    binding = SimpleNamespace(
        primary_location="asia-southeast1",
        build_direct_client=lambda **_kwargs: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content))
        ),
    )
    monkeypatch.setattr(
        runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        lambda: binding,
    )
    monkeypatch.setattr(runtime, "_managed_readiness_cache", None)

    first = await runtime.managed_gemini_readiness(
        request=_request(),
        _firebase_uid="user-1",
    )
    second = await runtime.managed_gemini_readiness(
        request=_request(),
        _firebase_uid="user-1",
    )

    assert first == second
    assert first.status == "ready"
    assert first.model == "gemini-3.6-flash"
    assert first.location == "asia-southeast1"
    generate_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_gemini_validation_proves_generation_quota(monkeypatch: pytest.MonkeyPatch) -> None:
    generate_content = AsyncMock(return_value=SimpleNamespace(text="OK"))
    client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)),
    )
    monkeypatch.setattr(runtime, "build_runtime_client", lambda *_args, **_kwargs: client)

    result = await runtime.validate_gemini_credential(
        request=_request(),
        body=_body(),
        _firebase_uid="user-1",
    )

    assert result.status == "ready"
    generate_content.assert_awaited_once()
    call = generate_content.await_args
    assert call.kwargs["model"] == "gemini-3.6-flash"
    assert call.kwargs["contents"] == "Reply OK."
    assert call.kwargs["config"].max_output_tokens == 4
    assert call.kwargs["config"].thinking_config.thinking_level.value == "MINIMAL"
    assert call.kwargs["config"].temperature is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider_error", "expected_status"),
    [
        ("RESOURCE_EXHAUSTED: quota exceeded", "quota_exhausted"),
        ("billing account is disabled", "billing_required"),
        ("API key invalid", "invalid_key"),
        ("model not found", "unsupported_model"),
        ("service unavailable", "temporary_unavailable"),
    ],
)
async def test_gemini_validation_returns_safe_failure_taxonomy(
    monkeypatch: pytest.MonkeyPatch,
    provider_error: str,
    expected_status: str,
) -> None:
    generate_content = AsyncMock(side_effect=RuntimeError(provider_error))
    client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)),
    )
    monkeypatch.setattr(runtime, "build_runtime_client", lambda *_args, **_kwargs: client)

    with pytest.raises(HTTPException) as raised:
        await runtime.validate_gemini_credential(
            request=_request(),
            body=_body(),
            _firebase_uid="user-1",
        )

    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
        "status": expected_status,
    }


@pytest.mark.asyncio
async def test_vertex_api_key_transport_is_explicitly_disabled() -> None:
    with pytest.raises(HTTPException) as raised:
        await runtime.validate_gemini_credential(
            request=_request(),
            body=runtime.GeminiCredentialValidationRequest(
                credential="test-key",
                transport="vertex_api_key",
                vertex_project="hushh-pda-dev",
                vertex_location="global",
            ),
            _firebase_uid="user-1",
        )

    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "GEMINI_BYOK_TRANSPORT_UNSUPPORTED",
        "status": "vertex_api_key_disabled",
    }
