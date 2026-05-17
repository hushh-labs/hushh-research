import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from reflection_engine.memory_reflection_service import (
    MemoryReflectionService,
    MemoryReflectionError,
)


def test_memory_reflection_summary():
    service = MemoryReflectionService()

    memories = [
        {
            "importance_score": 0.9,
            "related_memories": ["m2"],
        },
        {
            "importance_score": 0.2,
            "related_memories": [],
        },
    ]

    reflection = service.generate_reflection(
        memories
    )

    assert (
        reflection["important_memories"] == 1
    )

    assert (
        reflection["linked_memories"] == 1
    )


def test_empty_memory_reflection():
    service = MemoryReflectionService()

    reflection = service.generate_reflection([])

    assert (
        reflection["total_memories"] == 0
    )


def test_invalid_reflection_payload():
    service = MemoryReflectionService()

    with pytest.raises(
        MemoryReflectionError
    ):
        service.generate_reflection(
            "invalid_payload"
        )