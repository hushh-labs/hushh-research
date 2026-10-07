"""An existing hub-only Google agent becomes owner-direct with no operator step.

Before this, a `user_gcp` agent recorded `internal` stayed hub-only forever unless an
operator widened it by hand (dev-pod-first-light runbook). These tests hold the
automatic path to its order and its refusals: the public invoker is granted BEFORE
ingress changes, an organisation-policy refusal is a durable typed blocker that
changes nothing else, the service incarnation is checked first, the row moves only
`internal` -> `external` (never `direct`, which admission still owns), and the
heartbeat entry point is deduplicated, claimed and backed off.
"""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services import owner_direct_ingress as odi
from hushh_mcp.services import owner_direct_widen as widen

URL = "https://one-pod-ha1-owner-abc123-uc.a.run.app"
SERVICE = "one-pod-ha1-owner"


@pytest.fixture(autouse=True)
def dev_lane(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.delenv("ENVIRONMENT", raising=False)


def _row(**metadata_overrides: Any) -> dict:
    metadata = {
        "ingress": "internal",
        "tenancy": "user-owned",
        "url": URL,
        "service": SERVICE,
        "serviceUid": "svc-1",
        "observed": {"imageTag": "dev-1", "aiSelection": {"version": 1, "providers": []}},
    }
    metadata.update(metadata_overrides)
    return {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "pod_key_id": "pod_key_1",
        "pod_pubkey": "cHVibGlj",
        "user_cloud_project": "owner-project",
        "user_cloud_region": "us-central1",
        "user_cloud_bootstrap_sa": "one-bootstrap@owner-project.iam.gserviceaccount.com",
        "backend_metadata": {k: v for k, v in metadata.items() if v is not None},
    }


def _service(ingress: str = "internal", uid: str = "svc-1", url: str = URL) -> dict:
    return {
        "metadata": {
            "name": SERVICE,
            "uid": uid,
            "resourceVersion": "rv-1",
            "annotations": {"run.googleapis.com/ingress": ingress},
        },
        "spec": {"template": {"spec": {"containers": [{"image": "img@sha256:1"}]}}},
        "status": {"url": url},
    }


def _http_error(status: int, text: str) -> Exception:
    error = RuntimeError(f"HTTP {status}")
    error.response = SimpleNamespace(status_code=status, text=text)  # type: ignore[attr-defined]
    return error


class _Run:
    """A Cloud Run client double that records the order of every call."""

    def __init__(self, *, service=None, grant_error=None, ready=True, live_url=URL):
        self.service = service if service is not None else _service()
        self.grant_error = grant_error
        self.ready = ready
        self.live_url = live_url
        self.calls: list[tuple] = []

    def get_service(self, name):
        self.calls.append(("get_service", name))
        return copy.deepcopy(self.service)

    def grant_public_invoker(self, name, *, direct_ingress_axis):
        self.calls.append(("grant", name, direct_ingress_axis))
        if self.grant_error is not None:
            raise self.grant_error
        return {}

    def replace_service(self, name, body, *, revision_nonce=None, expected_uid=None):
        self.calls.append(("replace", name, body, revision_nonce, expected_uid))
        return {}

    def wait_ready(self, name, *, expected_uid=None, expected_revision_nonce=None):
        self.calls.append(("wait_ready", name, expected_uid, expected_revision_nonce))
        return self.ready, _service(ingress="all", url=self.live_url)


@pytest.fixture
def recorded(monkeypatch):
    calls: dict[str, list] = {"promoted": [], "blocked": [], "refreshed": []}

    async def promote(_db, **fields):
        calls["promoted"].append(fields)
        return True

    async def blocker(due, status, *, db=None):
        calls["blocked"].append((due, status))
        return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_direct_admission.promote_internal_to_external",
        promote,
    )
    monkeypatch.setattr(widen, "record_widen_blocker", blocker)
    return calls


async def _widen(run: _Run, recorded, row: dict | None = None) -> str:
    async def refresh(candidate):
        recorded["refreshed"].append(candidate["user_id"])
        return None

    return await widen.widen_existing_if_due(
        row or _row(), client=run, db=object(), key_refresher=refresh
    )


async def test_the_invoker_is_granted_before_ingress_and_the_row_records_external(recorded):
    run = _Run()
    assert await _widen(run, recorded) == "recorded"
    names = [call[0] for call in run.calls]
    assert names == ["get_service", "grant", "replace", "wait_ready"]
    _, _, body, nonce, expected_uid = run.calls[2]
    assert body["metadata"]["annotations"] == {"run.googleapis.com/ingress": "all"}
    assert body["metadata"]["resourceVersion"] == "rv-1"
    assert body["spec"] == _service()["spec"]
    assert nonce and nonce.startswith("widen-") and expected_uid == "svc-1"
    assert run.calls[3][3] == nonce
    assert recorded["refreshed"] == ["owner"]
    assert recorded["promoted"] == [
        {"user_id": "owner", "hushh_id": "ha1_owner", "service_uid": "svc-1", "url": URL}
    ]


@pytest.mark.parametrize(
    ("status", "text"),
    [
        (400, "One or more users named in the policy do not belong to a permitted customer."),
        (412, "Request violates constraint constraints/iam.allowedPolicyMemberDomains"),
    ],
)
async def test_an_org_policy_refusal_records_a_blocker_and_changes_nothing(recorded, status, text):
    run = _Run(grant_error=_http_error(status, text))
    assert await _widen(run, recorded) == "blocked"
    assert [call[0] for call in run.calls] == ["get_service", "grant"]
    [(due, blocked_status)] = recorded["blocked"]
    assert blocked_status == status and due["service_uid"] == "svc-1"
    assert recorded["promoted"] == []


@pytest.mark.parametrize("error", [_http_error(403, "caller lacks permission"), OSError()])
async def test_any_other_grant_failure_raises_and_changes_nothing(recorded, error):
    run = _Run(grant_error=error)
    with pytest.raises(type(error)):
        await _widen(run, recorded)
    assert [call[0] for call in run.calls] == ["get_service", "grant"]
    assert recorded["promoted"] == [] and recorded["blocked"] == []


async def test_a_replaced_service_is_refused_before_any_grant(recorded):
    run = _Run(service=_service(uid="svc-2"))
    with pytest.raises(RuntimeError, match="incarnation"):
        await _widen(run, recorded)
    assert [call[0] for call in run.calls] == ["get_service"]
    assert recorded["promoted"] == []


async def test_a_service_already_public_is_not_replaced_again(recorded):
    run = _Run(service=_service(ingress="all"))
    assert await _widen(run, recorded) == "recorded"
    assert [call[0] for call in run.calls] == ["get_service", "grant"]
    assert len(recorded["promoted"]) == 1


async def test_a_revision_that_never_becomes_ready_is_not_recorded(recorded):
    run = _Run(ready=False)
    assert await _widen(run, recorded) == "not_ready"
    assert recorded["promoted"] == []


async def test_a_moved_address_is_not_recorded(recorded):
    run = _Run(live_url="https://elsewhere.run.app")
    assert await _widen(run, recorded) == "url_changed"
    assert recorded["promoted"] == []


async def test_plan_mode_touches_nothing(recorded, monkeypatch):
    monkeypatch.setattr(widen, "bootstrap_run_client", lambda _row: None)
    assert await widen.widen_existing_if_due(_row(), db=object()) == "plan_mode"
    assert recorded["promoted"] == []


@pytest.mark.parametrize(
    ("row", "why"),
    [
        (_row(ingress="external"), "already public"),
        (_row(ingress="direct"), "already admitted"),
        (_row(directIngressBlocker={"code": odi.BLOCKER_ORG_POLICY}), "blocked"),
        (_row(erasure={}), "being erased"),
        (_row(upgradeLease="2026-10-06T00:00:00+00:00|x"), "update in flight"),
        (_row(tenancy=None), "not an own-cloud row"),
        (_row(serviceUid=None), "incarnation unknown"),
        (_row(observed=None), "an image that never reported itself"),
        (_row(observed={"imageTag": "2026-09-01"}), "an image older than the wall"),
        (_row(url="http://plain"), "not https"),
        (_row(url=URL + "/"), "trailing slash"),
        ({**_row(), "deployment_target": "user_azure"}, "Azure"),
        ({**_row(), "deployment_target": "gcp"}, "managed tier"),
        ({**_row(), "status": "connecting"}, "not provisioned"),
        ({**_row(), "pod_pubkey": None}, "no key"),
        ({**_row(), "user_cloud_bootstrap_sa": None}, "no bootstrap identity"),
        ({**_row(), "user_cloud_project": None}, "no project"),
    ],
)
async def test_a_row_not_due_is_never_touched(recorded, row, why):
    run = _Run()
    assert widen.widen_due(row) is None, why
    assert await _widen(run, recorded, row) == "not_due"
    assert run.calls == [] and recorded["promoted"] == []


@pytest.mark.parametrize("lane", ["uat", "production", ""])
def test_widening_stays_on_the_dev_lane(monkeypatch, lane):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", lane)
    assert widen.widen_due(_row()) is None
    assert odi.ingress_for_update(_row()["backend_metadata"]) is None


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        (_row()["backend_metadata"], "direct"),
        (_row(directIngressBlocker={"code": odi.BLOCKER_ORG_POLICY})["backend_metadata"], None),
        (_row(erasure={})["backend_metadata"], None),
        ({"ingress": "internal"}, None),
        ({"ingress": "external"}, "direct"),
    ],
)
def test_an_update_renders_a_widenable_google_agent_public(metadata, expected):
    assert odi.ingress_for_update(metadata) == expected


def test_a_blocker_survives_a_heal_and_an_update():
    """A heal and an update both write merged metadata; neither retries the widening."""
    metadata = _row(directIngressBlocker={"code": odi.BLOCKER_ORG_POLICY})["backend_metadata"]
    assert odi.ingress_for_provision("user_gcp", {"backend_metadata": metadata}) is None
    assert odi.ingress_for_update(metadata) is None
    from hushh_mcp.services.compute_backend import PodSpec

    hub_spec = PodSpec(
        hushh_id="ha1_owner", phone_e164_hash="h", pod_pubkey="p", deployment_target="user_gcp"
    )
    assert odi.BLOCKER_KEY not in odi.update_ingress_record(hub_spec)
    assert odi.BLOCKER_KEY in {**metadata, **odi.update_ingress_record(hub_spec)}


# -- the durable claim and its backoff ----------------------------------------------------


class _Db:
    def __init__(self, data: list | None = None) -> None:
        self.data = data if data is not None else [{"user_id": "owner"}]
        self.calls: list[tuple[str, dict]] = []

    def execute_raw(self, sql: str, params: dict) -> SimpleNamespace:
        self.calls.append((sql, params))
        return SimpleNamespace(data=self.data)


async def test_the_first_claim_writes_attempt_one_against_no_marker():
    db, now = _Db(), datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
    row = _row()
    assert await widen.claim_widen_attempt(row, widen.widen_due(row), db=db, now=now)
    [(sql, params)] = db.calls
    assert params["previous"] is None
    marker = json.loads(params["marker"])
    assert marker["attempts"] == 1
    assert datetime.fromisoformat(marker["nextAttemptAt"]) == now + timedelta(minutes=5)
    assert "IS NOT DISTINCT FROM CAST(:previous AS jsonb)" in sql
    assert "NOT (backend_metadata ? 'directIngressBlocker')" in sql


async def test_a_later_claim_doubles_the_backoff_and_compares_the_old_marker():
    now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
    previous = {"attempts": 3, "nextAttemptAt": (now - timedelta(seconds=1)).isoformat()}
    row = _row(directIngressWiden=previous)
    db = _Db()
    assert await widen.claim_widen_attempt(row, widen.widen_due(row), db=db, now=now)
    [(_, params)] = db.calls
    assert json.loads(params["previous"]) == previous
    marker = json.loads(params["marker"])
    assert marker["attempts"] == 4
    assert datetime.fromisoformat(marker["nextAttemptAt"]) == now + timedelta(minutes=40)


async def test_a_claim_inside_its_backoff_never_reaches_the_database():
    now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
    row = _row(
        directIngressWiden={"attempts": 1, "nextAttemptAt": (now + timedelta(1)).isoformat()}
    )
    db = _Db()
    assert not await widen.claim_widen_attempt(row, widen.widen_due(row), db=db, now=now)
    assert db.calls == []


async def test_a_lost_claim_is_reported():
    row = _row()
    assert not await widen.claim_widen_attempt(row, widen.widen_due(row), db=_Db(data=[]))


# -- the heartbeat entry point ------------------------------------------------------------


async def test_scheduling_runs_once_per_owner_and_claims_before_widening(monkeypatch):
    order: list[str] = []
    gate = asyncio.Event()

    async def claim(row, due, *, db=None):
        order.append("claim")
        return True

    async def run(row, *, db=None):
        await gate.wait()
        order.append("widen")
        return "recorded"

    monkeypatch.setattr(widen, "claim_widen_attempt", claim)
    monkeypatch.setattr(widen, "widen_existing_if_due", run)
    assert widen.schedule_widen_if_due("owner", row=_row(), db=object())
    assert not widen.schedule_widen_if_due("owner", row=_row(), db=object())
    gate.set()
    await asyncio.gather(*list(widen._TASKS))
    assert order == ["claim", "widen"]
    assert "owner" not in widen._IN_FLIGHT


async def test_a_lost_claim_never_widens(monkeypatch):
    widened: list[dict] = []

    async def claim(row, due, *, db=None):
        return False

    async def run(row, *, db=None):
        widened.append(row)
        return "recorded"

    monkeypatch.setattr(widen, "claim_widen_attempt", claim)
    monkeypatch.setattr(widen, "widen_existing_if_due", run)
    assert widen.schedule_widen_if_due("owner", row=_row(), db=object())
    await asyncio.gather(*list(widen._TASKS))
    assert widened == []


async def test_a_failure_is_swallowed_and_releases_the_owner(monkeypatch):
    async def claim(row, due, *, db=None):
        raise RuntimeError("registry down")

    monkeypatch.setattr(widen, "claim_widen_attempt", claim)
    assert widen.schedule_widen_if_due("owner", row=_row(), db=object())
    [outcome] = await asyncio.gather(*list(widen._TASKS))
    assert outcome == "failed" and "owner" not in widen._IN_FLIGHT


@pytest.mark.parametrize(
    "row",
    [
        _row(ingress="external"),
        _row(directIngressBlocker={"code": odi.BLOCKER_ORG_POLICY}),
        {**_row(), "user_id": "someone-else"},
        _row(directIngressWiden={"attempts": 1, "nextAttemptAt": "2999-01-01T00:00:00+00:00"}),
    ],
)
async def test_a_row_not_due_schedules_nothing(row):
    assert not widen.schedule_widen_if_due("owner", row=row, db=object())
    assert widen._TASKS == set()


def test_scheduling_outside_an_event_loop_is_a_no_op():
    assert not widen.schedule_widen_if_due("owner", row=_row(), db=object())
    assert "owner" not in widen._IN_FLIGHT
