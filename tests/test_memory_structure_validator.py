import pytest

import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from validation_utils.memory_structure_validator import (
    validate_memory_structure,
    MemoryValidationError,
)


def test_valid_memory_structure():
    memory = {
        "memory_id": "mem_001",
        "vault_id": "vault_001",
        "content": "User preference memory",
        "timestamp": "2026-05-16T10:00:00Z",
    }

    assert validate_memory_structure(memory) is True


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"memory_id": "123"},
        {"content": 123},
    ],
)
def test_invalid_memory_structure(payload):
    with pytest.raises(MemoryValidationError):
        validate_memory_structure(payload)