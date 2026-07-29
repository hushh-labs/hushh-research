from recovery_manager import recover_workflow
from failure_tracker import track_failure


def retry_failed_task(task):

    tracked = track_failure(task)

    recovery = recover_workflow(task)

    return {
        "failure_tracked": tracked,
        "recovery_status": recovery,
        "next_attempt": task.get("attempt", 1) + 1
    }