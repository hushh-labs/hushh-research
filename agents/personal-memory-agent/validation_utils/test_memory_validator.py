from validation_utils.memory_validator import validate_memory_payload


def test_valid_memory_payload():
    payload = {
        "memory_text": "User likes AI systems.",
        "user_id": "user_123",
        "timestamp": "2026-05-12T10:00:00",
        "metadata": {
            "source": "chat"
        }
    }

    result = validate_memory_payload(payload)

    assert result["valid"] is True
    assert result["errors"] == []


def test_invalid_memory_payload():
    payload = {
        "memory_text": "",
        "user_id": None,
        "timestamp": "invalid-date",
        "metadata": "invalid"
    }

    result = validate_memory_payload(payload)

    assert result["valid"] is False
    assert len(result["errors"]) > 0