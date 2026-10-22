"""Fixed Drive OAuth vocabulary, safe for database-only operator commands."""

from typing import Final

CONNECTOR_ID: Final = "google_drive"
AUTHORIZE_URL: Final = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL: Final = "https://oauth2.googleapis.com/token"  # noqa: S105 - public provider URL
REVOKE_URL: Final = "https://oauth2.googleapis.com/revoke"
DRIVE_FILE_SCOPE: Final = "https://www.googleapis.com/auth/drive.file"
LIVE_DRIVE_SCOPE: Final = "https://www.googleapis.com/auth/drive"
SCOPES: Final = ("openid", "email", DRIVE_FILE_SCOPE)
LIVE_SCOPES: Final = ("openid", "email", LIVE_DRIVE_SCOPE)
REGISTRY_SCOPES: Final = (*SCOPES, LIVE_DRIVE_SCOPE)
