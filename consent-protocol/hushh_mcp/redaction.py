import hashlib


def token_fingerprint(token: str | None, *, label: str = "ct", length: int = 12) -> str:
    """
    Stable, privacy-preserving identifier for logging/telemetry.

    Consent tokens embed base64-encoded user_id/agent_id/scope in cleartext. Never log
    raw prefixes or substrings of tokens. Use this fingerprint instead.
    """
    normalized = (token or "").strip()
    if not normalized:
        return f"{label}:empty"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"{label}:{digest[: max(4, int(length))]}"

