def decay_memories(memories):

    decayed = []

    for memory in memories:

        document = memory.get("document", "")

        decay_score = max(
            1,
            100 - len(document.split())
        )

        decayed.append(
            {
                "memory": document,
                "decay_score": decay_score
            }
        )

    return decayed