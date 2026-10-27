from __future__ import annotations

import pytest
from fastapi import HTTPException
from psycopg2.errors import UndefinedTable

from api.routes.one import personal_agent, runtime
from db.db_client import DatabaseExecutionError, QueryResult
from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode
from hushh_mcp.services.placement_observation import read_optional_placement


@pytest.mark.parametrize("catalog", [[{"present": True}], [], [{"present": 0}]])
async def test_optional_placement_never_treats_unconfirmed_absence_as_no_placement(catalog):
    class Registry:
        async def get(self, _user_id):
            raise DatabaseExecutionError(
                table_name="personal_agent_registry", operation="select", details="suppressed"
            ) from UndefinedTable()

        def _db(self):
            return self

        def execute_raw(self, _sql, params):
            assert params == {"relation": "public.personal_agent_registry"}
            return QueryResult(data=catalog)

    with pytest.raises(DatabaseExecutionError):
        await read_optional_placement(Registry(), "u1", table="personal_agent_registry")


async def test_optional_placement_preserves_unreadable_existing_store():
    class Registry:
        async def get(self, _user_id):
            raise DatabaseExecutionError(
                table_name="personal_agent_registry", operation="select", details="suppressed"
            )

        def _db(self):
            raise AssertionError("generic failures cannot establish absence")

    with pytest.raises(DatabaseExecutionError):
        await read_optional_placement(Registry(), "u1", table="personal_agent_registry")


@pytest.mark.parametrize(
    ("row", "job", "registry_ok", "job_ok", "expected"),
    [
        # No placement and no recorded choice: the chooser, never the hub runtime.
        (None, None, True, True, "unplaced"),
        ({"status": "unprovisioned"}, None, True, True, "unplaced"),
        (None, {"status": "pending", "stage": "consent_pending"}, True, True, "pending"),
        ({"deployment_target": "user_gcp"}, None, True, True, "byoc"),
        ({"deployment_target": "gcp"}, None, True, True, "hussh_pods"),
        ({"deployment_target": "user_gcp", "status": "connecting"}, None, True, True, "pending"),
        ({"deployment_target": "gcp", "status": "provisioning"}, None, True, True, "pending"),
        ({"status": "pending"}, None, True, True, "pending"),
        ({"status": "provisioning"}, None, True, True, "pending"),
        ({"status": "connecting"}, None, True, True, "pending"),
        (None, {"status": "running", "stage": "proving"}, True, True, "pending"),
        (
            None,
            {"status": "recorded", "stage": "awaiting_agent_record"},
            True,
            True,
            "pending",
        ),
        (None, None, False, True, "unknown"),
        (None, None, True, False, "unknown"),
        ({"status": "provisioned"}, None, True, True, "unknown"),
        ({"deployment_target": "future_target"}, None, True, True, "unknown"),
    ],
)
def test_hosting_mode_requires_confirmed_absence_and_never_defaults_to_shared(
    row, job, registry_ok, job_ok, expected
):
    assert (
        resolve_hosting_mode(
            row=row,
            registry_read_ok=registry_ok,
            setup_job=job,
            setup_job_read_ok=job_ok,
        )
        == expected
    )


async def test_personal_agent_status_reports_unplaced_after_empty_registry_and_job(monkeypatch):
    class _Registry:
        async def get(self, _user_id: str):
            return None

    class _Jobs:
        async def get(self, _user_id: str):
            return None

    class _NoChoice:
        async def get(self, _user_id: str):
            return None

    monkeypatch.setattr(personal_agent, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", _Jobs, raising=False
    )
    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo", _NoChoice)

    result = await personal_agent.resolve_personal_agent_status(user_id="u1", registry=_Registry())

    assert result["state"] == "none"
    assert result["hostingMode"] == "unplaced"


async def test_shared_selection_marks_onboarding_complete_without_assigning_a_pod(monkeypatch):
    marked: list[str] = []

    async def _shared_status(*, user_id: str):
        assert user_id == "u1"
        return {"hostingMode": "shared"}

    async def _mark(user_id: str):
        marked.append(user_id)

    monkeypatch.setattr(personal_agent, "resolve_personal_agent_status", _shared_status)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _mark)

    response = await runtime.select_shared_hosting.__wrapped__(  # type: ignore[attr-defined]
        request=None, firebase_uid="u1"
    )

    assert response.hostingMode == "shared"
    assert marked == ["u1"]


@pytest.mark.parametrize("mode", ["byoc", "hussh_pods", "pending"])
async def test_shared_selection_preserves_existing_or_pending_pod(mode, monkeypatch):
    async def _status(*, user_id: str):
        return {"hostingMode": mode}

    async def _no_intent(_user_id: str):
        return False  # a real setup job, not an untouched intent

    monkeypatch.setattr("hushh_mcp.services.byoc_setup_intent.clear_intent", _no_intent)

    async def _must_not_mark(_user_id: str):
        raise AssertionError("a non-Shared setup must not be silently changed")

    monkeypatch.setattr(personal_agent, "resolve_personal_agent_status", _status)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _must_not_mark)

    with pytest.raises(HTTPException) as failure:
        await runtime.select_shared_hosting.__wrapped__(  # type: ignore[attr-defined]
            request=None, firebase_uid="u1"
        )

    assert failure.value.status_code == 409
    assert failure.value.detail["code"] == "POD_ASSIGNMENT_PRESERVED"


async def test_shared_selection_fails_closed_when_placement_is_unknown(monkeypatch):
    async def _status(*, user_id: str):
        return {"hostingMode": "unknown"}

    async def _must_not_mark(_user_id: str):
        raise AssertionError("unknown placement cannot complete setup")

    monkeypatch.setattr(personal_agent, "resolve_personal_agent_status", _status)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _must_not_mark)

    with pytest.raises(HTTPException) as failure:
        await runtime.select_shared_hosting.__wrapped__(  # type: ignore[attr-defined]
            request=None, firebase_uid="u1"
        )

    assert failure.value.status_code == 503
    assert failure.value.detail["code"] == "HOSTING_STATUS_UNAVAILABLE"


def _detached_row(project: str) -> dict:
    return {
        "status": "unprovisioned",
        "deployment_target": None,
        "backend_metadata": {"detachedPlacements": [{"user_cloud_project": project}]},
    }


def test_an_attached_job_for_a_detached_placement_is_history():
    """After a detach the old setup job must not trap the person in 'unknown'.

    A detach does not make the person Shared: they choose again.
    """
    mode = resolve_hosting_mode(
        row=_detached_row("owner-project"),
        registry_read_ok=True,
        setup_job={"stage": "attached", "project_id": "owner-project"},
        setup_job_read_ok=True,
    )
    assert mode == "unplaced"


@pytest.mark.parametrize(
    "setup_job",
    [
        {"stage": "attached", "project_id": "another-project"},
        {"stage": "applying_iam", "project_id": "owner-project"},
    ],
)
def test_a_job_that_is_not_the_detached_placement_still_counts(setup_job):
    mode = resolve_hosting_mode(
        row=_detached_row("owner-project"),
        registry_read_ok=True,
        setup_job=setup_job,
        setup_job_read_ok=True,
    )
    assert mode in {"unknown", "pending"}


@pytest.mark.parametrize(
    ("observations", "expected_error", "recorded"),
    [
        (["unplaced", "unplaced"], None, True),
        (["shared"], None, False),
        (["pending"], 409, False),
        (["byoc"], 409, False),
        (["hussh_pods"], 409, False),
        (["unknown"], 503, False),
        (["unplaced", "pending"], 409, False),
        (["unplaced", "byoc"], 409, False),
        (["unplaced", "unknown"], 503, False),
    ],
)
async def test_explicit_shared_recovery_preserves_private_and_concurrent_setup(
    monkeypatch, observations, expected_error, recorded
):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from api.routes.one import runtime_placement
    from hushh_mcp.services import byoc_setup_intent
    from hushh_mcp.services.owner_hosting_choice import HostingChoiceRepo
    from hushh_mcp.services.shared_files import registry

    monkeypatch.setenv("SHARED_EXPERIENCE_RECOVERY_ENABLED", "true")
    observe = AsyncMock(side_effect=[*observations, observations[-1]])
    record, marker, clear = AsyncMock(), AsyncMock(), AsyncMock()
    locked = []

    @asynccontextmanager
    async def placement_lock(owner):
        assert owner == "u1"
        locked.append(True)
        yield

    monkeypatch.setattr(runtime_placement, "_placement", observe)
    monkeypatch.setattr(HostingChoiceRepo, "record_shared", record)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", marker)
    monkeypatch.setattr(byoc_setup_intent, "clear_intent", clear)
    monkeypatch.setattr(registry, "protect_placement_change", placement_lock)
    request = runtime_placement.SharedHostingSelectionRequest(recovery=True, expectedOwnerId="u1")
    if expected_error is not None:
        with pytest.raises(HTTPException) as refused:
            await runtime.select_shared_hosting.__wrapped__(
                request=None, firebase_uid="u1", body=request
            )
        assert refused.value.status_code == expected_error
        marker.assert_not_awaited()
    else:
        response = await runtime.select_shared_hosting.__wrapped__(
            request=None, firebase_uid="u1", body=request
        )
        assert response.hostingMode == "shared"
        marker.assert_awaited_once_with("u1")
    assert record.await_count == int(recorded)
    assert bool(locked) is (observations[0] == "unplaced")
    clear.assert_not_awaited()


@pytest.mark.parametrize("mode", ["shared", "unplaced", "pending", "byoc", "hussh_pods", "unknown"])
async def test_shared_recovery_projection_is_explicit_owner_bound_and_default_off(
    monkeypatch, mode
):
    from unittest.mock import AsyncMock

    from hushh_mcp import runtime_settings
    from hushh_mcp.services import shared_experience_recovery as recovery

    monkeypatch.delenv("SHARED_EXPERIENCE_RECOVERY_ENABLED", raising=False)
    observe = AsyncMock(return_value=mode)
    monkeypatch.setattr(recovery, "get_owner_hosting_mode", observe)
    assert await recovery.shared_recovery_for_owner("u1") is False
    observe.assert_not_awaited()
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", '{"shared_experience_recovery_enabled":true}')
    runtime_settings.hydrate_runtime_environment()
    assert await recovery.shared_recovery_for_owner("u1") is (mode in {"shared", "unplaced"})
    observe.assert_awaited_once_with("u1")
    monkeypatch.setenv("SHARED_EXPERIENCE_RECOVERY_ENABLED", "false")
    runtime_settings.hydrate_runtime_environment()
    observe.reset_mock()
    assert await recovery.shared_recovery_for_owner("u1") is False
    observe.assert_not_awaited()


@pytest.mark.parametrize("expected_owner", [None, "previous-owner"])
async def test_shared_recovery_refuses_a_changed_or_missing_owner_before_selection(
    monkeypatch, expected_owner
):
    from unittest.mock import AsyncMock

    from api.routes.one import runtime_placement

    select = AsyncMock()
    monkeypatch.setattr(runtime_placement, "select_shared_recovery", select)
    body = runtime_placement.SharedHostingSelectionRequest(
        recovery=True, expectedOwnerId=expected_owner
    )
    with pytest.raises(HTTPException) as refused:
        await runtime.select_shared_hosting.__wrapped__(
            request=None, firebase_uid="current-owner", body=body
        )
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "SHARED_RECOVERY_OWNER_CHANGED"
    select.assert_not_awaited()
