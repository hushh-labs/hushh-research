def generate_tasks(goal):

    tasks = []

    goal_text = goal.get("goal", "").lower()

    if "ai" in goal_text:

        tasks.extend(
            [
                "Study semantic retrieval systems",
                "Build memory intelligence modules",
                "Analyze autonomous agent architectures"
            ]
        )

    if "research" in goal_text:

        tasks.extend(
            [
                "Read AI research papers",
                "Summarize technical findings",
                "Track experimental progress"
            ]
        )

    if not tasks:

        tasks.extend(
            [
                "Break goal into smaller milestones",
                "Track progress regularly",
                "Review completed activities"
            ]
        )

    return tasks