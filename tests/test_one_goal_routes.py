"""One Goal product API contract tests."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import goal


def _client(*, authenticated: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(goal.router)
    if authenticated:
        app.dependency_overrides[goal.require_vault_owner_token] = lambda: {
            "user_id": "user_a",
            "scope": "VAULT_OWNER",
        }
    return TestClient(app)


def test_one_goal_plan_requires_vault_owner_token():
    response = _client().post(
        "/api/one/goal/plan",
        json={"transcript": "Analyze TSLA", "entrypoint": "voice"},
    )

    assert response.status_code in {401, 403}


def test_one_goal_plan_asks_for_missing_source():
    response = _client(authenticated=True).post(
        "/api/one/goal/plan",
        json={"transcript": "Analyze TSLA", "entrypoint": "voice"},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "input_needed"
    assert payload["goal_id"] == "goal.analysis.start_debate"
    assert payload["action_id"] == "analysis.start"
    assert payload["slots"]["symbol"] == "TSLA"
    assert payload["prompt"]["slot"] == "pickSource"


def test_one_goal_plan_default_source_is_ready():
    response = _client(authenticated=True).post(
        "/api/one/goal/plan",
        json={"transcript": "Analyze TSLA using default", "entrypoint": "chat"},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "ready"
    assert payload["goal_id"] == "goal.analysis.start_debate"
    assert payload["slots"]["symbol"] == "TSLA"
    assert payload["slots"]["pickSource"] == "default"


def test_one_goal_plan_resolves_company_name_to_symbol():
    response = _client(authenticated=True).post(
        "/api/one/goal/plan",
        json={"transcript": "analyzing nvidia using default", "entrypoint": "voice"},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "ready"
    assert payload["goal_id"] == "goal.analysis.start_debate"
    assert payload["action_id"] == "analysis.start"
    assert payload["slots"]["symbol"] == "NVDA"
    assert payload["slots"]["pickSource"] == "default"


def test_one_goal_plan_overrides_route_only_candidate_for_ticker_goal():
    response = _client(authenticated=True).post(
        "/api/one/goal/plan",
        json={
            "transcript": "Analyze TSLA using default",
            "candidate_action_id": "route.kai_analysis",
            "entrypoint": "voice",
        },
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "ready"
    assert payload["goal_id"] == "goal.analysis.start_debate"
    assert payload["action_id"] == "analysis.start"
    assert payload["slots"]["symbol"] == "TSLA"
    assert payload["slots"]["pickSource"] == "default"


def test_one_goal_compose_uses_result_text():
    response = _client(authenticated=True).post(
        "/api/one/goal/compose",
        json={
            "goal_id": "goal.analysis.start_debate",
            "action_id": "analysis.start",
            "state": "completed",
            "result": {"text": "Kai completed TSLA: HOLD."},
        },
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload == {
        "speech": "Kai completed TSLA: HOLD.",
        "card_title": "One Goal",
        "state": "completed",
    }
