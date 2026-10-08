"""A free-trial Azure subscription is named on the setup record, read-only and best effort.

Risk 1 of the pod economics sheet: Microsoft disables a free trial after 30 days unless
the person upgrades, and their agent stops with it, while the app said nothing. The
measured subscription body (dev trial, 2026-10-06, api-version 2022-12-01) is the
fixture: ``quotaId=FreeTrial_2014-09-01``, ``spendingLimit=On``.
"""

from __future__ import annotations

import copy
from typing import Any, Optional

import pytest

from hushh_mcp.services import azure_setup_job as job
from hushh_mcp.services import azure_subscription_offer as offer_mod
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_subscription_offer import (
    OFFER_STAGE,
    SubscriptionOffer,
    note_subscription_offer,
    offer_from_subscription,
    read_subscription_offer,
    record_subscription_offer,
)
from hushh_mcp.services.byoc_setup_job_service import JobSuperseded
from hushh_mcp.services.compute_backend import PodSpec
from tests.test_azure_setup_job import _result
from tests.test_byoc_azure_routes import (  # noqa: F401 - fixture
    _COMPLETE,
    _SUB,
    _client,
    _listing,
    _redeems_as,
    _state,
    spawned,
)

_SUBSCRIPTION = "8edb2a2a-84bd-421c-b321-6c0a934d863d"
_TOKEN = "person-delegated-token-for-tests"  # noqa: S105 - no service exists to authenticate to

#: The measured ARM body, trimmed to what the read uses.
_TRIAL_BODY = {
    "subscriptionId": _SUBSCRIPTION,
    "state": "Enabled",
    "subscriptionPolicies": {
        "locationPlacementId": "Public_2014-09-01",
        "quotaId": "FreeTrial_2014-09-01",
        "spendingLimit": "On",
    },
}


class _Arm:
    def __init__(self, body: Any = None, error: Optional[Exception] = None) -> None:
        self.body, self.error = body, error
        self.calls: list[tuple[str, str]] = []

    def get(self, path: str, *, api_version: str, op: str = "") -> Any:
        self.calls.append((path, api_version))
        if self.error is not None:
            raise self.error
        return copy.deepcopy(self.body)


class _Jobs:
    """The job row as ``ByocSetupJobRepo`` keeps it: ``advance`` moves ``stage``."""

    def __init__(self, job_id: str = "j1") -> None:
        self.row: dict[str, Any] = {
            "job_id": job_id, "status": "running", "stage": "starting", "stages": [],
        }  # fmt: skip
        self.finished: dict[str, Any] = {}

    async def get(self, user_id):
        return copy.deepcopy(self.row)

    async def _guarded_update(self, *, user_id, job_id, data):
        if self.row["job_id"] != job_id:
            raise JobSuperseded(job_id)
        self.row.update(copy.deepcopy(data))

    async def advance(self, *, user_id, job_id, stage):
        stages = [*self.row["stages"], {"stage": stage, "at": "t"}]
        await self._guarded_update(
            user_id=user_id, job_id=job_id, data={"stage": stage, "stages": stages}
        )

    async def finish(self, *, user_id, job_id, status, error_code=None, error_message=None):
        self.finished = {"status": status, "code": error_code}

    async def touch(self, *, user_id, job_id):
        return True


def _trial() -> SubscriptionOffer:
    found = offer_from_subscription(_TRIAL_BODY)
    assert found is not None
    return found


# -- reading the offer ----------------------------------------------------------------


def test_the_measured_trial_body_reads_as_a_free_trial():
    offer = _trial()
    assert (offer.quota_id, offer.spending_limit, offer.free_trial) == (
        "FreeTrial_2014-09-01",
        "On",
        True,
    )


@pytest.mark.parametrize(
    "quota", ["PayAsYouGo_2014-09-01", "AzureForStudents_2018-01-01", "MSDN_2014-09-01"]
)
def test_only_the_free_trial_quota_is_called_a_free_trial(quota):
    """A spending limit is on for student and Visual Studio offers too; not 30 days."""
    body = {"subscriptionPolicies": {"quotaId": quota, "spendingLimit": "On"}}
    offer = offer_from_subscription(body)
    assert offer is not None and offer.free_trial is False


@pytest.mark.parametrize("body", [{}, {"subscriptionPolicies": {}}, None, []])
def test_a_body_without_a_quota_names_no_offer(body):
    assert offer_from_subscription(body) is None


def test_the_read_is_one_get_of_the_subscription_on_the_pinned_version():
    arm = _Arm(_TRIAL_BODY)
    offer = read_subscription_offer(_TOKEN, _SUBSCRIPTION.upper(), arm=arm)  # type: ignore[arg-type]
    assert offer is not None and offer.free_trial
    assert arm.calls == [(f"/subscriptions/{_SUBSCRIPTION}", "2022-12-01")]


def test_a_malformed_subscription_id_is_never_sent_to_arm():
    arm = _Arm(_TRIAL_BODY)
    assert read_subscription_offer(_TOKEN, "../providers", arm=arm) is None  # type: ignore[arg-type]
    assert arm.calls == []


# -- recording it -----------------------------------------------------------------------


async def test_the_entry_joins_stages_and_never_moves_the_current_stage():
    jobs = _Jobs()
    jobs.row.update(stage="proving", stages=[{"stage": "proving", "at": "t0"}])
    await record_subscription_offer(jobs, user_id="u1", job_id="j1", offer=_trial())
    assert jobs.row["stage"] == "proving"  # the publish step requires it
    entry = jobs.row["stages"][-1]
    assert {k: entry[k] for k in ("stage", "quotaId", "spendingLimit", "freeTrial")} == {
        "stage": OFFER_STAGE,
        "quotaId": "FreeTrial_2014-09-01",
        "spendingLimit": "On",
        "freeTrial": True,
    }
    assert _TOKEN not in repr(jobs.row)


async def test_a_second_record_replaces_the_first_rather_than_doubling():
    jobs = _Jobs()
    await record_subscription_offer(jobs, user_id="u1", job_id="j1", offer=_trial())
    paid = SubscriptionOffer(quota_id="PayAsYouGo_2014-09-01", spending_limit="Off")
    await record_subscription_offer(jobs, user_id="u1", job_id="j1", offer=paid)
    offers = [s for s in jobs.row["stages"] if s["stage"] == OFFER_STAGE]
    assert len(offers) == 1 and offers[0]["freeTrial"] is False


async def test_a_superseded_job_writes_nothing():
    jobs = _Jobs(job_id="newer")
    with pytest.raises(JobSuperseded):
        await record_subscription_offer(jobs, user_id="u1", job_id="j1", offer=_trial())
    assert jobs.row["stages"] == []


async def test_an_unreadable_subscription_records_nothing_and_does_not_raise():
    jobs = _Jobs()

    def refused(_token, _subscription):
        raise ArmError("forbidden", status=403, code="AuthorizationFailed", message="", op="x")

    got = await note_subscription_offer(
        jobs, user_id="u1", job_id="j1", access_token=_TOKEN, subscription_id=_SUB, read=refused
    )
    assert got is None and jobs.row["stages"] == []


async def test_a_superseded_job_still_stops_through_the_best_effort_note():
    with pytest.raises(JobSuperseded):
        await note_subscription_offer(
            _Jobs(job_id="newer"), user_id="u1", job_id="j1", access_token=_TOKEN,
            subscription_id=_SUB, read=lambda _t, _s: _trial(),
        )  # fmt: skip


# -- the setup job and the route ---------------------------------------------------------


def _spec() -> PodSpec:
    return PodSpec(hushh_id="h", phone_e164_hash="p", pod_pubkey="")


async def _run(jobs: _Jobs, reader) -> None:
    def setup(**kwargs):
        kwargs["advance"]("creating_resource_group")
        kwargs["advance"]("proving")
        return _result()

    async def publish(_repo, **_kwargs):
        return None

    async def note(repo, **kwargs):
        return await note_subscription_offer(repo, read=reader, **kwargs)

    await job.run_azure_setup_job(
        user_id="u1", job_id="j1", access_token=_TOKEN, tenant_id="t", subscription_id=_SUB,
        location="eastus2", spec=_spec(), source_image="r.example.com/p@sha256:" + "b" * 64,
        repo=jobs, setup=setup, publish=publish, note_offer=note,
    )  # fmt: skip


async def test_a_trial_setup_records_the_offer_first_and_still_finishes():
    jobs, seen = _Jobs(), []

    def reader(token, subscription):
        seen.append((token, subscription))
        return _trial()

    await _run(jobs, reader)
    assert seen == [(_TOKEN, _SUB)]
    assert [s["stage"] for s in jobs.row["stages"]] == [
        OFFER_STAGE,
        "creating_resource_group",
        "proving",
    ]
    assert jobs.finished == {"status": "recorded", "code": None}


async def test_a_failed_offer_read_never_fails_the_setup():
    jobs = _Jobs()

    def reader(_token, _subscription):
        raise OSError("network down")

    await _run(jobs, reader)
    assert jobs.finished == {"status": "recorded", "code": None}
    assert OFFER_STAGE not in [s["stage"] for s in jobs.row["stages"]]


def test_the_setup_route_hands_the_job_the_offer_note(spawned, monkeypatch):  # noqa: F811
    _redeems_as(monkeypatch)
    _listing(monkeypatch, (_SUB, "Enabled"))
    response = _client().post(_COMPLETE, json={"code": "c", "state": _state()})
    assert response.json()["status"] == "setup_started"
    kind, kwargs = spawned[0]
    assert kind == "setup" and kwargs["note_offer"] is offer_mod.note_subscription_offer
