"""Shared deterministic contracts for One's onboarding journey.

This module contains policy identifiers only. It does not route actions, grant
authority, or import the product-agent runtime, so durable services and the
bounded onboarding specialist can validate the same authored setup catalog.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

SETUP_CAPABILITY_ORDER = (
    "gmail",
    "calendar",
    "location",
    "email",
    "finance",
    "ria",
    "connected-systems",
)
SETUP_CAPABILITY_IDS = frozenset(SETUP_CAPABILITY_ORDER)

# Root setup facts that use the same durable marker set without becoming
# product-agent capabilities or generated actions.
#
# `cloud` precedes `connections` because that is the product order: a person names and
# authorizes their own cloud, and only then chooses how the agent reaches a model -- by
# which point their own project's native ADC usually answers it, and a key is the
# exception rather than the front door.
#
# This tuple is the ADMISSION list, not merely a display order.
# `normalize_setup_capability_ids` filters against `SETUP_STATE_IDS` on both the read and
# the write path, so an id absent from here is dropped silently, with no error anywhere.
# That is why this constant ships before any surface that writes a `cloud` marker.
SETUP_PREREQUISITE_ORDER = ("cloud", "connections")
SETUP_STATE_ORDER = SETUP_PREREQUISITE_ORDER + SETUP_CAPABILITY_ORDER
SETUP_STATE_IDS = frozenset(SETUP_STATE_ORDER)


def normalize_setup_capability_id(value: Any) -> str | None:
    """Return a current setup capability ID or ``None`` for stale input."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate in SETUP_CAPABILITY_IDS else None


def normalize_setup_capability_ids(values: Any) -> list[str]:
    """Return current setup markers in canonical root-setup order."""
    if not isinstance(values, list):
        return []
    admitted = {
        setup_id
        for value in values
        if isinstance(value, str) and (setup_id := value.strip()) in SETUP_STATE_IDS
    }
    return [setup_id for setup_id in SETUP_STATE_ORDER if setup_id in admitted]


def normalize_setup_capability_declined_ids(values: Any) -> list[str]:
    """Return capabilities the person explicitly declined, in catalog order.

    Only the 7 optional capabilities are declinable -- the "connections"
    prerequisite is mandatory and can never appear here, so this admits
    against ``SETUP_CAPABILITY_IDS`` rather than the broader
    ``SETUP_STATE_IDS`` that ``normalize_setup_capability_ids`` uses.
    """
    if not isinstance(values, list):
        return []
    admitted = {
        setup_id
        for value in values
        if isinstance(value, str) and (setup_id := value.strip()) in SETUP_CAPABILITY_IDS
    }
    return [setup_id for setup_id in SETUP_CAPABILITY_ORDER if setup_id in admitted]


# One's conversational chat onboarding (after setup). The durable record holds
# only which questions were answered or skipped plus two calendar dates; the
# answers themselves (preferred name, reply style) live in the person's
# encrypted memory and are written client-side, never here.
ONE_CHAT_ONBOARDING_QUESTION_ORDER = ("name", "focus", "tone")
ONE_CHAT_ONBOARDING_QUESTION_IDS = frozenset(ONE_CHAT_ONBOARDING_QUESTION_ORDER)
ONE_CHAT_ONBOARDING_STATUSES = frozenset({"in_progress", "completed"})
_CALENDAR_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _normalize_calendar_date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not _CALENDAR_DATE_PATTERN.fullmatch(candidate):
        return None
    try:
        date.fromisoformat(candidate)
    except ValueError:
        return None
    return candidate


def _normalize_chat_onboarding_question_ids(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    admitted = {
        value.strip()
        for value in values
        if isinstance(value, str) and value.strip() in ONE_CHAT_ONBOARDING_QUESTION_IDS
    }
    return [question for question in ONE_CHAT_ONBOARDING_QUESTION_ORDER if question in admitted]


def normalize_one_chat_onboarding(value: Any) -> dict[str, Any] | None:
    """Return the bounded chat-onboarding progress record, or ``None``.

    Tolerant of absent or corrupt input so a bad row never breaks bootstrap.
    Unknown keys are dropped; nothing free-form survives normalization, so
    this record can never carry an answer value. A question cannot be both
    answered and skipped: answered wins, because an answer is the later,
    more specific fact.
    """
    if not isinstance(value, dict):
        return None
    if value.get("version") != 1:
        return None
    status = value.get("status")
    if status not in ONE_CHAT_ONBOARDING_STATUSES:
        return None
    answered = _normalize_chat_onboarding_question_ids(value.get("answered"))
    skipped = [
        question
        for question in _normalize_chat_onboarding_question_ids(value.get("skipped"))
        if question not in answered
    ]
    return {
        "version": 1,
        "status": status,
        "answered": answered,
        "skipped": skipped,
        "completedOn": _normalize_calendar_date(value.get("completedOn")),
        "tipDismissedOn": _normalize_calendar_date(value.get("tipDismissedOn")),
    }
