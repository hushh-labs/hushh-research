# mcp/tools/__init__.py
"""
MCP tool definitions and handlers.
"""

from .consent_tools import handle_check_consent_status, handle_request_consent
from .data_tools import (
    handle_get_encrypted_scoped_export,
    handle_get_financial,
    handle_get_food,
    handle_get_professional,
)
from .definitions import get_tool_definitions
from .ria_read_tools import (
    handle_get_ria_client_access_summary,
    handle_get_ria_profile,
    handle_get_ria_verification_status,
    handle_list_marketplace_investors,
    handle_list_ria_profiles,
)
from .utility_tools import (
    handle_delegate,
    handle_discover_user_domains,
    handle_list_scopes,
    handle_validate_token,
)

__all__ = [
    "get_tool_definitions",
    "handle_request_consent",
    "handle_check_consent_status",
    "handle_get_encrypted_scoped_export",
    "handle_get_financial",
    "handle_get_food",
    "handle_get_professional",
    "handle_validate_token",
    "handle_delegate",
    "handle_list_scopes",
    "handle_discover_user_domains",
    "handle_list_ria_profiles",
    "handle_get_ria_profile",
    "handle_list_marketplace_investors",
    "handle_get_ria_verification_status",
    "handle_get_ria_client_access_summary",
]
