"""Encrypted OAuth attempt context; pure validation, no credential authority."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal


def connection_generation(row: dict[str, Any] | None) -> str:
    # Access-token refresh changes only the access envelope, not this marker.
    # Reconnect creates a new randomly encrypted refresh envelope; disconnect
    # clears it. Keep this digest inside the encrypted attempt, never in logs.
    identity = (
        None
        if row is None
        else {
            key: row.get(key) for key in ("provider_subject", "refresh_token_ciphertext", "status")
        }
    )
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def encode_attempt(*, verifier: str, generation: str, transport: Literal["web", "native"]) -> str:
    return json.dumps(
        {"version": 1, "verifier": verifier, "generation": generation, "transport": transport}
    )


def decode_attempt(value: str, *, transport: Literal["web", "native"]) -> dict[str, str]:
    try:
        data = json.loads(value)
    except (ValueError, TypeError) as error:
        raise ValueError("Restart the Google connection") from error
    if not isinstance(data, dict) or data.get("version") != 1 or data.get("transport") != transport:
        raise ValueError("Restart the Google connection")
    verifier, generation = data.get("verifier"), data.get("generation")
    if not isinstance(verifier, str) or not 43 <= len(verifier) <= 128:
        raise ValueError("Restart the Google connection")
    if (
        not isinstance(generation, str)
        or len(generation) != 64
        or any(c not in "0123456789abcdef" for c in generation)
    ):
        raise ValueError("Restart the Google connection")
    return {"verifier": verifier, "generation": generation}
