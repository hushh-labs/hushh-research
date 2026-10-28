"""Timeout receipts identify the failed boundary without replaying the source."""

import asyncio

import pytest

from hushh_mcp.hushh_adk.events import AdkEventTimeoutError, bounded_adk_events


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
