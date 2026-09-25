from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import personal_agent, runtime
from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode


@pytest.mark.parametrize(
    ("row", "job", "registry_ok", "job_ok", "expected"),
    [
        (None, None, True, True, "shared"),
        ({"status": "unprovisioned"}, None, True, True, "shared"),
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
def test_hosting_mode_requires_confirmed_absence_before_shared(
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


async def test_personal_agent_status_reports_shared_only_after_empty_registry_and_job(monkeypatch):
    class _Registry:
        async def get(self, _user_id: str):
            return None

    class _Jobs:
        async def get(self, _user_id: str):
            return None

    monkeypatch.setattr(personal_agent, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_setup_job_service.ByocSetupJobRepo", _Jobs, raising=False
    )

    result = await personal_agent.resolve_personal_agent_status(user_id="u1", registry=_Registry())

    assert result["state"] == "none"
    assert result["hostingMode"] == "shared"


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
