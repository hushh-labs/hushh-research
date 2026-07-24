def prioritize_tasks(tasks):

    prioritized = []

    for index, task in enumerate(tasks, start=1):

        prioritized.append(
            {
                "priority_rank": index,
                "task": task
            }
        )

    return prioritized