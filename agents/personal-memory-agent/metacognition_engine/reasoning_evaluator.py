def evaluate_reasoning(memories):

    reasoning_results = []

    for memory in memories:

        document = memory.get("document", "").lower()

        reasoning_quality = "moderate"

        if "analysis" in document:
            reasoning_quality = "high"

        if "error" in document:
            reasoning_quality = "low"

        reasoning_results.append(
            {
                "memory": document,
                "reasoning_quality": reasoning_quality
            }
        )

    return reasoning_results