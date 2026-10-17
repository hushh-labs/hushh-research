"""Cloud setup preserves placement and rejects writes based on stale observations."""

from copy import deepcopy

import pytest

from hushh_mcp.services.personal_agent_cloud_assignment import PodAssignmentPreserved
from tests.test_personal_agent_registry_repo import _UID, _Query, _repo_and_db, _upsert


async def setup_cloud(repo):
    return await repo.set_user_cloud(
        user_id=_UID,
        project="owner-project",
        region="us-central1",
        bootstrap_sa="bootstrap",
        authorized=True,
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )


@pytest.mark.parametrize(
    "state", ["provisioning", "connecting", "provisioned", "migrating", "suspended"]
)
async def test_setup_cannot_replace_assigned_or_pending_pod(state):
    repo, db = _repo_and_db()
    await _upsert(repo, status="pending")
    assert await setup_cloud(repo)
    db.tables["personal_agent_registry"][0]["status"] = state
    before = deepcopy(await repo.get(_UID))
    with pytest.raises(PodAssignmentPreserved):
        await repo.set_user_cloud(
            user_id=_UID,
            project="another-project",
            deployment_target="user_gcp",
            model_credential_mode="user_adc",
        )
    assert await repo.get(_UID) == before
    assert await setup_cloud(repo)  # Re-proving exactly the same coordinates is safe.


async def test_provisioning_race_refuses_stale_coordinate_write(monkeypatch):
    repo, db = _repo_and_db()
    await _upsert(repo, status="pending")
    original = _Query.execute

    def concurrent_provision(query):
        if query._mode == "update":
            db.tables["personal_agent_registry"][0]["status"] = "provisioning"
        return original(query)

    monkeypatch.setattr(_Query, "execute", concurrent_provision)
    with pytest.raises(PodAssignmentPreserved):
        await setup_cloud(repo)
    assert not (await repo.get(_UID)).get("user_cloud_project")
