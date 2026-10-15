"""Referral dashboard wire and owner-admission contracts; no live database."""

# Load this route module directly: the One package initializer also imports
# unrelated model runtimes, which this owner-admission test does not exercise.
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location(
    "referral_routes_test", Path(__file__).resolve().parents[1] / "api/routes/one/referrals.py"
)
routes = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = routes
spec.loader.exec_module(routes)


@pytest.fixture
def app():
    application = FastAPI()
    application.include_router(routes.router)
    return application


@pytest.mark.parametrize("path", ["points", "challenge", "milestones", "policy"])
def test_dashboard_reads_require_auth_before_storage(app, monkeypatch, path):
    read = Mock(side_effect=AssertionError("unauthenticated storage access"))
    monkeypatch.setattr(routes, "get_balances", read)
    monkeypatch.setattr(routes, "get_active_program_settings", read)
    response = TestClient(app).get(f"/api/one/referrals/{path}")
    assert response.status_code == 401
    read.assert_not_called()


def test_referral_rotation_requires_auth_and_uses_only_the_verified_owner(app, monkeypatch):
    rotate = Mock(return_value={})
    summary = Mock(return_value={"slug": "new-link", "link_open_count": 0, "qualified_count": 3})
    monkeypatch.setattr(routes, "rotate_referral_code", rotate)
    monkeypatch.setattr(routes, "get_referral_summary", summary)
    client = TestClient(app)
    assert client.post("/api/one/referrals/rotate", json={"slug": "old-link"}).status_code == 401
    rotate.assert_not_called()
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    result = client.post(
        "/api/one/referrals/rotate?user_id=other-owner",
        json={"slug": "old-link", "user_id": "other-owner"},
    )
    assert result.status_code == 200
    assert result.json()["link_open_count"] == 0
    rotate.assert_called_once_with("verified-owner", expected_slug="old-link")
    summary.assert_called_once_with("verified-owner")


def test_referral_rotation_failure_does_not_claim_success(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    monkeypatch.setattr(
        routes, "rotate_referral_code", Mock(side_effect=RuntimeError("storage failure"))
    )
    read = Mock()
    monkeypatch.setattr(routes, "get_referral_summary", read)
    response = TestClient(app).post("/api/one/referrals/rotate", json={"slug": "old-link"})
    assert response.status_code == 500
    assert response.json() == {"detail": {"code": "REFERRAL_ROTATE_FAILED"}}
    read.assert_not_called()


def test_points_use_verified_owner_not_query_parameter(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    read = Mock(return_value={"points": 37, "coins": 20})
    monkeypatch.setattr(routes, "get_balances", read)
    response = TestClient(app).get("/api/one/referrals/points?user_id=other-owner")
    assert response.json() == {"points": 37, "coins": 20}
    read.assert_called_once_with("verified-owner")


def test_milestones_publish_active_catalogue_with_owner_progress(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    catalogue = [{"milestone_key": "current", "threshold": 42, "reward": "Current reward"}]
    monkeypatch.setattr(
        routes, "get_active_program_settings", lambda: SimpleNamespace(milestones=catalogue)
    )
    read = Mock(return_value={"lifetime_qualified_count": 2, "earned": [], "next_milestone": None})
    monkeypatch.setattr(routes, "get_milestone_progress", read)
    response = TestClient(app).get("/api/one/referrals/milestones")
    assert response.json()["available_milestones"] == catalogue
    assert response.json()["lifetime_qualified_count"] == 2
    read.assert_called_once_with("verified-owner", settings_milestones=catalogue)


def test_challenge_without_schedule_never_invents_a_deadline(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    monkeypatch.setattr(
        "hushh_mcp.services.one_referral_challenge_service.get_active_program_settings",
        lambda: SimpleNamespace(weekly_schedule={}),
    )
    response = TestClient(app).get("/api/one/referrals/challenge")
    assert response.json()["status"] == "not_configured"
    assert {
        k: response.json()[k] for k in ("active", "week_started_at", "cutoff_at", "timezone")
    } == {
        "active": False,
        "week_started_at": None,
        "cutoff_at": None,
        "timezone": None,
    }


def test_policy_reads_active_amounts_without_changing_settings(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    settings = SimpleNamespace(
        version=2,
        points={"qualified_referral_points": 123},
        streak_rules={"run_length_days": 3, "bonus_points": 17},
        weekly_schedule={
            "timezone": "Asia/Kolkata",
            "cutoff_day_of_week": 1,
            "cutoff_time": "00:00:00",
        },
        feature_active=False,
        flash_windows=[],
    )
    read = Mock(return_value=settings)
    monkeypatch.setattr(routes, "get_active_program_settings", read)
    response = TestClient(app).get("/api/one/referrals/policy")
    assert response.status_code == 200
    assert response.json()["points"] == settings.points
    assert response.json()["streak_rules"] == settings.streak_rules
    assert response.json()["challenge_duration_days"] == 7
    assert response.json()["weekly_prizes_enabled"] is False
    read.assert_called_once_with()


def test_slow_referral_storage_runs_off_the_async_event_loop(app, monkeypatch):
    import asyncio
    from threading import get_ident

    event_loop_thread = None

    async def owner():
        nonlocal event_loop_thread
        event_loop_thread = get_ident()
        return "verified-owner"

    def storage_read(_owner):
        # A synchronous database wait must execute in FastAPI's worker pool.
        assert get_ident() != event_loop_thread
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        return {"points": 37, "coins": 20}

    app.dependency_overrides[routes.require_firebase_auth] = owner
    monkeypatch.setattr(routes, "get_balances", storage_read)
    response = TestClient(app).get("/api/one/referrals/points")
    assert response.json() == {"points": 37, "coins": 20}


@pytest.mark.parametrize(
    "path,payload",
    [
        ("app-open", {}),
        ("activity", {"message_id": "11111111-1111-1111-1111-111111111111"}),
        ("rewards/claim", {"milestone_key": "voucher_10"}),
    ],
)
def test_mutations_require_auth_before_activity_or_claim_writes(app, monkeypatch, path, payload):
    write = Mock(side_effect=AssertionError("unauthenticated write"))
    for name in ("record_app_open", "reconcile_product_activity", "claim_milestone"):
        monkeypatch.setattr(routes, name, write)
    assert TestClient(app).post(f"/api/one/referrals/{path}", json=payload).status_code == 401
    write.assert_not_called()


def test_activity_rejects_client_awards_and_derives_its_owner(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    write = Mock(return_value={"verified_events": 0, "qualification": {"status": "not_referred"}})
    monkeypatch.setattr(routes, "reconcile_product_activity", write)
    client = TestClient(app)
    message = "11111111-1111-1111-1111-111111111111"
    assert (
        client.post(
            "/api/one/referrals/activity",
            json={"message_id": message, "points": 100, "user_id": "other"},
        ).status_code
        == 422
    )
    write.assert_not_called()
    assert (
        client.post(
            "/api/one/referrals/activity?user_id=other", json={"message_id": message}
        ).status_code
        == 200
    )
    write.assert_called_once_with("verified-owner", message)
