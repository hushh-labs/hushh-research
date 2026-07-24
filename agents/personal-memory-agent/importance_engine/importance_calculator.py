def calculate_importance(memories):

    scored_memories = []

    for memory in memories:

        document = memory.get("document", "")

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        score = len(document.split())

        if category == "research":
            score += 5

        if category == "analytics":
            score += 3

        scored_memories.append(
            {
                "memory": document,
                "category": category,
                "importance_score": score
            }
        )

    return scored_memories