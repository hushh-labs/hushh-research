"""Feature admission for Location surfaces that are not open everywhere.

Lifted from ``api/routes/one/location.py`` so the same predicate gates both
the HTTP routes and the One Live Voice tools. The semantics are unchanged: a
voice tool must be dark exactly where the route is dark, or the model could
narrate a feature the app cannot open.
"""

from __future__ import annotations

import os

_SAFE_ENVIRONMENTS = frozenset({"development", "dev", "local", "test", "uat", "staging"})


def nearby_presence_cohort() -> set[str] | None:
    """Production allowlist. ``None`` means "no cohort configured"."""

    raw = str(os.getenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT") or "").strip()
    if not raw:
        return None
    if raw.lower() == "all":
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def nearby_presence_enabled(user_id: str | None = None) -> bool:
    """Whether nearby check-in (and therefore place ratings) is reachable for this caller.

    Non-production lanes are unchanged: the flow is on unless
    ``ONE_LOCATION_NEARBY_PRESENCE_MODE`` names something other than the UAT
    simulation.

    Production is off unless deliberately opted into, because the reported
    point is client-supplied and unattestable -- see the continuity guard in
    ``one_location_nearby_presence_service``, which bounds a roaming attack but
    cannot prove any single check-in. Opting in therefore takes two steps, not
    one: ``ONE_LOCATION_NEARBY_PRESENCE_MODE=production`` *and* a cohort. A
    production rollout with no cohort configured stays closed, so forgetting
    the second variable fails safe rather than opening the flow to everyone.
    """

    environment = (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
    )
    mode = str(os.getenv("ONE_LOCATION_NEARBY_PRESENCE_MODE") or "").strip().lower()

    if environment in _SAFE_ENVIRONMENTS:
        if mode:
            return mode in {"uat_simulation", "production"}
        return True

    if mode != "production":
        return False
    cohort = nearby_presence_cohort()
    if cohort is None:
        return False
    if not cohort:
        return True
    return bool(user_id) and str(user_id) in cohort


class OneLocationFeatureAdmission:
    """Injectable facade over the module predicates (tests hand tools a double)."""

    def nearby_presence_enabled(self, user_id: str | None = None) -> bool:
        return nearby_presence_enabled(user_id)


__all__ = [
    "OneLocationFeatureAdmission",
    "nearby_presence_cohort",
    "nearby_presence_enabled",
]
