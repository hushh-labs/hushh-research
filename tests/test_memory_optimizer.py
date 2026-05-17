import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from optimization_engine.memory_optimizer import (
    MemoryOptimizer,
    MemoryOptimizationError,
)


def test_duplicate_memory_removal():
    optimizer = MemoryOptimizer()

    memories = [
        {"content": "memory_a"},
        {"content": "memory_a"},
        {"content": "memory_b"},
    ]

    optimized = (
        optimizer.remove_duplicate_memories(
            memories
        )
    )

    assert len(optimized) == 2


def test_optimization_score():
    optimizer = MemoryOptimizer()

    score = (
        optimizer.calculate_optimization_score(
            10,
            7,
        )
    )

    assert score == 0.3


def test_invalid_optimization_input():
    optimizer = MemoryOptimizer()

    with pytest.raises(
        MemoryOptimizationError
    ):
        optimizer.calculate_optimization_score(
            0,
            0,
        )