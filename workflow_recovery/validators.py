def validate_retry_task(data):

    required_fields = [
        "task",
        "attempt",
        "status"
    ]

    for field in required_fields:

        if field not in data:
            return False

    return True