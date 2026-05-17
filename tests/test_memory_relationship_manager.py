import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from relationship_engine.memory_relationship_manager import (
    MemoryRelationshipManager,
    MemoryRelationshipError,
)


def test_memory_relationship_creation():
    manager = MemoryRelationshipManager()

    manager.link_memories(
        "memory_1",
        "memory_2",
    )

    related = manager.get_related_memories(
        "memory_1"
    )

    assert "memory_2" in related


def test_bidirectional_relationship():
    manager = MemoryRelationshipManager()

    manager.link_memories(
        "memory_A",
        "memory_B",
    )

    assert manager.validate_relationship_exists(
        "memory_A",
        "memory_B",
    )

    assert manager.validate_relationship_exists(
        "memory_B",
        "memory_A",
    )


def test_self_reference_rejection():
    manager = MemoryRelationshipManager()

    with pytest.raises(
        MemoryRelationshipError
    ):
        manager.link_memories(
            "memory_1",
            "memory_1",
        )