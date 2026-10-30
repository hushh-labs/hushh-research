"""One shared, cumulative Magic rollout beneath the existing owner authority.

No policy database or identity cache. Hosted configuration is loaded at worker
startup: promotion/rollback requires a new backend revision, not just a secret edit.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.runtime_settings import (
    one_magic_intelligence_all_uat_enabled,
    one_magic_intelligence_cohorts,
    one_magic_intelligence_phase,
)
from hushh_mcp.services.one_owner_admission import firebase_record_matches_owner

PILOT_EMAIL = "parth.mawai.12@gmail.com"
_EMAIL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", re.ASCII)


def _email(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 320:
        return None
    normalized = value.strip().lower()
    return normalized if "*" not in normalized and _EMAIL.fullmatch(normalized) else None


def magic_intelligence_emails() -> frozenset[str]:
    """Invalid or incomplete promoted cohorts fail closed, including the pilot."""
    phase = one_magic_intelligence_phase()
    if phase not in {1, 2, 3, 4}:
        return frozenset()
    members = {PILOT_EMAIL}
    for raw, expected in zip(
        one_magic_intelligence_cohorts()[: phase - 1], (4, 4, 1)[: phase - 1], strict=True
    ):
        cohort = {_email(value) for value in raw}
        if len(raw) != expected or len(cohort) != expected or None in cohort or members & cohort:
            return frozenset()
        members.update(email for email in cohort if email is not None)
    return frozenset(members)


def magic_intelligence_rollout_enabled() -> bool:
    """General rollout is explicit; invalid cohort promotions remain closed."""
    return one_magic_intelligence_all_uat_enabled() or bool(magic_intelligence_emails())


def magic_intelligence_owner_admitted(user_id: str, record: Any) -> bool:
    """Use only the freshly fetched enabled owner's verified primary Firebase email.

    Normalizing case/outer whitespace never merges dots, plus aliases or domains.
    Verified phone/shadow identity remains research input, never rollout authority.
    """
    email = _email(getattr(record, "email", None))
    return (
        firebase_record_matches_owner(user_id, record)
        and getattr(record, "disabled", True) is False
        and getattr(record, "email_verified", False) is True
        and email is not None
        and (one_magic_intelligence_all_uat_enabled() or email in magic_intelligence_emails())
    )
