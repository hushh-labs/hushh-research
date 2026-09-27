"""The in-app "Report response" control on an Agent One answer.

A report must reach somewhere the team can review (a durable "down" row plus a
structured log record), must carry no message content, and must reject any
reason outside the bounded enum.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from hushh_mcp.services import message_feedback_service as feedback


class _Conn:
    def __init__(self, calls: list[tuple[str, tuple[Any, ...]]]) -> None:
        self._calls = calls

    async def execute(self, query: str, *args: Any) -> str:
        self._calls.append((query, args))
        return "INSERT 0 1"


class _Acquire:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _Conn:
        return self._conn

    async def __aexit__(self, *_exc: object) -> bool:
        return False


class _Pool:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def acquire(self) -> _Acquire:
        return _Acquire(_Conn(self.calls))


@pytest.fixture
def pool(monkeypatch: pytest.MonkeyPatch) -> _Pool:
    fake = _Pool()

    async def _get_pool() -> _Pool:
        return fake

    monkeypatch.setattr(feedback, "get_pool", _get_pool)
    return fake


async def test_report_stores_a_down_rating_and_logs_a_reviewable_record(
    pool: _Pool, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=feedback.logger.name):
        result = await feedback.set_feedback(
            user_id="owner-1",
            conversation_ref="conv-1",
            message_ref="msg-1",
            rating=None,
            report_reason="offensive",
        )

    assert result == {
        "conversation_id": "conv-1",
        "message_id": "msg-1",
        "rating": "down",
        "reported": True,
        "report_reason": "offensive",
    }
    ((query, args),) = pool.calls
    assert "INSERT INTO one_agent_message_feedback" in query
    assert args == ("owner-1", "hussh_one", "conv-1", "msg-1", "down")
    record = next(r for r in caplog.records if "one_agent_response_reported" in r.getMessage())
    assert "reason=offensive" in record.getMessage()
    assert "conversation=conv-1" in record.getMessage()
    assert "message=msg-1" in record.getMessage()


async def test_report_overrides_a_positive_rating(pool: _Pool) -> None:
    result = await feedback.set_feedback(
        user_id="owner-1",
        conversation_ref="conv-1",
        message_ref="msg-1",
        rating="up",
        report_reason="inaccurate",
    )
    assert result["rating"] == "down"
    assert pool.calls[0][1][-1] == "down"


async def test_unknown_report_reason_is_rejected_before_any_write(pool: _Pool) -> None:
    with pytest.raises(feedback.MessageFeedbackError) as exc:
        await feedback.set_feedback(
            user_id="owner-1",
            conversation_ref="conv-1",
            message_ref="msg-1",
            rating=None,
            report_reason="the answer said something awful about me",
        )
    assert exc.value.code == "REPORT_REASON_INVALID"
    assert pool.calls == []


async def test_plain_rating_is_unchanged_and_not_reported(
    pool: _Pool, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=feedback.logger.name):
        result = await feedback.set_feedback(
            user_id="owner-1",
            conversation_ref="conv-1",
            message_ref="msg-1",
            rating="down",
        )
    assert result == {"conversation_id": "conv-1", "message_id": "msg-1", "rating": "down"}
    assert not any("one_agent_response_reported" in r.getMessage() for r in caplog.records)


def test_report_reasons_are_a_closed_enum_shared_with_the_route() -> None:
    from api.routes.one.agent_feedback import MessageFeedbackRequest

    route_reasons = MessageFeedbackRequest.model_fields["report_reason"].annotation
    assert set(feedback.VALID_REPORT_REASONS) == {"offensive", "harmful", "inaccurate", "other"}
    assert all(reason in str(route_reasons) for reason in feedback.VALID_REPORT_REASONS)
