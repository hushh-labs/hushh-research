"""An upgrade is a software update at login, and that starts with knowing the version.

The founder's rule (2026-09-02): "upgrades happening on hub have to be like a software
update when user logs in to the app". Until 2026-09-03 the status the app reads carried
no version at all, and the pod image carried no build identity, so nothing on the login
path could say "there is a newer agent". These tests pin the two halves:

* the hub compares what the pod RUNS with what it WANTS, tri-state like `hostReady`
  (absent when the evidence is absent, never coerced to False);
* the pod's heartbeat may carry its own build tag, recorded under a key of its own so
  "what I deployed" and "what the pod says it is" can disagree visibly.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from api.routes.one.personal_agent import _image_tag, describe_pod_update
from hushh_mcp.services.personal_agent_provisioning_service import (
    _FEED_EVENT_TYPES,
    FEED_EVENT_UPDATED,
    UPGRADE_ATTEMPTS_PER_IMAGE,
)
from hushh_mcp.services.pod_lifecycle_log import STAGE_PROGRESS

TARGET = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-bbbbbbbbb"
DEPLOYED_OLD = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-aaaaaaaaa"


def _row(**metadata):
    return {"hushh_id": "ha1_test", "backend_metadata": metadata}


def test_image_tag_reads_refs_digests_and_bare_tags() -> None:
    assert _image_tag(TARGET) == "dev-bbbbbbbbb"
    assert _image_tag("gcr.io/p/consent-protocol-pod:dev-1@sha256:abc") == "dev-1"
    assert _image_tag("dev-bare") == "dev-bare"
    assert _image_tag("gcr.io/p/consent-protocol-pod") is None
    assert _image_tag("") is None


def test_a_pod_behind_the_target_has_an_update_available() -> None:
    out = describe_pod_update(_row(source_image=DEPLOYED_OLD), target_image=TARGET)
    assert out == {
        "runningImage": "dev-aaaaaaaaa",
        "targetImage": "dev-bbbbbbbbb",
        "updateAvailable": True,
    }


def test_a_pod_at_the_target_is_positively_current() -> None:
    out = describe_pod_update(_row(source_image=TARGET), target_image=TARGET)
    assert out["updateAvailable"] is False


def test_no_lane_target_means_the_field_is_absent_not_false() -> None:
    out = describe_pod_update(_row(source_image=DEPLOYED_OLD), target_image="")
    assert out == {"runningImage": "dev-aaaaaaaaa"}
    assert "updateAvailable" not in out and "targetImage" not in out


def test_nothing_recorded_means_nothing_claimed() -> None:
    assert describe_pod_update({"backend_metadata": None}, target_image=TARGET) == {}
    assert describe_pod_update(_row(), target_image=TARGET) == {"targetImage": "dev-bbbbbbbbb"}


def test_the_pods_own_report_wins_over_the_deployed_record(caplog) -> None:
    """A row that says upgraded while the process runs old code is DRIFT: logged
    loudly, and the pod's word decides availability because it is the only signal
    about what is running."""
    row = _row(source_image=TARGET, observed={"imageTag": "dev-aaaaaaaaa"})
    with caplog.at_level("WARNING"):
        out = describe_pod_update(row, target_image=TARGET)
    assert out["runningImage"] == "dev-aaaaaaaaa"
    assert out["updateAvailable"] is True
    assert any("personal_agent.image_drift" in r.message for r in caplog.records)


def test_a_fresh_lease_reads_as_in_progress_and_a_stale_one_does_not() -> None:
    fresh = f"{datetime.now(timezone.utc).isoformat()}|{TARGET}"
    out = describe_pod_update(
        _row(source_image=DEPLOYED_OLD, upgradeLease=fresh), target_image=TARGET
    )
    assert out["updateInProgress"] is True
    stale = f"{(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()}|{TARGET}"
    out = describe_pod_update(
        _row(source_image=DEPLOYED_OLD, upgradeLease=stale), target_image=TARGET
    )
    assert "updateInProgress" not in out


def test_three_failures_on_this_image_surface_as_failed_with_the_reason() -> None:
    marker = {
        "failedImage": TARGET,
        "attempts": UPGRADE_ATTEMPTS_PER_IMAGE,
        "lastError": "copy refused (403)",
    }
    out = describe_pod_update(_row(source_image=DEPLOYED_OLD, upgrade=marker), target_image=TARGET)
    assert out["updateAvailable"] is True
    assert out["updateFailed"] is True
    assert out["updateError"] == "copy refused (403)"
    # One failure short of the cap: the sweep is still trying, no alarm yet.
    marker["attempts"] = UPGRADE_ATTEMPTS_PER_IMAGE - 1
    out = describe_pod_update(_row(source_image=DEPLOYED_OLD, upgrade=marker), target_image=TARGET)
    assert "updateFailed" not in out


def test_the_update_has_a_lifecycle_stage_and_a_feed_event() -> None:
    assert STAGE_PROGRESS["updating"] < STAGE_PROGRESS["authority_live"]
    assert STAGE_PROGRESS["updating"] > STAGE_PROGRESS["key_published"]
    assert FEED_EVENT_UPDATED in _FEED_EVENT_TYPES


# ---- the heartbeat body ------------------------------------------------------------


class _FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


@pytest.mark.asyncio
async def test_heartbeat_reads_only_the_two_bounded_fields() -> None:
    from api.routes.one.pod_heartbeat import _read_self_report

    assert await _read_self_report(_FakeRequest(ValueError("no body"))) is None
    assert await _read_self_report(_FakeRequest("not-an-object")) is None
    assert await _read_self_report(_FakeRequest({"status": "healthy"})) is None
    report = await _read_self_report(
        _FakeRequest({"imageTag": " dev-1 ", "revision": "r" * 500, "status": "healthy"})
    )
    assert report == {"imageTag": "dev-1", "revision": "r" * 128}


class _FakeDb:
    def __init__(self, row):
        self.row = row
        self.raw_calls: list[tuple[str, dict]] = []

    def table(self, _name):
        return self

    def update(self, _data):
        return self

    def eq(self, _k, _v):
        return self

    def execute(self):
        return SimpleNamespace(data=[self.row])

    def execute_raw(self, sql, params):
        self.raw_calls.append((sql, params))
        return SimpleNamespace(data=[{"user_id": "u"}])


@pytest.mark.asyncio
async def test_heartbeat_records_the_report_under_observed_and_never_the_deployed_record() -> None:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    db = _FakeDb({"hushh_id": "ha1_x", "backend_metadata": {"source_image": DEPLOYED_OLD}})
    repo = PersonalAgentRegistryRepo.__new__(PersonalAgentRegistryRepo)
    repo._db = lambda: db  # type: ignore[method-assign]

    row = await repo.record_heartbeat(hushh_id="ha1_x", observed={"imageTag": "dev-1"})
    assert row["backend_metadata"]["observed"] == {"imageTag": "dev-1"}
    assert row["backend_metadata"]["source_image"] == DEPLOYED_OLD
    sql, params = db.raw_calls[-1]
    assert "'{observed}'" in sql and "source_image" not in sql
    assert json.loads(params["observed"]) == {"imageTag": "dev-1"}

    # Unchanged report: no second write on a steady pod's every-60s beat.
    db.row["backend_metadata"]["observed"] = {"imageTag": "dev-1"}
    before = len(db.raw_calls)
    await repo.record_heartbeat(hushh_id="ha1_x", observed={"imageTag": "dev-1"})
    assert len(db.raw_calls) == before
    # Bodyless beat from a row that carries a report: the process beating now does
    # not report (an older image), so the stale report is dropped, not kept.
    row = await repo.record_heartbeat(hushh_id="ha1_x")
    assert "observed" not in row["backend_metadata"]
    sql, params = db.raw_calls[-1]
    assert "- 'observed'" in sql and params == {"hushh_id": "ha1_x"}
    # And a bodyless beat on a row with no report touches nothing.
    db.row["backend_metadata"].pop("observed", None)
    before = len(db.raw_calls)
    await repo.record_heartbeat(hushh_id="ha1_x")
    assert len(db.raw_calls) == before


def test_the_pod_reports_its_baked_tag_and_revision(monkeypatch) -> None:
    from pod_server import _self_report

    monkeypatch.delenv("HUSSH_POD_IMAGE_TAG", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    assert _self_report() == {}, "no bake means no field, never a placeholder"
    monkeypatch.setenv("HUSSH_POD_IMAGE_TAG", "dev-1")
    monkeypatch.setenv("K_REVISION", "one-pod-x-00003-abc")
    assert _self_report() == {"imageTag": "dev-1", "revision": "one-pod-x-00003-abc"}


def test_the_image_is_built_with_its_tag_baked_in() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "Dockerfile.pod").read_text()
    assert 'ARG POD_IMAGE_TAG=""' in dockerfile
    assert "HUSSH_POD_IMAGE_TAG=${POD_IMAGE_TAG}" in dockerfile
    cloudbuild = (root.parent / "deploy" / "backend.cloudbuild.yaml").read_text()
    assert "--build-arg POD_IMAGE_TAG=${_IMAGE_TAG}" in cloudbuild


def test_a_hushh_hosted_pod_gets_update_state_too() -> None:
    """The hosted tier writes `image`, not `source_image`, and only one was read.

    `running_image()` documents the two-key model -- `source_image` on a user-owned
    pod, `image` on a hushh-hosted one -- and GcpBackend writes only `image`. So every
    hosted pod resolved deployed_tag=None. With no `observed` either (a bodyless
    heartbeat deletes it, per 1cd8d272a) the whole block returned early: no
    runningImage, no updateAvailable, and no updateFailed even after the sweep burned
    all three attempts. The person's login surface said nothing at all while their
    agent silently failed to update. GcpBackend.upgrade is a live path; hosted pods
    ARE swept.
    """
    hosted = {"backend_metadata": {"image": DEPLOYED_OLD}}
    out = describe_pod_update(hosted, target_image=TARGET)
    assert out["runningImage"] == "dev-aaaaaaaaa"
    assert out["updateAvailable"] is True


def test_a_user_owned_pod_still_prefers_its_own_key() -> None:
    """`source_image` wins where both are present, which is the BYOC pod's shape.

    UserGcpBackend writes both keys; `image` there is the copy in the person's own
    registry and `source_image` is what the pod was built from. Reading `image` first
    would report the wrong one for every BYOC pod, so the fallback must stay a
    fallback.
    """
    both = {"backend_metadata": {"source_image": TARGET, "image": DEPLOYED_OLD}}
    assert describe_pod_update(both, target_image=TARGET)["updateAvailable"] is False
