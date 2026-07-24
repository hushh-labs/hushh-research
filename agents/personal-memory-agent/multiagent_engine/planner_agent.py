def planner_agent(memories):

    planning_tasks = []

    for memory in memories:

        document = memory.get("document", "").lower()

        if "ai" in document:

            planning_tasks.append(
                "Expand AI systems engineering workflow."
            )

        if "research" in document:

            planning_tasks.append(
                "Increase research-oriented planning cycles."
            )

    if not planning_tasks:

        planning_tasks.append(
            "General planning agent monitoring active."
        )

    return list(set(planning_tasks))