from datetime import datetime


def validate_memory_payload(memory_payload: dict) -> dict:
    """
    Validates structured memory payloads before processing.
    """

    validation_result = {
        "valid": True,
        "errors": []
    }

    if not isinstance(memory_payload, dict):
        validation_result["valid"] = False
        validation_result["errors"].append("Payload must be a dictionary.")
        return validation_result

    memory_text = memory_payload.get("memory_text")

    if not memory_text or not isinstance(memory_text, str):
        validation_result["valid"] = False
        validation_result["errors"].append("Invalid or empty memory_text.")

    user_id = memory_payload.get("user_id")

    if not user_id or not isinstance(user_id, str):
        validation_result["valid"] = False
        validation_result["errors"].append("Invalid or missing user_id.")

    timestamp = memory_payload.get("timestamp")

    if timestamp:
        try:
            datetime.fromisoformat(timestamp)
        except ValueError:
            validation_result["valid"] = False
            validation_result["errors"].append("Invalid timestamp format.")

    metadata = memory_payload.get("metadata")

    if metadata and not isinstance(metadata, dict):
        validation_result["valid"] = False
        validation_result["errors"].append("Metadata must be a dictionary.")

    return validation_result