def link_memories(memories):

    linked_memories = []

    for memory in memories:

        document = memory.get("document", "")

        metadata = memory.get("metadata", {})

        category = metadata.get("category", "unknown")

        linked_memories.append(
            {
                "memory": document,
                "linked_category": category
            }
        )

    return linked_memories