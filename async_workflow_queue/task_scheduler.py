def schedule_task(task):

    return {
        "task": task["task"],
        "priority": task.get("priority", "normal")
    }