def generate_reflections(memories):

    reflections = []

    for memory in memories:

        document = memory.get("document", "")

        if "AI" in document or "agent" in document:

            reflections.append(
                "You are strongly focused on AI system development."
            )

        if "research" in document:

            reflections.append(
                "Research-oriented activities appear frequently in memory logs."
            )

        if "analytics" in document:

            reflections.append(
                "Behavioral analytics tasks are consistently recurring."
            )

    if not reflections:

        reflections.append(
            "Memory activity patterns are still evolving."
        )

    return list(set(reflections))