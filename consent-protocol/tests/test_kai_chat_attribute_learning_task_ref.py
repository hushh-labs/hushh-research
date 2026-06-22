"""Tests for background attribute learning task reference retention.

KaiChatService._schedule_attribute_learning starts attribute extraction with
asyncio.create_task. asyncio keeps only a weak reference to such tasks, so
without an external strong reference the task can be garbage collected before
it finishes, silently dropping the attributes learned from a chat turn.

The fix retains the task in the module-level _attribute_learning_tasks set
until its done callback removes it. These tests drive the real method on the
real service singleton and assert:

1. Scheduling registers a strong reference while the task runs.
2. The scheduled extraction actually runs to completion.
3. The reference is removed after completion so the set does not leak.
4. Scheduling outside a running event loop is handled without raising.

Reachable from api/routes/kai/chat.py POST /chat, which calls
KaiChatService.process_message, which schedules attribute learning.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services import kai_chat_service as chat_module
from hushh_mcp.services.kai_chat_service import get_kai_chat_service


class _FakeAttributeLearner:
    def __init__(self):
        self.calls: list[dict] = []
        self.started = asyncio.Event()
        self.finished = asyncio.Event()

    async def extract_and_store(self, *, user_id, user_message, assistant_response):
        self.started.set()
        await asyncio.sleep(0)
        self.calls.append(
            {
                "user_id": user_id,
                "user_message": user_message,
                "assistant_response": assistant_response,
            }
        )
        self.finished.set()


@pytest.mark.asyncio
async def test_schedule_attribute_learning_retains_then_releases_task():
    service = get_kai_chat_service()
    fake = _FakeAttributeLearner()
    service._attribute_learner = fake

    chat_module._attribute_learning_tasks.clear()
    service._schedule_attribute_learning(
        user_id="user_1",
        user_message="hi",
        assistant_response="hello",
    )

    assert len(chat_module._attribute_learning_tasks) == 1
    tracked_task = next(iter(chat_module._attribute_learning_tasks))

    await asyncio.wait_for(fake.started.wait(), timeout=1.0)
    await asyncio.wait_for(tracked_task, timeout=1.0)

    assert fake.finished.is_set()
    assert fake.calls == [
        {"user_id": "user_1", "user_message": "hi", "assistant_response": "hello"}
    ]
    assert tracked_task not in chat_module._attribute_learning_tasks


@pytest.mark.asyncio
async def test_schedule_attribute_learning_runs_extraction_to_completion():
    service = get_kai_chat_service()
    fake = _FakeAttributeLearner()
    service._attribute_learner = fake

    chat_module._attribute_learning_tasks.clear()
    service._schedule_attribute_learning(
        user_id="user_2",
        user_message="track this",
        assistant_response="noted",
    )

    await asyncio.gather(*list(chat_module._attribute_learning_tasks))

    assert [call["user_id"] for call in fake.calls] == ["user_2"]
    assert len(chat_module._attribute_learning_tasks) == 0


def test_schedule_attribute_learning_without_event_loop_does_not_raise():
    service = get_kai_chat_service()
    service._attribute_learner = _FakeAttributeLearner()
    chat_module._attribute_learning_tasks.clear()

    service._schedule_attribute_learning(
        user_id="user_3",
        user_message="x",
        assistant_response="y",
    )

    assert len(chat_module._attribute_learning_tasks) == 0
