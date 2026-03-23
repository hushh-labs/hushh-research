# consent-protocol/hushh_mcp/consent/scope_helpers.py
"""
Dynamic Scope Resolution Helpers

Centralized utilities for resolving scopes to ConsentScope enums.
Replaces hardcoded SCOPE_TO_ENUM and SCOPE_ENUM_MAP dictionaries.
"""

from hushh_mcp.consent.scope_generator import get_scope_generator
from hushh_mcp.constants import ConsentScope


def resolve_scope_to_enum(scope: str) -> ConsentScope:
    """
    Resolve any scope string to its ConsentScope enum.

    Handles:
    - Dynamic attr.{domain}.* scopes
    - Dynamic attr.{domain}.{attribute} scopes
    - PKM scopes (pkm.read, pkm.write) and internal aliases
    - Agent permissions (agent.*)
    - vault.owner master scope
    - custom.* temporary scopes

    Args:
        scope: The scope string to resolve

    Returns:
        ConsentScope enum value
    """
    generator = get_scope_generator()

    # Master scope
    if scope == "vault.owner":
        return ConsentScope.VAULT_OWNER

    # Dynamic attr.* scopes - each domain gets isolated handling
    # CRITICAL: Do NOT map all attr.* to PKM_READ - this breaks isolation!
    # Instead, we use PKM_READ as a base but validate scope strings directly
    if generator.is_dynamic_scope(scope):
        domain, attribute_key, is_wildcard = generator.parse_scope(scope)
        # Return PKM_READ but scope validation will check exact domain match
        # This allows dynamic scopes while maintaining isolation
        return ConsentScope.PKM_READ

    # Static PKM scopes
    if scope == "pkm.read":
        return ConsentScope.PKM_READ
    if scope == "pkm.write":
        return ConsentScope.PKM_WRITE

    # Agent permissions
    if scope.startswith("agent."):
        return ConsentScope.AGENT_EXECUTE

    # Custom/temporary scopes
    if scope.startswith("custom."):
        return ConsentScope.CUSTOM_TEMPORARY

    # Default to custom temporary
    return ConsentScope.CUSTOM_TEMPORARY


def scope_matches(granted_scope: str, requested_scope: str) -> bool:
    """
    Check if a granted scope satisfies a requested scope.

    This is the KEY function for scope isolation. It ensures:
    - attr.financial.* ONLY matches attr.financial.* or attr.financial.{specific}
    - attr.financial.* does NOT match attr.food.* or other domains
    - pkm.read matches ALL attr.* scopes (full access)
    - vault.owner matches EVERYTHING (master key)

    Args:
        granted_scope: The scope that was granted (from token)
        requested_scope: The scope being requested (from operation)

    Returns:
        True if granted scope satisfies requested scope
    """
    # Exact match
    if granted_scope == requested_scope:
        return True

    # Master key: vault.owner grants everything
    if granted_scope == "vault.owner":
        return True

    # PKM read grants access to ALL attr.* domains
    if granted_scope == "pkm.read":
        generator = get_scope_generator()
        if generator.is_dynamic_scope(requested_scope):
            return True

    # Wildcard + path-aware matching for dynamic attr.* scopes
    generator = get_scope_generator()
    if generator.is_dynamic_scope(granted_scope) and generator.is_dynamic_scope(requested_scope):
        # Uses DynamicScopeGenerator's parser for domain/path-aware checks:
        # - attr.financial.* covers attr.financial.profile.*
        # - attr.financial.profile.* does NOT cover attr.financial.holdings
        return generator.matches_wildcard(requested_scope, granted_scope)

    return False


def get_scope_description(scope: str) -> str:
    """
    Get human-readable description for any scope.

    Uses DynamicScopeGenerator for attr.* scopes; hardcoded for PKM and agent scopes.

    Args:
        scope: The scope string

    Returns:
        Human-readable description
    """
    generator = get_scope_generator()

    # Dynamic attr.* scopes - generate description from scope structure
    if generator.is_dynamic_scope(scope):
        display_info = generator.get_scope_display_info(scope)
        domain = display_info["domain"]
        attribute = display_info["attribute"]
        is_wildcard = display_info["is_wildcard"]

        if is_wildcard:
            return f"Access all your {domain} data"
        elif attribute:
            attr_display = attribute.replace("_", " ").title()
            return f"Access your {domain} - {attr_display}"
        else:
            return f"Access your {domain} domain"

    # Hardcoded descriptions for non-dynamic scopes (PKM only; no legacy vault.*)
    descriptions = {
        "vault.owner": "Full access to your vault (master key)",
        "pkm.read": "Read your personal knowledge model data",
        "pkm.write": "Write to your personal knowledge model",
        "agent.kai.analyze": "Allow Kai agent to analyze your data",
        "agent.kai.execute": "Allow Kai agent to execute actions",
    }

    return descriptions.get(scope, f"Access: {scope}")


def is_write_scope(scope: str) -> bool:
    """
    Determine if a scope implies write access.

    Args:
        scope: The scope string

    Returns:
        True if the scope grants write access
    """
    if scope == "vault.owner":
        return True

    if scope == "pkm.write":
        return True

    # For attr.* scopes, write is determined by context, not scope
    return False


def normalize_scope(scope: str) -> str:
    """
    Normalize scope string to canonical dot notation.

    Accepts canonical dot notation only.

    Args:
        scope: The scope string to normalize

    Returns:
        Normalized scope string in dot notation
    """
    generator = get_scope_generator()

    # Already in canonical dot format
    if generator.is_dynamic_scope(scope) or scope in ("pkm.read", "pkm.write"):
        return scope

    return scope
