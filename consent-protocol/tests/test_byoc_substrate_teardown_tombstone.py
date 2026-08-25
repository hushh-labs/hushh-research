"""A PARTIAL substrate teardown never writes the clean-erase marker.

The substrate_torn_down tombstone permanently short-circuits retries, so writing it
over survivors turns one revoked grant into a permanent billing orphan nothing can
name. On partial failure the teardown withholds it, records the survivors in a
status-scoped substrate_teardown_incomplete marker (which never blocks a retry --
the idempotency guard checks only substrate_torn_down), and a retried deletion
re-runs the whole plan: already-gone resources resolve as 404-ok, so the retry
re-attempts exactly the survivors.
"""

from __future__ import annotations

from api.routes import account


class _Registry:
    def __init__(self, row, *, tombstone_status_present: str | None = None):
        self._row = row
        self._present = tombstone_status_present
        self.tombstones: list[dict] = []

    async def get(self, _user_id):
        return dict(self._row) if self._row else None

    async def tombstone_exists(self, hushh_id, *, status=None):
        return self._present is not None and status == self._present

    async def tombstone(self, *, hushh_id, external_agent_id, status, metadata=None):
        self.tombstones.append({"hushh_id": hushh_id, "status": status, "metadata": metadata})


_BYOC_ROW = {
    "deployment_target": "user_gcp",
    "user_cloud_project": "hussh-one-abc",
    "hushh_id": "ha1_abc",
    "user_cloud_region": "us-central1",
    "user_cloud_bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
}

_FAILED = [
    {"type": "artifact_repository", "id": "one-pod", "reason": "artifact repository http=403"}
]


def _patch_teardown(monkeypatch, *, summary):
    """Fake the whole GCP substrate teardown to a chosen execute_teardown summary."""
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **_k: "tok",
    )
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_substrate_teardown.build_gcp_deleter",
        lambda **_k: lambda _a: None,
    )

    async def _execute(actions, *, deleter, dry_run=True):
        return {**summary, "planned": list(actions)}

    monkeypatch.setattr("hushh_mcp.services.byoc_substrate_teardown.execute_teardown", _execute)


async def test_no_torn_down_tombstone_on_partial_failure(monkeypatch):
    _patch_teardown(
        monkeypatch,
        summary={"executed": True, "deleted": [], "failed": list(_FAILED), "complete": False},
    )
    reg = _Registry(_BYOC_ROW)

    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=_BYOC_ROW)

    statuses = [t["status"] for t in reg.tombstones]
    # the clean-erase marker is withheld: a retried deletion re-runs the whole plan
    assert "substrate_torn_down" not in statuses
    # ... and ONE reclaim marker names the project and the survivors
    assert statuses == ["substrate_teardown_incomplete"]
    t = reg.tombstones[0]
    assert t["hushh_id"] == "ha1_abc"
    assert t["metadata"]["project"] == "hussh-one-abc"
    assert t["metadata"]["failed"] == _FAILED
    # the returned summary surfaces the failure instead of reading as a clean erase
    assert summary["executed"] is True
    assert summary["incomplete"] is True
    assert summary["failed"] == _FAILED


async def test_retry_after_partial_failure_reruns_the_teardown(monkeypatch):
    minted: list = []
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **_k: minted.append(1) or "tok",
    )
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_substrate_teardown.build_gcp_deleter",
        lambda **_k: lambda _a: None,
    )
    ran: list = []

    async def _execute(actions, *, deleter, dry_run=True):
        ran.append(1)
        plan = list(actions)
        return {"executed": True, "planned": plan, "deleted": plan, "failed": [], "complete": True}

    monkeypatch.setattr("hushh_mcp.services.byoc_substrate_teardown.execute_teardown", _execute)
    # only the incomplete marker exists -- the guard checks substrate_torn_down and
    # must NOT short-circuit on it
    reg = _Registry(_BYOC_ROW, tombstone_status_present="substrate_teardown_incomplete")

    summary = await account._teardown_byoc_substrate(reg, "uid-1", row=_BYOC_ROW)

    assert minted == [1]  # the token WAS re-minted: the retry really re-ran
    assert ran == [1]
    assert summary["executed"] is True
    assert "incomplete" not in summary
    # the retry completed cleanly, so THIS run writes the clean-erase marker
    assert [t["status"] for t in reg.tombstones] == ["substrate_torn_down"]
