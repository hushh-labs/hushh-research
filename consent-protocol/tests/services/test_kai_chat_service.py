import asyncio
import logging

import pytest

from hushh_mcp.services.kai_chat_service import KaiChatService


class SlowAttributeLearner:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.completed = asyncio.Event()

    async def extract_and_store(
        self,
        *,
        user_id: str,
        user_message: str,
        assistant_response: str,
    ) -> list[dict]:
        self.started.set()
        await self.release.wait()
        self.completed.set()
        return []


class FailingAttributeLearner:
    async def extract_and_store(
        self,
        *,
        user_id: str,
        user_message: str,
        assistant_response: str,
    ) -> list[dict]:
        raise RuntimeError("attribute extraction failed")


@pytest.mark.asyncio
async def test_schedule_attribute_learning_does_not_block_response_path():
    service = KaiChatService()
    learner = SlowAttributeLearner()
    service._attribute_learner = learner

    service._schedule_attribute_learning(
        user_id="user-123",
        user_message="remember that I prefer index funds",
        assistant_response="Got it.",
    )

    await asyncio.wait_for(learner.started.wait(), timeout=1)
    assert not learner.completed.is_set()

    learner.release.set()
    await asyncio.wait_for(learner.completed.wait(), timeout=1)


@pytest.mark.asyncio
async def test_schedule_attribute_learning_logs_background_failure(caplog):
    service = KaiChatService()
    service._attribute_learner = FailingAttributeLearner()

    with caplog.at_level(logging.ERROR, logger="hushh_mcp.services.kai_chat_service"):
        service._schedule_attribute_learning(
            user_id="user-123",
            user_message="remember this",
            assistant_response="Saved.",
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    assert "kai_chat.attribute_learning_failed user_id=user-123" in caplog.text
    assert "attribute extraction failed" in caplog.text
