"""Account deletion after a UI pod deletion must still tear down the BYOC substrate.

Observed 2026-09-02 on dev: the pod was deprovisioned from the UI (registry row gone,
tombstone written), the account was deleted ten minutes later, and the person's own
project still held ``one-bootstrap@`` with ten admin roles, the keyring, and the
artifact repo, because ``_teardown_byoc_substrate`` answered "nothing BYOC here" the
moment the row was missing. The anchor now comes from the byoc_setup_jobs row plus the
deprovision tombstone, which the deprovision path must therefore always populate.
"""

from __future__ import annotations

import pytest

from api.routes import account

_PROJECT = "hussh-one-abc"
_BOOTSTRAP = "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com"


class _Registry:
    def __init__(self, *, tombstone: dict | None):
        self._tomb = tombstone
        self.tombstones: list[dict] = []
        self.project_queries: list[tuple[str, str | None]] = []

    async def get(self, _user_id):
        return None  # the row is already gone

    async def latest_tombstone_for_project(self, project, *, status=None):
        self.project_queries.append((project, status))
        return dict(self._tomb) if self._tomb else None

    async def tombstone_exists(self, hushh_id, *, status=None):
        return False

    async def tombstone(self, *, hushh_id, external_agent_id, status, metadata=None):
        self.tombstones.append({"hushh_id": hushh_id, "status": status, "metadata": metadata})


class _Jobs:
    def __init__(self, project: str | None):
        self._project = project

    async def get(self, _user_id):
        return {"user_id": "uid-1", "project_id": self._project} if self._project else None


def _patch(monkeypatch, *, job_project, executed_plans: list):
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo",
        lambda *a, **k: _Jobs(job_project),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token", lambda **_k: "tok"
    )
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_substrate_teardown.build_gcp_deleter",
        lambda **_k: lambda _a: None,
    )

    async def _execute(actions, *, deleter, dry_run=True):
        executed_plans.append(list(actions))
        return {"executed": True, "deleted": list(actions), "failed": [], "planned": list(actions)}

    monkeypatch.setattr("hushh_mcp.services.byoc_substrate_teardown.execute_teardown", _execute)


@pytest.mark.asyncio
async def test_rowless_account_deletion_tears_down_substrate_from_tombstone(monkeypatch):
    plans: list = []
    _patch(monkeypatch, job_project=_PROJECT, executed_plans=plans)
    reg = _Registry(
        tombstone={
            "hushh_id": "ha1_abc",
            "status": "deprovision_requested",
            "metadata": {
                "unreclaimed": False,
                "user_cloud_project": _PROJECT,
                "user_cloud_region": "us-central1",
                "user_cloud_bootstrap_sa": _BOOTSTRAP,
                "deployment_target": "user_gcp",
            },
        }
    )
    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=None)
    assert summary is not None and summary["executed"] is True
    assert reg.project_queries == [(_PROJECT, "deprovision_requested")]
    assert plans and plans[0], "the substrate plan for the recovered hushh_id must run"
    assert [t["status"] for t in reg.tombstones] == ["substrate_torn_down"]
    assert reg.tombstones[0]["hushh_id"] == "ha1_abc"


@pytest.mark.asyncio
async def test_rowless_without_setup_job_is_still_a_noop(monkeypatch):
    plans: list = []
    _patch(monkeypatch, job_project=None, executed_plans=plans)
    reg = _Registry(tombstone=None)
    assert await account._teardown_byoc_substrate(reg, "uid-1", row=None) is None
    assert plans == [] and reg.tombstones == []


@pytest.mark.asyncio
async def test_rowless_with_job_but_no_tombstone_is_a_noop_and_loud(monkeypatch, caplog):
    plans: list = []
    _patch(monkeypatch, job_project=_PROJECT, executed_plans=plans)
    reg = _Registry(tombstone=None)
    with caplog.at_level("WARNING"):
        assert await account._teardown_byoc_substrate(reg, "uid-1", row=None) is None
    assert "substrate_anchor_missing" in caplog.text
    assert plans == []


@pytest.mark.asyncio
async def test_pre_fix_tombstone_without_bootstrap_derives_the_conventional_name(monkeypatch):
    plans: list = []
    _patch(monkeypatch, job_project=_PROJECT, executed_plans=plans)
    minted: list[str] = []
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **k: minted.append(k["bootstrap_sa"]) or "tok",
    )
    reg = _Registry(
        tombstone={
            "hushh_id": "ha1_abc",
            "status": "deprovision_requested",
            "metadata": {"unreclaimed": True, "user_cloud_project": _PROJECT},
        }
    )
    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=None)
    assert summary is not None and summary["executed"] is True
    assert minted == [_BOOTSTRAP]


@pytest.mark.asyncio
async def test_deprovision_tombstone_always_names_the_cloud_for_user_gcp(monkeypatch):
    from hushh_mcp.services import personal_agent_provisioning_service as mod

    row = {
        "user_id": "uid-1",
        "hushh_id": "ha1_abc",
        "external_agent_id": "one-pod-ha1-abc",
        "deployment_target": "user_gcp",
        "user_cloud_project": _PROJECT,
        "user_cloud_region": "us-central1",
        "user_cloud_bootstrap_sa": _BOOTSTRAP,
        "backend_metadata": {},
    }

    class _Reg:
        def __init__(self):
            self.tombstones: list[dict] = []
            self.deleted: list[str] = []

        async def get(self, _uid):
            return dict(row)

        async def tombstone(self, *, hushh_id, external_agent_id, status, metadata=None):
            self.tombstones.append({"hushh_id": hushh_id, "status": status, "metadata": metadata})

        async def delete(self, uid):
            self.deleted.append(uid)

    class _Grant:
        async def revoke_standing_pkm_read(self, *_a, **_k):
            return None

    class _Backend:  # a reachable host: the clean-teardown branch
        async def deprovision(self, external_agent_id):
            return None

    monkeypatch.setattr(
        "hushh_mcp.services.compute_backend.resolve_compute_backend_for_spec",
        lambda spec: _Backend(),
    )
    reg = _Reg()
    svc = mod.PersonalAgentProvisioningService(registry=reg, grant=_Grant(), backend=_Backend())
    result = await svc.deprovision(user_id="uid-1")
    assert result["unreclaimed"] is False
    assert reg.deleted == ["uid-1"]
    meta = reg.tombstones[-1]["metadata"]
    assert meta["unreclaimed"] is False
    assert meta["user_cloud_project"] == _PROJECT
    assert meta["user_cloud_bootstrap_sa"] == _BOOTSTRAP
    assert meta["deployment_target"] == "user_gcp"
