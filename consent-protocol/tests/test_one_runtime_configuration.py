from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from api.routes.one import runtime
from hushh_mcp.constants import GEMINI_MODEL


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
    assert first.model == GEMINI_MODEL
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
    assert call.kwargs["model"] == GEMINI_MODEL
    assert call.kwargs["contents"] == "Reply OK."
    assert call.kwargs["config"].max_output_tokens == 4
    assert call.kwargs["config"].thinking_config.include_thoughts is False
    # Gemini 3.x rejects MINIMAL; the shared provider adapter intentionally
    # coerces this compatibility probe to the supported LOW level.
    thinking_level = getattr(call.kwargs["config"].thinking_config, "thinking_level", None)
    assert getattr(thinking_level, "value", thinking_level) == "LOW"
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
async def test_vertex_api_key_transport_requires_explicit_endpoint_metadata() -> None:
    with pytest.raises(HTTPException) as raised:
        await runtime.validate_gemini_credential(
            request=_request(),
            body=runtime.GeminiCredentialValidationRequest(
                credential="test-key",
                transport="vertex_api_key",
                vertex_project=None,
                vertex_location=None,
            ),
            _firebase_uid="user-1",
        )

    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
        "status": "invalid_vertex_configuration",
    }


@pytest.mark.asyncio
async def test_vertex_api_key_transport_probes_the_explicit_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generate_content = AsyncMock(return_value=SimpleNamespace(text="OK"))
    client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)),
    )
    monkeypatch.setattr(runtime, "build_runtime_client", lambda *_args, **_kwargs: client)

    result = await runtime.validate_gemini_credential(
        request=_request(),
        body=runtime.GeminiCredentialValidationRequest(
            credential="test-key",
            transport="vertex_api_key",
            vertex_project="customer-vertex-project",
            vertex_location="us-central1",
        ),
        _firebase_uid="user-1",
    )

    assert result.status == "ready"
    generate_content.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "selected,actual",
    [("azure_openai", "azure_openai"), ("vertex", "vertex"), ("azure_openai", "vertex")],
)
async def test_uat_readiness_reports_actual_provider_and_invalidates_changed_binding(
    monkeypatch, selected, actual
):
    from hushh_mcp.runtime_providers import managed_text

    policy = {"generation": "first", "selected_provider": selected}
    probe = AsyncMock(
        return_value={
            "provider": actual,
            "model": "actual-model",
            "location": "" if actual == "azure_openai" else "global",
        }
    )
    monkeypatch.setattr(managed_text, "managed_text_policy", lambda: policy)
    monkeypatch.setattr(
        managed_text, "managed_text_binding", lambda: {"config_fingerprint": "config"}
    )
    monkeypatch.setattr(managed_text, "probe_managed_text_model", probe)
    monkeypatch.setattr(runtime, "_managed_readiness_cache", None)
    monkeypatch.setattr(
        runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        lambda: pytest.fail("UAT bypassed selected adapter"),
    )
    first = await runtime.managed_gemini_readiness(request=_request(), _firebase_uid="owner")
    assert first.provider == actual and first.model == "actual-model"
    assert first.location == (None if actual == "azure_openai" else "global")
    assert first.fallback_used is (selected != actual)
    assert (
        await runtime.managed_gemini_readiness(request=_request(), _firebase_uid="owner") == first
    )
    probe.assert_awaited_once_with(scope="one_text_chat")
    policy["generation"] = "next-provider-generation"
    await runtime.managed_gemini_readiness(request=_request(), _firebase_uid="owner")
    assert probe.await_count == 2


@pytest.mark.asyncio
async def test_uat_readiness_failure_is_sanitized_and_not_cached(monkeypatch):
    from hushh_mcp.runtime_providers import managed_text

    probe = AsyncMock(side_effect=RuntimeError("private-provider-details"))
    monkeypatch.setattr(
        managed_text,
        "managed_text_policy",
        lambda: {"generation": "test", "selected_provider": "azure_openai"},
    )
    monkeypatch.setattr(
        managed_text, "managed_text_binding", lambda: {"config_fingerprint": "config"}
    )
    monkeypatch.setattr(managed_text, "probe_managed_text_model", probe)
    monkeypatch.setattr(runtime, "_managed_readiness_cache", None)
    for _ in range(2):
        with pytest.raises(HTTPException) as failure:
            await runtime.managed_gemini_readiness(request=_request(), _firebase_uid="owner")
        assert failure.value.status_code == 503
        assert "private-provider-details" not in str(failure.value.detail)
    assert probe.await_count == 2
