"""Shared Connected Systems error contract for registry and transport adapters."""

from __future__ import annotations


class ConnectedSystemsError(RuntimeError):
    """Base error for Connected Systems failures."""

    status_code = 500
    code = "CONNECTED_SYSTEMS_ERROR"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        super().__init__(message)


class ConnectedSystemNotFoundError(ConnectedSystemsError):
    status_code = 404
    code = "CONNECTED_SYSTEM_NOT_FOUND"


class ConnectedSystemValidationError(ConnectedSystemsError):
    status_code = 422
    code = "CONNECTED_SYSTEM_VALIDATION_FAILED"


class ConnectedSystemBlockedError(ConnectedSystemsError):
    status_code = 403
    code = "CONNECTED_SYSTEM_ACTION_BLOCKED"


class ConnectedSystemConfigurationError(ConnectedSystemsError):
    status_code = 503
    code = "CONNECTED_SYSTEM_NOT_CONFIGURED"
