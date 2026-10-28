"""Fixed failure codes for financial packet organizing: the only causes saved or logged."""

import asyncio

from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError

# Fixed codes from the credential path. Anything else, such as a raw provider
# message, collapses to oauth_unavailable and never reaches a log or saved state.
OAUTH_FAILURE_CODES = frozenset(
    {
        "connector_unavailable",
        "invalid_argument",
        "reconnect_required",
        "connection_changed",
        "insufficient_scope",
        "unexpected_scope",
        "connector_configuration_invalid",
        "refresh_in_progress",
        "provider_unavailable",
        "provider_response_invalid",
        "provider_response_too_large",
        "grant_rejected",
        "identity_not_verified",
        "profile_unavailable",
    }
)
LIFECYCLE_FAILURE_CODES = frozenset(
    {"connector_storage_unavailable", "connector_unavailable", "revocation_in_progress"}
)
# The runtime log redactor masks any 24-128 character token with "_" or "-" as a
# possible identifier, so a longer upstream code is saved and logged as a short one.
SHORT_CODES = {
    "connector_configuration_invalid": "connector_misconfigured",
    "connector_storage_unavailable": "storage_unavailable",
    "provider_response_invalid": "provider_invalid",
    "provider_response_too_large": "provider_too_large",
}
# The only failure codes saved with an attempt, and so the only ones an owner can see.
FAILURE_CODES = frozenset(
    SHORT_CODES.get(code, code) for code in OAUTH_FAILURE_CODES | LIFECYCLE_FAILURE_CODES
) | {"oauth_unavailable", "processing_timeout", "processing_unavailable"}
# Failures that pass on their own: refresh contention, provider or storage
# unavailability, or a batch ended by the worker's own budget.
TRANSIENT_FAILURE_CODES = frozenset(
    {"refresh_in_progress", "provider_unavailable", "storage_unavailable", "processing_timeout"}
)


def failure_code(error):
    """The fixed code for one failed organizing attempt."""
    if isinstance(error, DriveOAuthError):
        code = str(error) if str(error) in OAUTH_FAILURE_CODES else "oauth_unavailable"
    elif isinstance(error, ConnectorLifecycleError):
        code = str(error) if str(error) in LIFECYCLE_FAILURE_CODES else "connector_unavailable"
    elif isinstance(error, DriveReadError) and error.retryable:
        code = "provider_unavailable"
    elif isinstance(error, (TimeoutError, asyncio.CancelledError)):
        # The worker's own budget or a shutdown ended the batch: not a packet fault.
        code = "processing_timeout"
    else:
        code = "processing_unavailable"
    return SHORT_CODES.get(code, code)
