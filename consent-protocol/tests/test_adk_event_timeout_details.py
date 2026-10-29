"""Timeout receipts identify the failed boundary without replaying the source."""

import asyncio

import pytest

from hushh_mcp.hushh_adk.events import AdkEventTimeoutError, bounded_adk_events
from hushh_mcp.one_adk import text_runtime


@pytest.mark.parametrize("phase", ["first_event", "between_events", "total"])
async def test_timeout_details_preserve_deadlines_and_close_the_source(phase, caplog):
    closed = []

    async def source():
        try:
            if phase == "between_events":
                yield object()
            await asyncio.sleep(1)
        finally:
            closed.append(True)

    with pytest.raises(AdkEventTimeoutError) as failure:
        async for _ in bounded_adk_events(
            source(),
            first_event_timeout_s=0.1 if phase == "total" else 0.01,
            between_event_timeout_s=0.01,
            total_timeout_s=0.01 if phase == "total" else 0.1,
        ):
            pass
    assert failure.value.phase == phase
    assert failure.value.event_count == (1 if phase == "between_events" else 0)
    assert failure.value.elapsed_seconds >= 0.01
    assert closed == [True]
    assert f"adk_event_source.deadline phase={phase}" in caplog.text


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_first_event(monkeypatch):
    async def stalled():
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_FIRST_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    with pytest.raises(asyncio.TimeoutError):
        async for _ in text_runtime._bounded_adk_events(stalled()):
            pass


@pytest.mark.asyncio
async def test_bounded_adk_events_accepts_provider_first_event_budget():
    async def delayed():
        await asyncio.sleep(0.01)
        yield "ready"

    observed = [
        event
        async for event in text_runtime._bounded_adk_events(delayed(), first_event_timeout=0.05)
    ]

    assert observed == ["ready"]


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_followup(monkeypatch):
    first = object()

    async def stalled():
        yield first
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_BETWEEN_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    observed = []
    with pytest.raises(asyncio.TimeoutError):
        async for event in text_runtime._bounded_adk_events(stalled()):
            observed.append(event)

    assert observed == [first]
