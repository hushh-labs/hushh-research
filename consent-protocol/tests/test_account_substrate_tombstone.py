"""The substrate-orphan tombstone: written ONLY when a real teardown ran, and idempotent.

With the founder flag off (the default), execute_teardown returns executed=False, nothing
in the user's project is deleted, and NO tombstone is written -- so the marker never lies
about resources that still exist. When a real teardown runs, one tombstone (status
substrate_torn_down) records it, and a retried deletion is skipped by that marker rather
than re-minting a token and re-running the teardown.
"""

from __future__ import annotations

from api.routes import account


class _Registry:
    def __init__(self, row, *, existing_tombstone=False):
        self._row = row
        self._existing = existing_tombstone
        self.tombstones: list[dict] = []

    async def get(self, _user_id):
        return dict(self._row) if self._row else None

    async def tombstone_exists(self, hushh_id, *, status=None):
        return self._existing and status == "substrate_torn_down"

    async def tombstone(self, *, hushh_id, external_agent_id, status, metadata=None):
        self.tombstones.append({"hushh_id": hushh_id, "status": status, "metadata": metadata})


_BYOC_ROW = {
    "deployment_target": "user_gcp",
    "user_cloud_project": "hussh-one-abc",
    "hushh_id": "ha1_abc",
    "user_cloud_region": "us-central1",
    "user_cloud_bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
}


def _patch_teardown(monkeypatch, *, executed):
    """Fake the whole GCP substrate teardown to a chosen executed verdict."""
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **_k: "tok",
    )
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_substrate_teardown.build_gcp_deleter",
        lambda **_k: lambda _a: None,
    )

    async def _execute(actions, *, deleter, dry_run=True):
        return {"executed": executed, "planned": list(actions), "deleted": []}

    monkeypatch.setattr("hushh_mcp.services.byoc_substrate_teardown.execute_teardown", _execute)


async def test_substrate_tombstone_written_on_executed_teardown(monkeypatch):
    _patch_teardown(monkeypatch, executed=True)
    reg = _Registry(_BYOC_ROW)

    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=_BYOC_ROW)

    assert summary["executed"] is True
    assert len(reg.tombstones) == 1
    t = reg.tombstones[0]
    assert t["status"] == "substrate_torn_down"
    assert t["hushh_id"] == "ha1_abc"
    assert t["metadata"]["project"] == "hussh-one-abc"
    assert t["metadata"]["resources"]  # the deleted resource ids are recorded


async def test_no_substrate_tombstone_when_flag_off(monkeypatch):
    # Flag off -> execute_teardown returns executed=False -> nothing deleted -> NO marker.
    _patch_teardown(monkeypatch, executed=False)
    reg = _Registry(_BYOC_ROW)

    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=_BYOC_ROW)

    assert summary["executed"] is False
    assert reg.tombstones == []  # a tombstone here would claim a teardown that never ran


async def test_substrate_teardown_is_idempotent_via_the_status_guard(monkeypatch):
    # A retried deletion whose substrate tombstone already exists must NOT re-mint a
    # token or re-run the teardown.
    minted: list = []
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **_k: minted.append(1) or "tok",
    )
    reg = _Registry(_BYOC_ROW, existing_tombstone=True)

    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=_BYOC_ROW)

    assert summary == {"executed": False, "reason": "already_torn_down"}
    assert minted == []  # never re-impersonated
    assert reg.tombstones == []  # never re-wrote the marker


async def test_non_byoc_row_is_a_noop(monkeypatch):
    reg = _Registry({"deployment_target": "gcp", "hushh_id": "ha1_abc"})
    assert await account._teardown_byoc_substrate(reg, "uid-1", row=reg._row) is None
    assert reg.tombstones == []
