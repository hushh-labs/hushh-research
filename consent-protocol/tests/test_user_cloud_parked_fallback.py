"""A parked (proven, row-less) cloud is the person's cloud as far as the AI gate is concerned."""

from __future__ import annotations

import pytest

from hushh_mcp.services import user_cloud_service as mod


class _Repo:
    async def get(self, _uid):
        return None


@pytest.mark.asyncio
async def test_parked_cloud_answers_when_no_row_exists(monkeypatch):
    class _Jobs:
        async def parked_cloud(self, _uid):
            return {
                "project_id": "hussh-one-abc",
                "region": "us-central1",
                "bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
                "authorized": True,
            }

    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", lambda *a, **k: _Jobs()
    )
    cloud = await mod.resolve_user_cloud("uid-1", repo=_Repo())
    assert cloud is not None
    assert cloud.is_user_owned and cloud.is_ready_to_provision
    assert cloud.model_credential_mode == "user_adc"
    assert cloud.project == "hussh-one-abc"


@pytest.mark.asyncio
async def test_nothing_parked_is_still_no_cloud(monkeypatch):
    class _Jobs:
        async def parked_cloud(self, _uid):
            return None

    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", lambda *a, **k: _Jobs()
    )
    assert await mod.resolve_user_cloud("uid-1", repo=_Repo()) is None


@pytest.mark.asyncio
async def test_the_gate_takes_the_own_cloud_rule_for_a_parked_cloud(monkeypatch):
    """The founder-hit refusal: managed choice + no row -> fleet rule -> refused."""
    from hushh_mcp.services import ai_connection_gate as gate

    class _Jobs:
        async def parked_cloud(self, _uid):
            return {
                "project_id": "hussh-one-abc",
                "region": "us-central1",
                "bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
                "authorized": True,
            }

    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", lambda *a, **k: _Jobs()
    )
    monkeypatch.setattr("hushh_mcp.runtime_settings.personal_agent_enabled", lambda: True)
    monkeypatch.setattr("hushh_mcp.runtime_settings.provision_on_ai_connection", lambda: True)
    monkeypatch.setattr("hushh_mcp.runtime_settings.pod_managed_model_enabled", lambda: False)
    verdict = gate._pod_can_serve("hushh_managed_vertex", deployment_target="user_gcp")
    assert verdict.can_serve, verdict.reason
