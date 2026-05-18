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
from .kai_tools import (
    handle_kai_analyze_stock,
    handle_kai_cancel_active_analysis,
    handle_kai_navigate_back,
    handle_kai_open_consent,
    handle_kai_open_dashboard,
    handle_kai_open_history,
    handle_kai_open_home,
    handle_kai_open_import,
    handle_kai_open_optimize,
    handle_kai_open_profile,
    handle_kai_resume_active_analysis,
)
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
    # Consent
    "handle_request_consent",
    "handle_check_consent_status",
    # Data
    "handle_get_encrypted_scoped_export",
    "handle_get_financial",
    "handle_get_food",
    "handle_get_professional",
    # Utility
    "handle_validate_token",
    "handle_delegate",
    "handle_list_scopes",
    "handle_discover_user_domains",
    # RIA / Marketplace
    "handle_list_ria_profiles",
    "handle_get_ria_profile",
    "handle_list_marketplace_investors",
    "handle_get_ria_verification_status",
    "handle_get_ria_client_access_summary",
    # Kai voice actions
    "handle_kai_analyze_stock",
    "handle_kai_open_dashboard",
    "handle_kai_open_import",
    "handle_kai_open_history",
    "handle_kai_open_consent",
    "handle_kai_open_profile",
    "handle_kai_open_optimize",
    "handle_kai_open_home",
    "handle_kai_navigate_back",
    "handle_kai_resume_active_analysis",
    "handle_kai_cancel_active_analysis",
]
