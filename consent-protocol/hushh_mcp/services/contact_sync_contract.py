"""Versioned authority contract for contact discovery and auto-connect."""

from __future__ import annotations

# This value is part of the wire contract. A client must send it when enabling
# contact sync so an older findability-only UI cannot silently grant the newer
# relationship-creation authority.
CONTACT_SYNC_CONSENT_CONTRACT_VERSION = "contact_find_auto_connect_v1"


__all__ = ["CONTACT_SYNC_CONSENT_CONTRACT_VERSION"]
