from typing import Dict, Any


class MemoryImportanceError(Exception):
    """Raised when memory importance scoring fails."""


def calculate_memory_importance(
    memory: Dict[str, Any]
) -> float:
    """
    Calculate importance score for a PKM memory.
    """

    if not isinstance(memory, dict):
        raise MemoryImportanceError(
            "Memory must be a dictionary"
        )

    score = 0.0

    content = memory.get("content", "")
    interaction_count = memory.get(
        "interaction_count",
        0,
    )
    emotional_weight = memory.get(
        "emotional_weight",
        0,
    )
    is_pinned = memory.get("is_pinned", False)

    if not isinstance(content, str):
        raise MemoryImportanceError(
            "content must be a string"
        )

    if len(content) > 100:
        score += 0.25

    if interaction_count > 5:
        score += 0.30

    if emotional_weight > 7:
        score += 0.30

    if is_pinned:
        score += 0.15

    return round(min(score, 1.0), 2)