from pathlib import Path
import sys
import pytest


sys.path.append(str(Path(__file__).resolve().parents[2]))


def validate_runtime_flow(manifest):

    required_fields = [
        "agent_name",
        "runtime",
        "capabilities"
    ]

    for field in required_fields:
        if field not in manifest:
            raise ValueError(
                f"Missing field: {field}"
            )

    if not isinstance(
        manifest["capabilities"],
        list
    ):
        raise TypeError(
            "Capabilities must be a list"
        )

    return True


def test_valid_runtime_flow():

    manifest = {
        "agent_name": "memory-agent",
        "runtime": "python",
        "capabilities": [
            "memory-storage"
        ]
    }

    assert validate_runtime_flow(manifest)


def test_missing_runtime():

    manifest = {
        "agent_name": "memory-agent",
        "capabilities": [
            "memory-storage"
        ]
    }

    with pytest.raises(ValueError):
        validate_runtime_flow(manifest)


def test_invalid_capability_type():

    manifest = {
        "agent_name": "memory-agent",
        "runtime": "python",
        "capabilities": "memory-storage"
    }

    with pytest.raises(TypeError):
        validate_runtime_flow(manifest)