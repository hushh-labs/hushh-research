from typing import Dict, List


class MemoryOptimizationError(Exception):
    """Raised when memory optimization fails."""


class MemoryOptimizer:
    """
    Optimize PKM memory structures.
    """

    def remove_duplicate_memories(
        self,
        memories: List[Dict],
    ) -> List[Dict]:

        if not isinstance(memories, list):
            raise MemoryOptimizationError(
                "Memories must be provided as a list"
            )

        unique_memories = []
        seen_contents = set()

        for memory in memories:
            content = memory.get("content")

            if content not in seen_contents:
                unique_memories.append(memory)
                seen_contents.add(content)

        return unique_memories

    def calculate_optimization_score(
        self,
        original_count: int,
        optimized_count: int,
    ) -> float:

        if original_count <= 0:
            raise MemoryOptimizationError(
                "original_count must be greater than zero"
            )

        reduction_ratio = (
            original_count - optimized_count
        ) / original_count

        return round(reduction_ratio, 2)