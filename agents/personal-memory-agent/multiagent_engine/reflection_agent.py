def reflection_agent(memories):

    reflection_results = []

    for memory in memories:

        document = memory.get("document", "").lower()

        if "analysis" in document:

            reflection_results.append(
                "Reflective analysis patterns remain strong."
            )

        if "learning" in document:

            reflection_results.append(
                "Learning-oriented reflection cycles increasing."
            )

    if not reflection_results:

        reflection_results.append(
            "Reflection agent observing behavioral patterns."
        )

    return list(set(reflection_results))