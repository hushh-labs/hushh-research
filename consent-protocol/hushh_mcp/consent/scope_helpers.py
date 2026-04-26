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
    - Other static ConsentScope values

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
    _AGENT_SCOPE_MAP = {
        "agent.kai.analyze": ConsentScope.AGENT_KAI_ANALYZE,
        "agent.kai.debate": ConsentScope.AGENT_KAI_DEBATE,
        "agent.kai.infer": ConsentScope.AGENT_KAI_INFER,
        "agent.kai.chat": ConsentScope.AGENT_KAI_CHAT,
        "agent.kai.execute": ConsentScope.AGENT_KAI_EXECUTE,
    }
    if scope.startswith("agent."):
        resolved = _AGENT_SCOPE_MAP.get(scope)
        if resolved is None:
            raise ValueError(f"Unknown agent scope: {scope!r}")
        return resolved

    try:
        return ConsentScope(scope)
    except ValueError as exc:
        raise ValueError(f"Unknown scope: {scope!r}") from exc


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
    info = get_scope_display_metadata(scope)
    return info["description"]


def get_scope_display_metadata(scope: str) -> dict:
    """
    Get full display metadata for any scope: label, description, icon_name, color_hex.

    This is the primary function for consent UIs to resolve scope presentation.

    Args:
        scope: The scope string

    Returns:
        Dict with keys: label, description, icon_name, color_hex
    """
    generator = get_scope_generator()

    # Dynamic attr.* scopes — resolve via DynamicScopeGenerator + domain contracts
    if generator.is_dynamic_scope(scope):
        display_info = generator.get_scope_display_info(scope)
        return {
            "label": display_info["display_name"],
            "description": display_info["description"]
            or f"Access your {display_info['domain']} data",
            "icon_name": display_info["icon_name"],
            "color_hex": display_info["color_hex"],
        }

    # Static scope metadata
    _STATIC_SCOPE_META: dict[str, dict] = {
        "vault.owner": {
            "label": "Full Vault Access",
            "description": "Full access to your vault (master key)",
            "icon_name": "shield",
            "color_hex": "#D4AF37",
        },
        "pkm.read": {
            "label": "Read All Personal Data",
            "description": "Read your personal knowledge model data",
            "icon_name": "book-open",
            "color_hex": "#3B82F6",
        },
        "pkm.write": {
            "label": "Write Personal Data",
            "description": "Write to your personal knowledge model",
            "icon_name": "pencil",
            "color_hex": "#3B82F6",
        },
        "agent.kai.analyze": {
            "label": "Kai Analysis",
            "description": "Allow Kai agent to analyze your data",
            "icon_name": "brain",
            "color_hex": "#D4AF37",
        },
        "agent.kai.execute": {
            "label": "Kai Actions",
            "description": "Allow Kai agent to execute actions",
            "icon_name": "zap",
            "color_hex": "#D4AF37",
        },
    }

    meta = _STATIC_SCOPE_META.get(scope)
    if meta:
        return meta

    return {
        "label": scope.replace(".", " ").replace("_", " ").title(),
        "description": f"Access: {scope}",
        "icon_name": None,
        "color_hex": None,
    }


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
