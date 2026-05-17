from typing import Dict, List


class PKMOrchestrator:
    """
    Unified orchestration pipeline
    for PKM memory processing.
    """

    def validate_memory(
        self,
        memory: Dict,
    ) -> bool:

        required_fields = {
            "memory_id",
            "vault_id",
            "content",
            "timestamp",
        }

        return required_fields.issubset(
            memory.keys()
        )

    def calculate_importance(
        self,
        memory: Dict,
    ) -> float:

        score = 0.0

        if len(memory.get("content", "")) > 50:
            score += 0.5

        if memory.get(
            "interaction_count",
            0,
        ) > 5:
            score += 0.5

        return round(score, 2)

    def optimize_memories(
        self,
        memories: List[Dict],
    ) -> List[Dict]:

        unique_memories = []
        seen_content = set()

        for memory in memories:
            content = memory.get("content")

            if content not in seen_content:
                unique_memories.append(memory)
                seen_content.add(content)

        return unique_memories

    def process_memories(
        self,
        memories: List[Dict],
    ) -> Dict:

        validated_memories = []

        for memory in memories:

            if self.validate_memory(memory):

                memory[
                    "importance_score"
                ] = (
                    self.calculate_importance(
                        memory
                    )
                )

                validated_memories.append(
                    memory
                )

        optimized_memories = (
            self.optimize_memories(
                validated_memories
            )
        )

        ordered_memories = sorted(
            optimized_memories,
            key=lambda memory:
            memory["timestamp"],
        )

        return {
            "processed_memories":
                ordered_memories,
            "total_processed":
                len(ordered_memories),
        }