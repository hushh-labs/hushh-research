# consent-protocol/hushh_mcp/consent/scope_helpers.py
"""
Dynamic Scope Resolution Helpers

Centralized utilities for resolving scopes to ConsentScope enums.
Replaces hardcoded SCOPE_TO_ENUM and SCOPE_ENUM_MAP dictionaries.
"""

from hushh_mcp.consent.scope_generator import get_scope_generator
from hushh_mcp.constants import RETIRED_SCOPE_VALUES, ConsentScope


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

    if ConsentScope.is_retired_scope(scope):
        raise ValueError(f"SCOPE_RETIRED: {scope}")

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

    # Agent and capability permissions
    _AGENT_SCOPE_MAP = {
        "cap.one.invoke": ConsentScope.CAP_ONE_INVOKE,
        "agent.kai.analyze": ConsentScope.AGENT_KAI_ANALYZE,
        "agent.nav.review": ConsentScope.AGENT_NAV_REVIEW,
        "agent.kyc.process": ConsentScope.AGENT_KYC_PROCESS,
        "agent.kyc.redraft.llm": ConsentScope.AGENT_KYC_REDRAFT_LLM,
        "agent.kyc.disclose.llm": ConsentScope.AGENT_KYC_DISCLOSE_LLM,
        "cap.location.live.share": ConsentScope.CAP_LOCATION_LIVE_SHARE,
        "cap.location.live.view": ConsentScope.CAP_LOCATION_LIVE_VIEW,
        "cap.location.live.request": ConsentScope.CAP_LOCATION_LIVE_REQUEST,
        "cap.location.live.revoke": ConsentScope.CAP_LOCATION_LIVE_REVOKE,
        "cap.location.live.refer_request": ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST,
        # The nearby triple has existed in `ConsentScope` and in
        # `capability_scopes()` since nearby check-in shipped, but never here --
        # so every one of them raised `Unknown capability scope` the moment
        # anything tried to resolve it. Declared but unresolvable is worse than
        # absent: the scope reads as supported everywhere it is listed.
        "cap.location.nearby.publish": ConsentScope.CAP_LOCATION_NEARBY_PUBLISH,
        "cap.location.nearby.discover": ConsentScope.CAP_LOCATION_NEARBY_DISCOVER,
        "cap.location.nearby.revoke": ConsentScope.CAP_LOCATION_NEARBY_REVOKE,
        "cap.location.place_rating.publish": ConsentScope.CAP_LOCATION_PLACE_RATING_PUBLISH,
        "cap.location.place_rating.discover": ConsentScope.CAP_LOCATION_PLACE_RATING_DISCOVER,
        "cap.location.place_rating.revoke": ConsentScope.CAP_LOCATION_PLACE_RATING_REVOKE,
        "cap.pkm.marketplace.view": ConsentScope.CAP_PKM_MARKETPLACE_VIEW,
        "cap.pkm.marketplace.manage": ConsentScope.CAP_PKM_MARKETPLACE_MANAGE,
        "cap.contact.discovery": ConsentScope.CAP_CONTACT_DISCOVERY,
        # Pod data-door READ scopes (keyless pod reads a specialist through the
        # hub broker). Declared here so they resolve; unresolvable-but-listed is
        # worse than absent, the exact trap the nearby triple hit above.
        "cap.email.inbox.view": ConsentScope.CAP_EMAIL_INBOX_VIEW,
        "cap.calendar.events.view": ConsentScope.CAP_CALENDAR_EVENTS_VIEW,
        "cap.finance.connections.view": ConsentScope.CAP_FINANCE_CONNECTIONS_VIEW,
    }
    if scope.startswith("agent."):
        resolved = _AGENT_SCOPE_MAP.get(scope)
        if resolved is None:
            raise ValueError(f"Unknown agent scope: {scope!r}")
        return resolved
    if scope.startswith("cap."):
        resolved = _AGENT_SCOPE_MAP.get(scope)
        if resolved is None:
            raise ValueError(f"Unknown capability scope: {scope!r}")
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
    # Historical strings are display/audit-only and never authorize access,
    # even when both sides contain the same retired value.
    if ConsentScope.is_retired_scope(granted_scope) or requested_scope in RETIRED_SCOPE_VALUES:
        return False

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
        "cap.one.invoke": {
            "label": "Invoke One",
            "description": "Allow One to create or resume a task without granting data access",
            "icon_name": "route",
            "color_hex": "#3B82F6",
        },
        "agent.kai.analyze": {
            "label": "Kai Analysis",
            "description": "Allow Kai agent to analyze your data",
            "icon_name": "brain",
            "color_hex": "#D4AF37",
        },
        "agent.nav.review": {
            "label": "Nav Scope Review",
            "description": "Allow Nav to review consent, privacy, vault, and scope decisions",
            "icon_name": "shield-check",
            "color_hex": "#10B981",
        },
        "agent.kyc.process": {
            "label": "KYC Processing",
            "description": "Allow KYC to process identity workflow requirements inside the granted scope",
            "icon_name": "id-card",
            "color_hex": "#6366F1",
        },
        "agent.kyc.redraft.llm": {
            "label": "KYC Redraft",
            "description": "Allow an explicitly approved LLM-assisted KYC redraft",
            "icon_name": "file-pen",
            "color_hex": "#6366F1",
        },
        "agent.kyc.disclose.llm": {
            "label": "KYC Data Disclosure via AI",
            "description": "Allow One to send approved data to the AI to draft this KYC reply",
            "icon_name": "id-card",
            "color_hex": "#6366F1",
        },
        "cap.location.live.share": {
            "label": "Share Live Location",
            "description": "Allow One to create a recipient-bound live-location grant",
            "icon_name": "map-pin",
            "color_hex": "#0F766E",
        },
        "cap.location.live.view": {
            "label": "View Live Location",
            "description": "Allow the approved recipient to fetch encrypted location envelopes",
            "icon_name": "map",
            "color_hex": "#0F766E",
        },
        "cap.location.live.request": {
            "label": "Request Live Location",
            "description": "Allow a verified person to request owner-approved location access",
            "icon_name": "message-circle-plus",
            "color_hex": "#0F766E",
        },
        "cap.location.live.revoke": {
            "label": "Revoke Live Location",
            "description": "Allow the owner to stop an active location grant",
            "icon_name": "shield-x",
            "color_hex": "#0F766E",
        },
        "cap.location.live.refer_request": {
            "label": "Refer Location Request",
            "description": "Allow a recipient to refer another person into an owner approval flow",
            "icon_name": "user-plus",
            "color_hex": "#0F766E",
        },
        # Without these six, `describe_scope` falls through to the title-cased
        # handle and the consent surface shows a person the string
        # "Cap Location Nearby Publish" where a sentence belongs.
        "cap.location.nearby.publish": {
            "label": "Appear Nearby",
            "description": "Show your first name to opted-in people at the same place, for up to two hours",
            "icon_name": "radio",
            "color_hex": "#0F766E",
        },
        "cap.location.nearby.discover": {
            "label": "See Who Is Nearby",
            "description": "Read the list of opted-in people checked in at the same place as you",
            "icon_name": "users-round",
            "color_hex": "#0F766E",
        },
        "cap.location.nearby.revoke": {
            "label": "Check Out",
            "description": "Stop appearing nearby and clear the place you checked in at",
            "icon_name": "log-out",
            "color_hex": "#0F766E",
        },
        "cap.location.place_rating.publish": {
            "label": "Rate A Place",
            "description": (
                "Save your own star rating for a place you were recorded at. "
                "Your rating is private to you and counts toward an anonymous average"
            ),
            "icon_name": "star",
            "color_hex": "#0F766E",
        },
        "cap.location.place_rating.discover": {
            "label": "See Place Ratings",
            "description": "Read the anonymous average rating for a place, never who rated it",
            "icon_name": "chart-no-axes-column",
            "color_hex": "#0F766E",
        },
        "cap.location.place_rating.revoke": {
            "label": "Delete Your Rating",
            "description": "Remove your rating and take it out of the place's average",
            "icon_name": "trash-2",
            "color_hex": "#0F766E",
        },
        "cap.contact.discovery": {
            "label": "Find People You Know",
            "description": (
                "Match your address book against Hussh accounts. "
                "Phone numbers are hashed on your device and never stored"
            ),
            "icon_name": "users",
            "color_hex": "#0F766E",
        },
        "cap.email.inbox.view": {
            "label": "Read Your Email Summary",
            "description": (
                "Let your private agent read a summary of your inbox (senders, "
                "subjects, dates) to answer email questions. Never reads message "
                "bodies, never sends or changes mail"
            ),
            "icon_name": "mail",
            "color_hex": "#0F766E",
        },
        "cap.calendar.events.view": {
            "label": "Read Your Calendar",
            "description": (
                "Let your private agent read your upcoming events (titles and "
                "times) to answer calendar questions. Never edits, creates, or "
                "cancels events"
            ),
            "icon_name": "calendar",
            "color_hex": "#0F766E",
        },
        "cap.finance.connections.view": {
            "label": "Read Your Account Connections",
            "description": (
                "Let your private agent see which financial accounts are "
                "connected and their sync status. Never reads balances, holdings, "
                "or transactions, which stay locked in your vault"
            ),
            "icon_name": "link",
            "color_hex": "#0F766E",
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


# Short alias for resolve_scope_to_enum, used in tests and external callers.
resolve_scope = resolve_scope_to_enum
