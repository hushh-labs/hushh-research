"""Hedged retry contract for the shared specialist model call.

agent_chat_model_call gives each attempt a short deadline and retries inside
a total budget, so a single stalled generate_content request cannot consume
the whole specialist turn (tail-at-scale guard).
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from hushh_mcp.operons.kai import llm as _llm


class _FakeModels:
    def __init__(self, behaviors):
        # behaviors: list of "hang" or a value to return
        self._behaviors = list(behaviors)
        self.calls = 0

    async def generate_content(self, *, model, contents, config):
        self.calls += 1
        behavior = self._behaviors.pop(0)
        if behavior == "hang":
            await asyncio.sleep(3600)
        return behavior


class _FakeClient:
    def __init__(self, behaviors):
        self.aio = type("A", (), {})()
        self.aio.models = _FakeModels(behaviors)


def _patched(client):
    return patch.multiple(
        _llm,
        _gemini_client=client,
        _gemini_model_name="test-model",
        GEMINI_AVAILABLE=True,
    )


@pytest.mark.asyncio
async def test_returns_first_success_without_retry():
    client = _FakeClient(["ok-response"])
    with _patched(client):
        out = await _llm.agent_chat_model_call(
            "hi", None, attempt_timeout_s=0.5, total_timeout_s=2.0
        )
    assert out == "ok-response"
    assert client.aio.models.calls == 1


@pytest.mark.asyncio
async def test_stalled_attempt_is_retried_and_succeeds():
    client = _FakeClient(["hang", "recovered"])
    with _patched(client):
        out = await _llm.agent_chat_model_call(
            "hi", None, attempt_timeout_s=0.2, total_timeout_s=5.0
        )
    assert out == "recovered"
    assert client.aio.models.calls == 2


@pytest.mark.asyncio
async def test_total_budget_exhaustion_raises_timeout():
    client = _FakeClient(["hang", "hang", "hang", "hang", "hang"])
    with _patched(client):
        with pytest.raises(asyncio.TimeoutError):
            await _llm.agent_chat_model_call("hi", None, attempt_timeout_s=0.2, total_timeout_s=0.7)
    # Budget of 0.7s with 0.2s attempts allows a bounded number of tries.
    assert 2 <= client.aio.models.calls <= 5
