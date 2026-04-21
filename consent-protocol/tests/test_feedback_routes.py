from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import feedback
from api.routes.feedback import router


class _FakeService:
    def __init__(self, result=None, error=None):
        self.result = result or {
            "success": True,
            "message": "Insight feedback recorded.",
            "aggregates": {
                "thumbs_up_count": 2,
                "thumbs_down_count": 1,
                "total_count": 3,
            },
        }
        self.error = error
        self.calls = []

    def create_feedback(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[feedback.require_firebase_auth] = lambda: "user-123"
    return app


def test_submit_insight_feedback_success(monkeypatch):
    fake_service = _FakeService()
    monkeypatch.setattr(
        "api.routes.feedback.get_insight_feedback_service",
        lambda: fake_service,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/feedback",
        json={
            "stock": "msft",
            "insight": "HOLD: Cloud growth remains durable.",
            "confidence": 69,
            "rating": "up",
        },
    )

    assert response.status_code == 201
    assert response.json() == {
        "success": True,
        "message": "Insight feedback recorded.",
        "aggregates": {
            "thumbs_up_count": 2,
            "thumbs_down_count": 1,
            "total_count": 3,
        },
    }
    assert fake_service.calls[0]["stock"] == "MSFT"


def test_submit_insight_feedback_invalid_rating():
    client = TestClient(_build_app())
    response = client.post(
        "/api/feedback",
        json={
            "stock": "MSFT",
            "insight": "HOLD: Cloud growth remains durable.",
            "confidence": 0.69,
            "rating": "maybe",
        },
    )

    assert response.status_code == 422


def test_submit_insight_feedback_missing_stock():
    client = TestClient(_build_app())
    response = client.post(
        "/api/feedback",
        json={
            "insight": "HOLD: Cloud growth remains durable.",
            "confidence": 0.69,
            "rating": "up",
        },
    )

    assert response.status_code == 422


def test_submit_insight_feedback_duplicate_submission(monkeypatch):
    fake_service = _FakeService(error=feedback.InsightFeedbackDuplicateError("duplicate"))
    monkeypatch.setattr(
        "api.routes.feedback.get_insight_feedback_service",
        lambda: fake_service,
    )

    client = TestClient(_build_app())
    response = client.post(
        "/api/feedback",
        json={
            "stock": "MSFT",
            "insight": "HOLD: Cloud growth remains durable.",
            "confidence": 0.69,
            "rating": "up",
        },
    )

    assert response.status_code == 409