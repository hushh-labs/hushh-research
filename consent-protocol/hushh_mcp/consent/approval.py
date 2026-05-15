"""
Consent approval payload model with contextual self-validation.

Integrated by Abdul Gaffar — canonical consent surface.

ConsentApprovalPayload lives in hushh_mcp.consent so it shares the same
package as token.py, scope_helpers.py, and the rest of the consent boundary.

validate_contextual_rules() is intentionally free of external imports —
all checks are pure-Python comparisons on built-in types.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Constants (no external lookups)
# ---------------------------------------------------------------------------

_MINIMUM_AGE: int = 18

_BLOCKED_JURISDICTIONS: frozenset[str] = frozenset(
    {
        "OFAC_SANCTIONED",
        "RESTRICTED_REGION",
        "EMBARGOED",
    }
)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class ConsentApprovalPayload(BaseModel):
    """
    Pydantic model for the POST /api/consent/pending/approve request body.

    Captures the fields relevant to contextual rule evaluation so the model
    can self-validate against caller-supplied runtime context (age, location)
    without requiring any external policy service or utility import.

    Canonical surface: hushh_mcp.consent.approval
    Runtime boundary:  called by api.routes.consent.approve_consent
    """

    user_id: str = Field(..., min_length=1)
    request_id: str = Field(..., min_length=1)
    scope: str = Field(default="")
    requester_age: int | None = Field(default=None, ge=0)
    requester_location: str | None = Field(default=None)

    def validate_contextual_rules(self, context: dict[str, Any]) -> list[str]:
        """
        Validate this payload against a caller-supplied context dict.

        Checks dynamic runtime attributes (age, jurisdiction) that cannot be
        known at model-construction time and are not stored in the consent DB.

        Parameters
        ----------
        context : dict
            Runtime caller context. Recognised keys:
            - ``age`` (int)      — verified age of the requester
            - ``location`` (str) — requester's jurisdiction code

        Returns
        -------
        list[str]
            Human-readable violation strings.  Empty list → all rules pass.

        Notes
        -----
        No external helper libraries are used — every check is a plain
        Python conditional on standard built-in types.
        """
        violations: list[str] = []

        # ── Age gate ────────────────────────────────────────────────────────
        age = context.get("age")
        if age is not None and isinstance(age, int) and age < _MINIMUM_AGE:
            violations.append(
                f"age_gate: requester age {age} is below the minimum {_MINIMUM_AGE}"
            )

        # ── Jurisdiction ────────────────────────────────────────────────────
        location = context.get("location")
        if (
            location
            and isinstance(location, str)
            and location.upper() in _BLOCKED_JURISDICTIONS
        ):
            violations.append(
                f"jurisdiction: {location!r} is not a permitted consent jurisdiction"
            )

        return violations
