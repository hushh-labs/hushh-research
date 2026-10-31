"""Shared RIA status predicates for relationship-facing reads."""

from __future__ import annotations

# The SQL predicate for "this RIA profile is real enough to carry a capability".
#
# Static text under our control, never user input. Query builders interpolate it
# so tests can assert every status literal remains aligned with RIAIAMService.
RIA_VERIFIED_STATUS_SQL = "verification_status IN ('active', 'verified', 'finra_verified')"
