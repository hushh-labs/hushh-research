"""Bounded, internal document identities for request-priority processing."""

from uuid import UUID

from hushh_mcp.services.google_drive_adapter import DriveReadError


def document_targets(value):
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or not 1 <= len(value) <= 50:
        raise DriveReadError("invalid_argument")
    try:
        identities = tuple(str(UUID(identity)) for identity in value if isinstance(identity, str))
    except ValueError as error:
        raise DriveReadError("invalid_argument") from error
    if len(identities) != len(value) or len(set(identities)) != len(identities):
        raise DriveReadError("invalid_argument")
    return identities
