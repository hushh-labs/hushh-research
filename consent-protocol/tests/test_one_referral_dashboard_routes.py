"""Referral dashboard wire and owner-admission contracts; no live database."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import referrals as routes


@pytest.fixture
def app():
    application = FastAPI()
    application.include_router(routes.router)
    return application


@pytest.mark.parametrize("path", ["points", "challenge", "milestones", "policy"])
def test_dashboard_reads_require_auth_before_storage(app, monkeypatch, path):
    read = Mock(side_effect=AssertionError("unauthenticated storage access"))
    monkeypatch.setattr(routes, "get_cumulative_score", read)
    monkeypatch.setattr(routes, "get_active_program_settings", read)
    response = TestClient(app).get(f"/api/one/referrals/{path}")
    assert response.status_code == 401
    read.assert_not_called()


def test_points_use_verified_owner_not_query_parameter(app, monkeypatch):
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "verified-owner"
    read = Mock(return_value=37)
    monkeypatch.setattr(routes, "get_cumulative_score", read)
    response = TestClient(app).get("/api/one/referrals/points?user_id=other-owner")
    assert response.json() == {"points": 37}
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
        routes, "get_active_program_settings", lambda: SimpleNamespace(weekly_schedule={})
    )
    response = TestClient(app).get("/api/one/referrals/challenge")
    assert response.json() == {
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
        return 37

    app.dependency_overrides[routes.require_firebase_auth] = owner
    monkeypatch.setattr(routes, "get_cumulative_score", storage_read)
    response = TestClient(app).get("/api/one/referrals/points")
    assert response.json() == {"points": 37}
