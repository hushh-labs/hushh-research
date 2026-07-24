def validate_policy_data(data):

    required_fields = [
        "trust_score",
        "consent_valid",
        "pii_detected"
    ]

    for field in required_fields:

        if field not in data:
            return False

    return True