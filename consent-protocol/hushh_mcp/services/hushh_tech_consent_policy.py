"""The product client's exact-scope policy, shared by reads and owner offers.

Recipient preparation only refuses an unusable offer. Runtime authentication,
account linking, token authority and encrypted-export admission still apply.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hushh_mcp.services.developer_registry_service import DeveloperPrincipal


def hushh_tech_consent_scope_allowed(scope: str | None) -> bool:
    """Preserve the reader's existing exact, non-wildcard allowlist."""
    from hushh_mcp.consent.scope_helpers import normalize_scope

    normalized = normalize_scope(scope) if scope else ""
    allowed = {
        normalize_scope(item)
        for item in str(os.getenv("HUSSH_TECH_ALLOWED_CONSENT_SCOPES", "")).split(",")
        if str(item).strip()
    }
    return (
        normalized.startswith("attr.") and not normalized.endswith(".*") and normalized in allowed
    )


def registered_app_consent_scope_allowed(principal: DeveloperPrincipal, scope: str) -> bool:
    """An active special-purpose app still retains its product restrictions."""
    from hushh_mcp.services.developer_registry_service import TOOL_GROUP_HUSHH_TECH_CLIENT

    configured = str(os.getenv("HUSSH_TECH_DEVELOPER_APP_ID", "")).strip()
    groups = tuple(principal.allowed_tool_groups)
    candidate = (
        bool(configured and principal.app_id == configured)
        or TOOL_GROUP_HUSHH_TECH_CLIENT in groups
    )
    if not candidate:
        return True
    from hushh_mcp.services.hushh_tech_client_service import hushh_tech_client_enabled

    return bool(
        configured
        and principal.app_id == configured
        and groups == (TOOL_GROUP_HUSHH_TECH_CLIENT,)
        and not tuple(principal.allowed_capabilities)
        and principal.auth_source == "registry"
        and hushh_tech_client_enabled()
        and hushh_tech_consent_scope_allowed(scope)
    )
