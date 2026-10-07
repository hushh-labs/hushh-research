from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import personal_agent, runtime
from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode


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
