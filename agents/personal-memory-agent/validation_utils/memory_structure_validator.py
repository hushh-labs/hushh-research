from typing import Dict, Any


REQUIRED_MEMORY_FIELDS = {
    "memory_id",
    "vault_id",
    "content",
    "timestamp",
}


class MemoryValidationError(Exception):
    """Raised when memory validation fails."""


def validate_memory_structure(memory: Dict[str, Any]) -> bool:
    """
    Validate canonical PKM memory structure.
    """

    if not isinstance(memory, dict):
        raise MemoryValidationError(
            "Memory payload must be a dictionary"
        )

    missing_fields = REQUIRED_MEMORY_FIELDS - set(memory.keys())

    if missing_fields:
        raise MemoryValidationError(
            f"Missing required memory fields: "
            f"{sorted(missing_fields)}"
        )

    if not memory.get("memory_id"):
        raise MemoryValidationError(
            "memory_id cannot be empty"
        )

    if not memory.get("vault_id"):
        raise MemoryValidationError(
            "vault_id cannot be empty"
        )

    if not isinstance(memory.get("content"), str):
        raise MemoryValidationError(
            "content must be a string"
        )

    return True