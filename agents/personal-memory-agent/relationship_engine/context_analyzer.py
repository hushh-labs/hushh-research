def analyze_context(memories):

    context_results = []

    for memory in memories:

        document = memory.get("document", "").lower()

        if "research" in document:

            context_results.append(
                "Research context strongly appears across memory activity."
            )

        if "analytics" in document:

            context_results.append(
                "Analytical context relationships are frequently connected."
            )

        if "learning" in document:

            context_results.append(
                "Learning-oriented contextual relationships are growing."
            )

    if not context_results:

        context_results.append(
            "Contextual memory patterns are still emerging."
        )

    return list(set(context_results))