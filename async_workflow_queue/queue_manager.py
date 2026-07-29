from worker_engine import process_task
from task_scheduler import schedule_task


TASK_QUEUE = []


def add_task(task):

    TASK_QUEUE.append(task)

    scheduled_task = schedule_task(task)

    result = process_task(scheduled_task)

    return {
        "task_added": True,
        "task_result": result
    }