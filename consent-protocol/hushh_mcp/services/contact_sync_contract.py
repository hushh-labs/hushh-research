"""Versioned authority contracts for contact discovery and auto-connect."""

from __future__ import annotations

# This value is part of the wire contract. A client must send it when enabling
# contact sync so an older findability-only UI cannot silently grant the newer
# relationship-creation authority.
CONTACT_SYNC_CONSENT_CONTRACT_VERSION = "contact_find_auto_connect_v1"

# Contact matching is now aligned with the verified ONE Connect directory.
# This is deliberately separate from the historical consent marker above:
# default directory eligibility is a product policy, not evidence that a
# target explicitly accepted the v1 disclosure.
CONTACT_SYNC_MATCH_POLICY_VERSION = "contact_directory_auto_connect_v2"
CONTACT_SYNC_POLICY_LOCK_NAMESPACE = 171

CONTACT_SYNC_PREFERENCE_DEFAULT = "default"
CONTACT_SYNC_PREFERENCE_ENABLED = "enabled"
CONTACT_SYNC_PREFERENCE_DISABLED = "disabled"
CONTACT_SYNC_PREFERENCE_INVALID = "invalid"


def contact_sync_preference_state(
    *,
    discoverable: object,
    enabled_at: object,
    rule_version: object,
    contract_version: object,
) -> str:
    """Classify stored contact preference evidence without inventing consent.

    Version zero with no evidence is the directory-policy default. A positive
    version is an explicit decision and must be internally complete; malformed
    or stale positive-version evidence fails closed.
    """

    try:
        version = int(rule_version or 0)
    except (TypeError, ValueError):
        return CONTACT_SYNC_PREFERENCE_INVALID
    # The database policy queries deliberately distinguish missing evidence
    # (NULL) from malformed evidence (including an empty or whitespace-only
    # contract marker). Keep the Python mutation boundary identical: trimming
    # a stored marker here would make the preference API report a target as
    # eligible even though the exact matcher correctly excludes the same row.
    contract = None if contract_version is None else str(contract_version)

    if version == 0 and enabled_at is None and contract is None:
        return CONTACT_SYNC_PREFERENCE_DEFAULT
    if (
        version > 0
        and bool(discoverable)
        and enabled_at is not None
        and contract == CONTACT_SYNC_CONSENT_CONTRACT_VERSION
    ):
        return CONTACT_SYNC_PREFERENCE_ENABLED
    if version > 0 and not bool(discoverable) and enabled_at is None and contract is None:
        return CONTACT_SYNC_PREFERENCE_DISABLED
    return CONTACT_SYNC_PREFERENCE_INVALID


__all__ = [
    "CONTACT_SYNC_CONSENT_CONTRACT_VERSION",
    "CONTACT_SYNC_MATCH_POLICY_VERSION",
    "CONTACT_SYNC_POLICY_LOCK_NAMESPACE",
    "CONTACT_SYNC_PREFERENCE_DEFAULT",
    "CONTACT_SYNC_PREFERENCE_DISABLED",
    "CONTACT_SYNC_PREFERENCE_ENABLED",
    "CONTACT_SYNC_PREFERENCE_INVALID",
    "contact_sync_preference_state",
]
