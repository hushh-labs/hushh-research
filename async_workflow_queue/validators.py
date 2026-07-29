def validate_task_data(data):

    required_fields = [
        "task"
    ]

    for field in required_fields:

        if field not in data:
            return False

    return True