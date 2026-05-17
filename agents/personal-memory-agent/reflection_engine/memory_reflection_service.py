from typing import Dict, List


class MemoryReflectionError(Exception):
    """Raised when memory reflection fails."""


class MemoryReflectionService:
    """
    Generate reflection summaries for PKM memories.
    """

    def generate_reflection(
        self,
        memories: List[Dict],
    ) -> Dict:

        if not isinstance(memories, list):
            raise MemoryReflectionError(
                "Memories must be provided as a list"
            )

        total_memories = len(memories)

        important_memories = sum(
            1
            for memory in memories
            if memory.get("importance_score", 0) > 0.7
        )

        linked_memories = sum(
            1
            for memory in memories
            if memory.get("related_memories")
        )

        return {
            "total_memories": total_memories,
            "important_memories": important_memories,
            "linked_memories": linked_memories,
            "reflection_summary": (
                f"{important_memories} important "
                f"memories identified with "
                f"{linked_memories} linked memories."
            ),
        }