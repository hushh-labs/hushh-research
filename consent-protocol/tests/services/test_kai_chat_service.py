import asyncio
import logging

import pytest

from hushh_mcp.services.kai_chat_service import (
    MIN_RESPONSE_CHARS,
    SAFE_FALLBACK_RESPONSE,
    KaiChatService,
)


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


@pytest.mark.parametrize(
    ("response_text", "reason"),
    [
        ("", "empty"),
        ("too short", "too_short"),
        (
            "I'm having trouble generating a response right now. Please try again.",
            "generic_fallback",
        ),
        ("User: this includes a role label and should not be stored", "malformed_structure"),
        ("This response leaked {user_context} from the prompt template.", "malformed_structure"),
    ],
)
def test_validate_response_rejects_unsafe_model_output(response_text, reason):
    service = KaiChatService()

    result = service.validate_response(response_text)

    assert result.is_valid is False
    assert result.reason == reason


def test_validate_response_accepts_specific_complete_output():
    service = KaiChatService()
    response_text = "I only have insufficient data, but I can help you import a portfolio first."

    result = service.validate_response(response_text)

    assert result.is_valid is True
    assert result.text == response_text
    assert len(result.text) >= MIN_RESPONSE_CHARS


@pytest.mark.asyncio
async def test_generate_validated_response_retries_once_and_returns_valid_output():
    service = KaiChatService()
    calls: list[dict] = []

    async def fake_generate_response(
        system_prompt: str,
        user_message: str,
        *,
        stricter: bool = False,
        previous_response: str | None = None,
    ) -> tuple[str, int]:
        calls.append({"stricter": stricter, "previous_response": previous_response})
        if len(calls) == 1:
            return "Kai: bad", 10
        return "I only have insufficient data, but I can help you import a portfolio first.", 20

    service._generate_response = fake_generate_response

    response_text, tokens, is_valid = await service._generate_validated_response(
        "system",
        "what should I do?",
    )

    assert is_valid is True
    assert tokens == 20
    assert (
        response_text
        == "I only have insufficient data, but I can help you import a portfolio first."
    )
    assert calls == [
        {"stricter": False, "previous_response": None},
        {"stricter": True, "previous_response": "Kai: bad"},
    ]


@pytest.mark.asyncio
async def test_generate_validated_response_returns_safe_fallback_after_retry_failure():
    service = KaiChatService()
    calls: list[dict] = []

    async def fake_generate_response(
        system_prompt: str,
        user_message: str,
        *,
        stricter: bool = False,
        previous_response: str | None = None,
    ) -> tuple[str, int]:
        calls.append({"stricter": stricter, "previous_response": previous_response})
        return "User: malformed model output", 10

    service._generate_response = fake_generate_response

    response_text, tokens, is_valid = await service._generate_validated_response(
        "system",
        "what should I do?",
    )

    assert response_text == SAFE_FALLBACK_RESPONSE
    assert tokens is None
    assert is_valid is False
    assert len(calls) == 2
