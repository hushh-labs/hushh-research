import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from timeline_engine.memory_timeline_service import (
    MemoryTimelineService,
    MemoryTimelineError,
)


def test_memory_timeline_sorting():
    service = MemoryTimelineService()

    memories = [
        {
            "timestamp": "2026-05-20T10:00:00"
        },
        {
            "timestamp": "2026-05-18T10:00:00"
        },
    ]

    sorted_memories = (
        service.sort_memories_by_timestamp(
            memories
        )
    )

    assert (
        sorted_memories[0]["timestamp"]
        == "2026-05-18T10:00:00"
    )


def test_timeline_validation():
    service = MemoryTimelineService()

    ordered_memories = [
        {
            "timestamp": "2026-05-18T10:00:00"
        },
        {
            "timestamp": "2026-05-20T10:00:00"
        },
    ]

    assert (
        service.validate_timeline_order(
            ordered_memories
        )
        is True
    )


def test_invalid_timestamp_handling():
    service = MemoryTimelineService()

    with pytest.raises(
        MemoryTimelineError
    ):
        service.sort_memories_by_timestamp(
            [
                {
                    "timestamp": "invalid"
                }
            ]
        )