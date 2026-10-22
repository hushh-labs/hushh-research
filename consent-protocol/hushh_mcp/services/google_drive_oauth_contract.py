"""Import-safe Google Drive OAuth identifiers shared by runtime and registry tooling."""

from hushh_mcp.services.google_drive_adapter import DRIVE_FILE_SCOPE

CONNECTOR_ID = "google_drive"
AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - public provider URL, not a token
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
SCOPES = ("openid", "email", DRIVE_FILE_SCOPE)
LIVE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
LIVE_SCOPES = ("openid", "email", LIVE_DRIVE_SCOPE)
REGISTRY_SCOPES = (*SCOPES, LIVE_DRIVE_SCOPE)
