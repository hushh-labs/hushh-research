def validate_plugin_data(data):

    required_fields = [
        "plugin_name"
    ]

    for field in required_fields:

        if field not in data:
            return False

    return True