"""Dev-only additions for the immutable private-agent adoption inventory."""

from __future__ import annotations


def provider_transition_registry_trigger_addition() -> str:
    from db.hosted_custody_qualification import hosted_custody_profile_from_environment

    if not hosted_custody_profile_from_environment().is_dev_control_plane_owner:
        return ""
    return "('personal_agent_registry','zx_hosted_provider_account_transition_registry'),"
