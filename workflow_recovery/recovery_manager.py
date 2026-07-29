def recover_workflow(task):

    if task.get("status") == "failed":

        return {
            "retry_scheduled": True,
            "recovery_action": "workflow_restart"
        }

    return {
        "retry_scheduled": False
    }