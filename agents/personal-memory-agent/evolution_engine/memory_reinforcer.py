def reinforce_memories(memories):

    reinforced = []

    for memory in memories:

        document = memory.get("document", "")

        reinforcement_score = len(document.split())

        reinforced.append(
            {
                "memory": document,
                "reinforcement_score": reinforcement_score
            }
        )

    return reinforced