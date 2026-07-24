def analyze_confidence(memories):

    confidence_results = []

    for memory in memories:

        document = memory.get("document", "")

        confidence_score = min(
            100,
            len(document.split()) * 5
        )

        confidence_results.append(
            {
                "memory": document,
                "confidence_score": confidence_score
            }
        )

    return confidence_results