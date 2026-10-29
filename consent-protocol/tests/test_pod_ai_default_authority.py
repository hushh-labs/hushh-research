"""A cloud default cannot replace an owner key without authorized model access."""

from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one.pod_ai_selection import run_ai_selection_put
from hushh_mcp.services import pod_ai_selection
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from tests.test_pod_ai_selection_doors import (
    NOW,
    OWNER_SESSION,
    PATH,
    _answers,
    _client,
    _envelope,
    _local,
    _owner_verifier,
    _records,
)
from tests.test_pod_ai_selection_doors import (
    owner_session as owner_session,
)
from tests.test_pod_ai_selection_doors import (
    pod as pod,
)


@pytest.mark.parametrize("platform", ["gcp", "azure"])
async def test_default_verification_cannot_clear_a_key_without_authorized_model_access(
    pod, owner_session, monkeypatch, platform
):
    from unittest.mock import Mock

    from hushh_mcp import runtime_settings
    from hushh_mcp.runtime_providers import azure_openai, factory

    await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    monkeypatch.setattr(azure_openai, "owner_azure_model", lambda: None)
    monkeypatch.setattr("hushh_mcp.services.pod_platform.workload_platform", lambda: platform)
    monkeypatch.setattr(runtime_settings, "pod_user_adc_enabled", lambda: False)
    monkeypatch.setattr(runtime_settings, "pod_managed_model_enabled", lambda: False)
    provider = Mock(side_effect=AssertionError("Unauthorized provider call"))
    monkeypatch.setattr(factory, "build_managed_runtime_client", provider)
    result = _client().patch(PATH, headers=OWNER_SESSION)
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "AI_DEFAULT_UNAVAILABLE"
    provider.assert_not_called()
    assert pod_ai_selection.active_ai_selection().provider == "openai"
    assert len(await _records(pod)) == 1


async def test_owner_revoked_during_provider_check_keeps_previous_selection(pod):
    await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    previous = pod_ai_selection.active_ai_selection()
    admitted = True

    async def verify(_token: str, *, expected_scope: str) -> ConsentVerdict:
        if not admitted:
            return ConsentVerdict(valid=False, available=True, reason="subject revoked")
        return await _owner_verifier(_token, expected_scope=expected_scope)

    async def revoke_during_check(_selection: Any, *, gemini_default: str) -> None:
        nonlocal admitted
        admitted = False

    with pytest.raises(HTTPException) as refused:
        await run_ai_selection_put(
            envelope=_envelope(NOW + 1),
            check=revoke_during_check,
            now_ms=NOW + 1,
            **{**_local(), "verifier": verify},
        )

    assert refused.value.status_code == 403
    assert len(await _records(pod)) == 1
    assert pod_ai_selection.active_ai_selection() == previous
