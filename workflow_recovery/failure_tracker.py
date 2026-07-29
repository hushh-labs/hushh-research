def track_failure(task):

    return {
        "task": task.get("task"),
        "status": "failure_logged"
    }