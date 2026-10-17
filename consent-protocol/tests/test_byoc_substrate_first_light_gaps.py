"""Two gaps found on the founder's first BYOC provision (2026-09-02).

1. The bootstrap account's own batchEnable is quota-attributed to the person's
   project; without serviceusage.googleapis.com enabled there, Service Usage
   refuses with SERVICE_DISABLED and every substrate step gates off behind a 403.
   The authorize step (run with the person's own token) must enable it first.
2. A failure record that names deployment_target without the person's project
   trips personal_agent_registry_user_gcp_needs_project_check on the INSERT half
   of the upsert, leaving the row saying "provisioning" forever.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.user_gcp_bootstrap import REQUIRED_SERVICES


def test_service_usage_is_enabled_first() -> None:
    assert REQUIRED_SERVICES[0] == "serviceusage.googleapis.com"
    assert "cloudresourcemanager.googleapis.com" in REQUIRED_SERVICES


@pytest.mark.asyncio
async def test_registry_upsert_carries_the_cloud_coordinates() -> None:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    captured: list[dict] = []

    class _Resp:
        data: list = []

    class _Table:
        def upsert(self, data, **kwargs):
            captured.append(dict(data))
            return self

        def execute(self):
            return _Resp()

    class _Db:
        def table(self, _name):
            return _Table()

    repo = PersonalAgentRegistryRepo(client=_Db())
    await repo.upsert(
        user_id="uid-1",
        hushh_id="ha1_abc",
        phone_e164_hash="h",
        status="provisioning_failed",
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
        user_cloud_project="hussh-one-abc",
        user_cloud_region="us-central1",
        user_cloud_bootstrap_sa="one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
    )
    assert captured and captured[0]["user_cloud_project"] == "hussh-one-abc"
    assert captured[0]["deployment_target"] == "user_gcp"
    assert captured[0]["user_cloud_bootstrap_sa"].startswith("one-bootstrap@")
