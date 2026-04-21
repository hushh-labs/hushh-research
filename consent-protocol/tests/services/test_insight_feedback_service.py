from types import SimpleNamespace

import pytest

from hushh_mcp.services.insight_feedback_service import (
    InsightFeedbackDuplicateError,
    InsightFeedbackPersistenceError,
    InsightFeedbackService,
)


class _FakeDb:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = list(responses or [])

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params))
        if self.responses:
            return self.responses.pop(0)
        return SimpleNamespace(data=[], error=None)


def test_create_feedback_persists_payload(monkeypatch):
    fake_db = _FakeDb(
        [
            SimpleNamespace(data=[], error=None),
            SimpleNamespace(
                data=[
                    {
                        "feedback_id": "feedback-123",
                        "created_at": "2026-04-21T12:00:00Z",
                    }
                ],
                error=None,
            ),
            SimpleNamespace(
                data=[
                    {
                        "thumbs_up_count": 4,
                        "thumbs_down_count": 1,
                        "total_count": 5,
                    }
                ],
                error=None,
            ),
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.insight_feedback_service.get_db",
        lambda: fake_db,
    )

    service = InsightFeedbackService()
    result = service.create_feedback(
        user_id="user-123",
        stock="MSFT",
        insight="HOLD: Cloud growth remains durable.",
        confidence=0.69,
        rating="up",
    )

    assert result == {
        "success": True,
        "message": "Insight feedback recorded.",
        "aggregates": {
            "thumbs_up_count": 4,
            "thumbs_down_count": 1,
            "total_count": 5,
        },
    }
    assert len(fake_db.calls) == 3
    _, params = fake_db.calls[1]
    assert params == {
        "user_id": "user-123",
        "stock": "MSFT",
        "insight": "HOLD: Cloud growth remains durable.",
        "confidence": 0.69,
        "rating": "up",
    }


def test_create_feedback_rejects_recent_duplicate(monkeypatch):
    fake_db = _FakeDb(
        [
            SimpleNamespace(
                data=[{"feedback_id": "feedback-123", "created_at": "2026-04-21T12:00:00Z"}],
                error=None,
            )
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.insight_feedback_service.get_db",
        lambda: fake_db,
    )

    service = InsightFeedbackService()

    with pytest.raises(InsightFeedbackDuplicateError):
        service.create_feedback(
            user_id="user-123",
            stock="MSFT",
            insight="HOLD: Cloud growth remains durable.",
            confidence=0.69,
            rating="up",
        )


def test_get_feedback_aggregates_defaults_to_zero(monkeypatch):
    fake_db = _FakeDb([SimpleNamespace(data=[], error=None)])
    monkeypatch.setattr(
        "hushh_mcp.services.insight_feedback_service.get_db",
        lambda: fake_db,
    )

    service = InsightFeedbackService()
    aggregates = service.get_feedback_aggregates(stock="MSFT")

    assert aggregates == {
        "thumbs_up_count": 0,
        "thumbs_down_count": 0,
        "total_count": 0,
    }


def test_create_feedback_raises_on_insert_failure(monkeypatch):
    fake_db = _FakeDb(
        [
            SimpleNamespace(data=[], error=None),
            SimpleNamespace(data=[], error="boom"),
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.insight_feedback_service.get_db",
        lambda: fake_db,
    )

    service = InsightFeedbackService()

    with pytest.raises(InsightFeedbackPersistenceError):
        service.create_feedback(
            user_id="user-123",
            stock="MSFT",
            insight="HOLD: Cloud growth remains durable.",
            confidence=0.69,
            rating="up",
        )
