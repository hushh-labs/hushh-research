def validate_simulation_data(data):

    required_fields = [
        "trust_score",
        "consent_active"
    ]

    for field in required_fields:

        if field not in data:
            return False

    return True