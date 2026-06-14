"""Consent-domain exception types for the error-boundary handlers.

Raised by service-layer code when a consent-policy rule blocks an operation
or a zero-knowledge proof fails.  server.py registers an exception handler
for each type so FastAPI converts them to privacy-safe 403 JSON responses
without leaking internal state to the caller.

Canonical surface: hushh_mcp.consent.errors
Integrated by Abdul Gaffar — canonical error-boundary mapping.
"""

from __future__ import annotations


class PolicyViolationError(Exception):
    """Raised when an operation is blocked by a consent-policy rule.

    The ``message`` is designed to be safe for external surfaces — it must
    never contain raw stack traces, internal IDs, or PII.  ``code`` is a
    machine-readable token callers can match against.
    """

    def __init__(self, message: str, code: str = "POLICY_VIOLATION") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class ZKPVerificationError(Exception):
    """Raised when a zero-knowledge proof fails verification.

    As with PolicyViolationError, ``message`` must be safe to surface
    externally.  Never include the raw proof bytes or private witness
    material in the message string.
    """

    def __init__(self, message: str, code: str = "ZKP_VERIFICATION_FAILED") -> None:
        super().__init__(message)
        self.message = message
        self.code = code
