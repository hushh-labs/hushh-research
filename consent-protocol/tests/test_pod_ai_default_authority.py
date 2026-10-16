"""A cloud default cannot replace an owner key without authorized model access."""

import pytest

from api.routes.one.pod_ai_selection import run_ai_selection_put
from hushh_mcp.services import pod_ai_selection
from tests.test_pod_ai_selection_doors import (
    NOW,
    OWNER_SESSION,
    PATH,
    _answers,
    _client,
    _envelope,
    _local,
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
