def validate_manifest(manifest):
    required_fields = [
        "agent_name",
        "version",
        "runtime",
        "capabilities"
    ]

    for field in required_fields:
        if field not in manifest:
            raise ValueError(
                f"Missing required field: {field}"
            )

    if not isinstance(
        manifest["capabilities"],
        list
    ):
        raise TypeError(
            "Capabilities must be a list"
        )

    if len(manifest["capabilities"]) == 0:
        raise ValueError(
            "Capabilities cannot be empty"
        )

    return True