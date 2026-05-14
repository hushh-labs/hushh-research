from pathlib import Path
import sys
import pytest


sys.path.append(str(Path(__file__).resolve().parents[2]))

from tools.runtime_validation.manifest_runtime_validator import (
    validate_manifest
)


def test_valid_manifest():

    manifest = {
        "agent_name": "memory-agent",
        "version": "1.0",
        "runtime": "python",
        "capabilities": [
            "memory-storage"
        ]
    }

    assert validate_manifest(manifest)


def test_missing_runtime():

    manifest = {
        "agent_name": "memory-agent",
        "version": "1.0",
        "capabilities": [
            "memory-storage"
        ]
    }

    with pytest.raises(ValueError):
        validate_manifest(manifest)


def test_empty_capabilities():

    manifest = {
        "agent_name": "memory-agent",
        "version": "1.0",
        "runtime": "python",
        "capabilities": []
    }

    with pytest.raises(ValueError):
        validate_manifest(manifest)


def test_invalid_capabilities_type():

    manifest = {
        "agent_name": "memory-agent",
        "version": "1.0",
        "runtime": "python",
        "capabilities": "memory-storage"
    }

    with pytest.raises(TypeError):
        validate_manifest(manifest)