"""Shared is an explicit, recorded choice; a person with no placement is `unplaced`.

Founder direction, 2026-10-06: the hub runtime is only for Hussh Shared, and only
when the person chose it. Never chose, or detached since choosing, reads `unplaced`
and gets the tier chooser. A begun own-cloud setup reads `pending` from the moment
the person leaves for the cloud's sign-in.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from api.routes.one import personal_agent, runtime, runtime_placement
from hushh_mcp.services import byoc_setup_intent
from hushh_mcp.services import personal_agent_hosting as hosting
from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode

DETACHED_AT = "2026-10-06T10:00:00Z"
BEFORE = datetime(2026, 10, 6, 9, 0, tzinfo=timezone.utc)
AFTER = datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc)


def _detached(at: str | None = DETACHED_AT) -> dict:
    placement: dict = {"user_cloud_project": "owner-project"}
    if at is not None:
        placement["detachedAt"] = at
    return {
        "status": "unprovisioned",
        "deployment_target": None,
        "backend_metadata": {"detachedPlacements": [placement]},
    }


def _shared(at) -> dict:
    return {"tier": "shared", "chosen_at": at}


NOW = AFTER + timedelta(minutes=5)


def _mode(row=None, job=None, choice=None, choice_ok=True, now=NOW) -> str:
    return resolve_hosting_mode(
        row=row,
        registry_read_ok=True,
        setup_job=job,
        setup_job_read_ok=True,
        shared_choice=choice,
        shared_choice_read_ok=choice_ok,
        now=now,
    )


# -- the mode matrix -------------------------------------------------------------


def test_no_placement_and_no_choice_is_unplaced_never_shared():
    assert _mode() == "unplaced"


def test_an_explicit_shared_choice_is_shared():
    assert _mode(choice=_shared(AFTER)) == "shared"


def test_an_unreadable_choice_is_unknown_never_shared():
    assert _mode(choice=None, choice_ok=False) == "unknown"


def test_detach_makes_the_person_unplaced_even_after_an_older_shared_choice():
    assert _mode(row=_detached(), choice=_shared(BEFORE)) == "unplaced"


def test_a_shared_choice_newer_than_the_detach_is_shared():
    assert _mode(row=_detached(), choice=_shared(AFTER)) == "shared"


def test_a_detach_without_a_readable_time_supersedes_every_choice():
    assert _mode(row=_detached(at=None), choice=_shared(AFTER)) == "unplaced"


@pytest.mark.parametrize("choice", [{"tier": "shared"}, {"tier": "pods", "chosen_at": AFTER}, {}])
def test_a_malformed_choice_is_not_shared(choice):
    assert _mode(choice=choice) == "unplaced"


def test_a_begun_setup_is_pending_not_shared_even_with_an_old_shared_choice():
    intent = {"status": "pending", "stage": "consent_pending", "created_at": AFTER}
    assert _mode(job=intent, choice=_shared(BEFORE)) == "pending"


def _intent(touched, **extra) -> dict:
    return {"status": "pending", "stage": "consent_pending", "updated_at": touched, **extra}


def test_an_abandoned_begin_stops_holding_a_shared_owner_off_the_hub():
    later = AFTER + hosting.INTENT_EXPIRES_AFTER + timedelta(minutes=1)
    assert _mode(job=_intent(AFTER), choice=_shared(BEFORE), now=later) == "shared"
    assert _mode(job=_intent(AFTER), now=later) == "unplaced"


@pytest.mark.parametrize(
    "job",
    [
        _intent(AFTER, project_id="owner-project"),  # a real job owns a project
        _intent(None),  # an unreadable time stays pending
        {"status": "running", "stage": "consent_pending", "updated_at": AFTER},
        {"status": "pending", "stage": "settling_grant", "updated_at": AFTER},
    ],
)
def test_only_an_untouched_intent_ever_expires(job):
    later = AFTER + hosting.INTENT_EXPIRES_AFTER + timedelta(minutes=1)
    assert _mode(job=job, choice=_shared(BEFORE), now=later) == "pending"


def test_a_job_created_before_the_detach_is_history_and_the_person_is_unplaced():
    old_job = {"status": "recorded", "stage": "proving", "created_at": BEFORE}
    assert _mode(row=_detached(), job=old_job) == "unplaced"


def test_a_job_created_after_the_detach_is_current():
    new_job = {"status": "failed", "stage": "settling_grant", "created_at": AFTER}
    assert _mode(row=_detached(), job=new_job) == "pending"


def test_epoch_millisecond_and_iso_times_compare():
    millis = int((datetime(2026, 10, 6, 12, tzinfo=timezone.utc)).timestamp() * 1000)
    assert _mode(row=_detached(), choice=_shared(millis)) == "shared"
    assert _mode(row=_detached(), choice=_shared("2026-10-06T09:59:59+00:00")) == "unplaced"


def test_a_choice_or_job_in_the_same_second_as_the_detach_reads_as_before_it():
    # detachedAt is whole seconds; chosen_at and created_at carry microseconds.
    same_second = datetime(2026, 10, 6, 10, 0, 0, 400_000, tzinfo=timezone.utc)
    assert _mode(row=_detached(), choice=_shared(same_second)) == "unplaced"
    job = {"status": "failed", "stage": "settling_grant", "created_at": same_second}
    assert _mode(row=_detached(), job=job) == "unplaced"
    next_second = same_second + timedelta(seconds=1)
    assert _mode(row=_detached(), choice=_shared(next_second)) == "shared"


async def test_observed_mode_reads_the_choice_only_for_an_unplaced_person(monkeypatch):
    reads: list[str] = []

    class _Choices:
        async def get(self, user_id):
            reads.append(user_id)
            return _shared(datetime.now(timezone.utc))

    class _Jobs:
        async def get(self, _user_id):
            return None

    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", _Choices)
    monkeypatch.setattr("hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", _Jobs)

    shared = await hosting.resolve_observed_hosting_mode(
        user_id="u1", row=None, registry_read_ok=True
    )
    byoc = await hosting.resolve_observed_hosting_mode(
        user_id="u2", row={"deployment_target": "user_gcp"}, registry_read_ok=True
    )
    assert (shared, byoc) == ("shared", "byoc")
    assert reads == ["u1"]


async def test_observed_mode_fails_closed_when_the_choice_store_is_down(monkeypatch):
    class _Down:
        async def get(self, _user_id):
            raise RuntimeError("vault_keys unreachable")

    class _Jobs:
        async def get(self, _user_id):
            return None

    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", _Down)
    monkeypatch.setattr("hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", _Jobs)
    mode = await hosting.resolve_observed_hosting_mode(
        user_id="u1", row=None, registry_read_ok=True
    )
    assert mode == "unknown"


# -- Shared is recorded only by an explicit choice --------------------------------


class _ChoiceRecorder:
    calls: list[str] = []

    async def record_shared(self, user_id):
        _ChoiceRecorder.calls.append(user_id)
        return _shared(datetime.now(timezone.utc))


def _wire_select(monkeypatch, modes: list[str], *, cleared: bool = False):
    marked: list[str] = []
    seen = iter(modes)

    async def _status(*, user_id: str):
        return {"hostingMode": next(seen)}

    async def _clear(_user_id):
        return cleared

    async def _mark(user_id):
        marked.append(user_id)

    _ChoiceRecorder.calls = []
    monkeypatch.setattr(personal_agent, "resolve_personal_agent_status", _status)
    monkeypatch.setattr(byoc_setup_intent, "clear_intent", _clear)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _mark)
    monkeypatch.setattr(
        "hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", _ChoiceRecorder
    )
    return marked


async def test_an_unplaced_person_choosing_shared_records_the_choice(monkeypatch):
    marked = _wire_select(monkeypatch, ["unplaced"])
    response = await runtime.select_shared_hosting.__wrapped__(  # type: ignore[attr-defined]
        request=None, firebase_uid="u1"
    )
    assert response.hostingMode == "shared"
    assert _ChoiceRecorder.calls == ["u1"]
    assert marked == ["u1"]


async def test_choosing_shared_over_an_untouched_intent_clears_it_then_records(monkeypatch):
    marked = _wire_select(monkeypatch, ["pending", "unplaced"], cleared=True)
    await runtime_placement.select_shared("u1")
    assert _ChoiceRecorder.calls == ["u1"]
    assert marked == ["u1"]


async def test_a_real_setup_job_is_never_replaced_by_shared(monkeypatch):
    marked = _wire_select(monkeypatch, ["pending"], cleared=False)
    with pytest.raises(HTTPException) as refused:
        await runtime_placement.select_shared("u1")
    assert refused.value.status_code == 409
    assert _ChoiceRecorder.calls == [] and marked == []


async def test_a_choice_that_cannot_be_saved_is_a_503_and_completes_nothing(monkeypatch):
    marked = _wire_select(monkeypatch, ["unplaced"])

    class _Broken:
        async def record_shared(self, _user_id):
            raise RuntimeError("vault_keys unreachable")

    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", _Broken)
    with pytest.raises(HTTPException) as refused:
        await runtime_placement.select_shared("u1")
    assert refused.value.status_code == 503
    assert refused.value.detail["code"] == "HOSTING_CHOICE_UNAVAILABLE"
    assert marked == []


# -- a begun own-cloud setup is recorded before the sign-in -----------------------


class _Raw:
    def __init__(self, data=None, fail: bool = False):
        self.calls: list[tuple[str, dict]] = []
        self._data = data if data is not None else [{"job_id": "j"}]
        self._fail = fail

    def execute_raw(self, sql, params):
        self.calls.append((sql, params))
        if self._fail:
            raise RuntimeError("db down")

        class _R:
            data = self._data

        return _R()


async def test_an_intent_names_the_project_only_inside_its_stage_entry():
    client = _Raw()
    assert await byoc_setup_intent.record_intent(
        "u1", provider="gcp", project="owner-project", client=client
    )
    sql, params = client.calls[0]
    assert "VALUES (:owner, :job, '', 'pending', 'consent_pending'" in sql
    # Only an earlier untouched intent is refreshed; a real job row is never replaced.
    assert "WHERE byoc_setup_jobs.stage = 'consent_pending'" in sql
    assert "owner-project" in params["stages"] and params["owner"] == "u1"


async def test_an_intent_that_cannot_be_written_never_blocks_the_sign_in():
    assert (
        await byoc_setup_intent.record_intent("u1", provider="azure", client=_Raw(fail=True))
        is False
    )


async def test_only_an_untouched_intent_is_ever_cleared():
    client = _Raw()
    assert await byoc_setup_intent.clear_intent("u1", client=client)
    sql = client.calls[0][0]
    for guard in ("stage = 'consent_pending'", "status = 'pending'", "project_id = ''"):
        assert guard in sql
    assert "authorization_attempts = '{}'::jsonb" in sql


async def test_google_begin_records_the_intent_after_the_url_is_built(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    recorded: list[tuple] = []

    async def _record(user_id, *, provider, project=""):
        recorded.append((user_id, provider, project))
        return True

    async def _unassigned(_user_id):
        return None

    monkeypatch.setattr(oauth, "begin", lambda uid, project, **_: f"https://consent/{project}")
    monkeypatch.setattr(byoc_setup_intent, "record_intent", _record)
    monkeypatch.setattr(runtime, "_require_unassigned_byoc", _unassigned)
    response = await runtime.begin_byoc_authorize.__wrapped__(  # type: ignore[attr-defined]
        request=None,
        body=runtime.ByocAuthorizeBeginRequest(projectId="owner-project-1"),
        firebase_uid="u1",
    )
    assert response.authUrl == "https://consent/owner-project-1"
    assert recorded == [("u1", "gcp", "owner-project-1")]


def test_setup_status_reports_the_intent_project_and_the_attach_blocker():
    row = {
        "status": "pending",
        "stage": "consent_pending",
        "project_id": "",
        "job_id": "j1",
        "stages": [{"stage": "consent_pending", "provider": "gcp", "project": "owner-project"}],
    }
    fields = runtime_placement.setup_status_fields(row)
    assert fields["projectId"] == "owner-project"
    assert fields["attachBlocked"] is None

    blocked = [{"stage": "proving"}, {"stage": "attach_blocked", "code": "PHONE_NOT_VERIFIED"}]
    assert runtime_placement.attach_blocked(blocked) == "PHONE_NOT_VERIFIED"
    assert runtime_placement.attach_blocked([*blocked, {"stage": "attach_started"}]) is None


def test_the_intent_window_is_fresh_after_a_late_detach():
    """An intent created after a detach counts; one created before it is history."""
    late = {
        "status": "pending",
        "stage": "consent_pending",
        "created_at": AFTER + timedelta(minutes=1),
    }
    assert _mode(row=_detached(), job=late) == "pending"
