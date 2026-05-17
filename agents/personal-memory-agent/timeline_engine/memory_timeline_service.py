from datetime import datetime
from typing import Dict, List


class MemoryTimelineError(Exception):
    """Raised when timeline processing fails."""


class MemoryTimelineService:
    """
    Organize memories chronologically.
    """

    def sort_memories_by_timestamp(
        self,
        memories: List[Dict],
    ) -> List[Dict]:

        if not isinstance(memories, list):
            raise MemoryTimelineError(
                "Memories must be provided as a list"
            )

        try:
            return sorted(
                memories,
                key=lambda memory: datetime.fromisoformat(
                    memory["timestamp"]
                ),
            )
        except Exception as error:
            raise MemoryTimelineError(
                "Invalid timestamp structure"
            ) from error

    def validate_timeline_order(
        self,
        memories: List[Dict],
    ) -> bool:

        sorted_memories = (
            self.sort_memories_by_timestamp(
                memories
            )
        )

        return memories == sorted_memories