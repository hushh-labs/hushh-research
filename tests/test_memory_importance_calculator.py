import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from importance_engine.memory_importance_calculator import (
    calculate_memory_importance,
    MemoryImportanceError,
)


def test_high_importance_memory():
    memory = {
        "content": "A" * 150,
        "interaction_count": 10,
        "emotional_weight": 9,
        "is_pinned": True,
    }

    score = calculate_memory_importance(memory)

    assert score == 1.0


def test_low_importance_memory():
    memory = {
        "content": "short",
        "interaction_count": 1,
        "emotional_weight": 1,
        "is_pinned": False,
    }

    score = calculate_memory_importance(memory)

    assert score == 0.0


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"content": 123},
    ],
)
def test_invalid_memory_payload(payload):
    with pytest.raises(MemoryImportanceError):
        calculate_memory_importance(payload)