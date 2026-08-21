"""One-click cloud routes: begin returns a caller-bound URL; complete runs the
whole chain and hands off to the one save path."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import runtime as runtime_route


@pytest.fixture(autouse=True)
def _signing(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-32-bytes-long!!")


async def test_begin_refuses_an_invalid_project_id():
    with pytest.raises(HTTPException) as exc:
        await runtime_route.begin_byoc_authorize(
            request=None,
            body=runtime_route.ByocAuthorizeBeginRequest(projectId="BAD_ID!"),
            firebase_uid="u1",
        )
    assert exc.value.status_code == 422


async def test_begin_returns_a_google_consent_url(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    monkeypatch.setattr(oauth, "_oauth_client", lambda: ("cid", "secret", "https://app/return"))
    result = await runtime_route.begin_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeBeginRequest(projectId="hussh-one-fresh1"),
        firebase_uid="u1",
    )
    assert result.authUrl.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "cloud-platform" in result.authUrl
    assert "access_type=online" in result.authUrl


class _FakeJobRepo:
    """In-memory stand-in for ByocSetupJobRepo. Class-level store, because the
    route and the job construct separate instances over the same row."""

    store: dict = {}

    def __init__(self, client=None):
        pass

    async def start(self, *, user_id, job_id, project_id):
        _FakeJobRepo.store[user_id] = {
            "user_id": user_id,
            "job_id": job_id,
            "project_id": project_id,
            "status": "running",
            "stage": "starting",
            "stages": [],
            "error_code": None,
            "error_message": None,
            "updated_at": "2026-08-21T00:00:00+00:00",
        }

    async def _current(self, user_id):
        row = _FakeJobRepo.store.get(user_id)
        return dict(row) if row else None

    async def advance(self, *, user_id, job_id, stage):
        from hushh_mcp.services.byoc_setup_job_service import JobSuperseded

        row = _FakeJobRepo.store.get(user_id)
        if not row or row["job_id"] != job_id:
            raise JobSuperseded(job_id)
        row["stage"] = stage
        row["stages"] = [*row["stages"], {"stage": stage, "at": "t"}]

    async def finish(self, *, user_id, job_id, status, error_code=None, error_message=None):
        from hushh_mcp.services.byoc_setup_job_service import JobSuperseded

        row = _FakeJobRepo.store.get(user_id)
        if not row or row["job_id"] != job_id:
            raise JobSuperseded(job_id)
        row["status"] = status
        row["error_code"] = error_code
        row["error_message"] = error_message

    async def get(self, user_id):
        return await self._current(user_id)


async def _wait_terminal(user_id: str, tries: int = 400):
    import asyncio

    for _ in range(tries):
        row = _FakeJobRepo.store.get(user_id)
        if row and row["status"] != "running":
            return row
        await asyncio.sleep(0.005)
    raise AssertionError(f"job never reached a terminal status: {_FakeJobRepo.store.get(user_id)}")


@pytest.fixture(autouse=True)
def _fake_job_repo(monkeypatch):
    from hushh_mcp.services import byoc_setup_job_service as jobs

    _FakeJobRepo.store = {}
    monkeypatch.setattr(jobs, "ByocSetupJobRepo", _FakeJobRepo)
    yield


def _patch_chain(monkeypatch, oauth, calls, *, billing=None):
    monkeypatch.setattr(oauth, "verify_state", lambda state, uid: "hussh-one-fresh1")
    monkeypatch.setattr(oauth, "exchange_code", lambda code: "transient-token")
    monkeypatch.setattr(
        oauth,
        "ensure_project",
        lambda **kw: calls.append("create") or {"projectId": kw["project_id"], "created": True},
    )
    monkeypatch.setattr(
        oauth,
        "ensure_billing",
        billing
        or (lambda **kw: calls.append("billing") or {"billingLinked": True, "billingAccount": "b"}),
    )

    def _authorize(**kw):
        calls.append("authorize")
        on_apis_enabled = kw.get("on_apis_enabled")
        if on_apis_enabled is not None:
            on_apis_enabled()
        return {}

    monkeypatch.setattr(oauth, "apply_authorization", _authorize)

    async def _fake_save(request, body, firebase_uid):
        calls.append("save")
        return runtime_route.ByocProjectSaveResponse(
            projectId=body.projectId,
            region=body.region,
            bootstrapServiceAccount=f"one-bootstrap@{body.projectId}.iam.gserviceaccount.com",
            authorized=True,
            hushhCaller="caller@x.iam.gserviceaccount.com",
            nextStep="done",
        )

    monkeypatch.setattr(runtime_route, "save_byoc_project", _fake_save)


async def test_complete_answers_fast_and_the_job_runs_the_chain_in_order(monkeypatch):
    """The route returns a claim ticket; the JOB carries the six-stage truth."""
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    calls: list[str] = []
    _patch_chain(monkeypatch, oauth, calls)

    async def _grant_settles(bootstrap_sa, *, deadline, delays=None):
        calls.append("settle")
        return True

    monkeypatch.setattr(runtime_route, "_wait_for_bootstrap_grant", _grant_settles)

    result = await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    assert result.status == "running"
    assert result.projectId == "hussh-one-fresh1"

    row = await _wait_terminal("u1")
    assert row["status"] == "recorded"
    # The order IS the contract, now readable by the person stage by stage.
    assert [entry["stage"] for entry in row["stages"]] == [
        "creating_project",
        "linking_billing",
        "enabling_apis",
        "applying_iam",
        "settling_grant",
        "proving",
    ]
    assert calls == ["create", "billing", "authorize", "settle", "save"]


async def test_a_typed_refusal_lands_on_the_record_not_a_500(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    calls: list[str] = []

    def _needs_billing(**kw):
        raise oauth.ByocAuthorizeError("no billing", status_code=409, code="NEEDS_BILLING")

    _patch_chain(monkeypatch, oauth, calls, billing=_needs_billing)

    await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    row = await _wait_terminal("u1")
    assert row["status"] == "failed"
    assert row["error_code"] == "NEEDS_BILLING"
    assert row["error_message"] == "no billing"
    assert "save" not in calls


async def test_the_job_waits_out_iam_propagation(monkeypatch):
    """The founder's flake, now the machine's job: two refusals, then settled."""
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services import user_gcp_bootstrap

    calls: list[str] = []
    _patch_chain(monkeypatch, oauth, calls)
    monkeypatch.setattr(jobs, "SETTLE_DELAYS_SECONDS", (0.001, 0.001, 0.001))

    probes = {"n": 0}

    def _flaky_mint(*, bootstrap_sa):
        probes["n"] += 1
        if probes["n"] < 3:
            raise user_gcp_bootstrap.BootstrapError("grant not yet visible")
        return "token"

    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", _flaky_mint)

    await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    row = await _wait_terminal("u1")
    assert row["status"] == "recorded"
    assert probes["n"] == 3
    assert calls[-1] == "save"


async def test_a_grant_that_never_settles_fails_typed_on_the_record(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services import user_gcp_bootstrap

    calls: list[str] = []
    _patch_chain(monkeypatch, oauth, calls)
    monkeypatch.setattr(jobs, "SETTLE_DELAYS_SECONDS", (0.001, 0.001))

    def _never(*, bootstrap_sa):
        raise user_gcp_bootstrap.BootstrapError("grant not yet visible")

    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", _never)

    await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    row = await _wait_terminal("u1")
    assert row["status"] == "failed"
    assert row["error_code"] == "GRANT_SETTLING"
    assert "Try again" in row["error_message"]
    assert "save" not in calls


async def test_a_bad_state_still_refuses_synchronously(monkeypatch):
    """Pre-job refusals (state, code) stay immediate: no job row is minted."""
    with pytest.raises(HTTPException) as exc:
        await runtime_route.complete_byoc_authorize(
            request=None,
            body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="not-byoc"),
            firebase_uid="u1",
        )
    assert exc.value.status_code == 400
    assert _FakeJobRepo.store == {}


async def test_status_route_serves_none_then_the_live_record(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    empty = await runtime_route.byoc_setup_status(request=None, firebase_uid="u1")
    assert empty.status == "none"

    calls: list[str] = []
    _patch_chain(monkeypatch, oauth, calls)

    async def _grant_settles(bootstrap_sa, *, deadline, delays=None):
        return True

    monkeypatch.setattr(runtime_route, "_wait_for_bootstrap_grant", _grant_settles)

    await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    await _wait_terminal("u1")

    status = await runtime_route.byoc_setup_status(request=None, firebase_uid="u1")
    assert status.status == "recorded"
    assert status.projectId == "hussh-one-fresh1"
    assert [entry["stage"] for entry in status.stages][-1] == "proving"
    assert status.stale is False
