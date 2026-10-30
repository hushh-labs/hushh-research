# api/exceptions.py
"""
Custom Exception Hierarchy for Hussh Consent Protocol

Provides structured error responses with consistent error codes.
"""

from typing import Any, Dict, Optional


class HushhBaseException(Exception):
    """Base exception for all Hussh errors."""

    status_code: int = 500
    error_code: str = "HUSHH_ERROR"

    def __init__(
        self, message: str = "An error occurred", details: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.details = details or {}
        super().__init__(self.message)

    def to_dict(self) -> Dict[str, Any]:
        """Convert exception to API response format."""
        return {
            "error": True,
            "error_code": self.error_code,
            "message": self.message,
            "details": self.details,
        }


class ConsentError(HushhBaseException):
    """Consent-related errors (permission denied, invalid token, etc.)."""

    status_code = 403
    error_code = "CONSENT_ERROR"


class TokenExpiredError(ConsentError):
    """Consent token has expired."""

    error_code = "TOKEN_EXPIRED"

    def __init__(self, message: str = "Consent token has expired"):
        super().__init__(message)


class ScopeMismatchError(ConsentError):
    """Token scope doesn't match required scope."""

    error_code = "SCOPE_MISMATCH"

    def __init__(self, required_scope: str, token_scope: str):
        super().__init__(
            message=f"Scope mismatch: required '{required_scope}', got '{token_scope}'",
            details={"required_scope": required_scope, "token_scope": token_scope},
        )


class TokenRevokedError(ConsentError):
    """Token has been revoked."""

    error_code = "TOKEN_REVOKED"

    def __init__(self, message: str = "Consent token has been revoked"):
        super().__init__(message)


class RateLimitExceeded(HushhBaseException):
    """Request rate limit exceeded."""

    status_code = 429
    error_code = "RATE_LIMIT_EXCEEDED"

    def __init__(self, limit: str, retry_after: Optional[int] = None):
        super().__init__(
            message=f"Rate limit exceeded: {limit}",
            details={"limit": limit, "retry_after": retry_after},
        )


class VaultError(HushhBaseException):
    """Vault access errors (encryption, decryption, storage)."""

    status_code = 500
    error_code = "VAULT_ERROR"


class VaultKeyNotFoundError(VaultError):
    """User's vault key not found."""

    status_code = 404
    error_code = "VAULT_KEY_NOT_FOUND"

    def __init__(self, user_id: str):
        super().__init__(message="Vault key not found for user", details={"user_id": user_id})


class AgentError(HushhBaseException):
    """Agent-related errors."""

    status_code = 500
    error_code = "AGENT_ERROR"


class AgentNotFoundError(AgentError):
    """Requested agent not found."""

    status_code = 404
    error_code = "AGENT_NOT_FOUND"

    def __init__(self, agent_id: str):
        super().__init__(message=f"Agent not found: {agent_id}", details={"agent_id": agent_id})


class ValidationError(HushhBaseException):
    """Request validation errors."""

    status_code = 400
    error_code = "VALIDATION_ERROR"
