from typing import Dict, List, Set


class MemoryRelationshipError(Exception):
    """Raised when relationship validation fails."""


class MemoryRelationshipManager:
    """
    Manage semantic relationships between memories.
    """

    def __init__(self):
        self.relationships: Dict[str, Set[str]] = {}

    def link_memories(
        self,
        memory_id: str,
        related_memory_id: str,
    ) -> None:

        if memory_id == related_memory_id:
            raise MemoryRelationshipError(
                "Memory cannot reference itself"
            )

        self.relationships.setdefault(
            memory_id,
            set(),
        ).add(related_memory_id)

        self.relationships.setdefault(
            related_memory_id,
            set(),
        ).add(memory_id)

    def get_related_memories(
        self,
        memory_id: str,
    ) -> List[str]:

        return sorted(
            self.relationships.get(memory_id, set())
        )

    def validate_relationship_exists(
        self,
        memory_id: str,
        related_memory_id: str,
    ) -> bool:

        return (
            related_memory_id
            in self.relationships.get(
                memory_id,
                set(),
            )
        )