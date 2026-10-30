# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Typed Firebase cleanup outcomes and environment-local retention policy."""

from dataclasses import dataclass
from typing import Literal, TypedDict

from api.utils.firebase_admin import FirebaseAuthorityError, SharedFirebaseIdentityRetained

FirebaseCleanupOutcome = Literal[
    "deleted",
    "not_found",
    "protected",
    "retry_pending",
    "quarantined",
    "quarantine_incomplete",
    "identity_retained",
]
CleanupIntentKind = Literal["full_account", "phone_orphan"]


@dataclass(frozen=True, slots=True)
class FirebaseCleanupAttempt:
    outcome: FirebaseCleanupOutcome
    failure_class: str | None = None
    classification: str | None = None


class CleanupParameters(TypedDict):
    completed: bool
    identity_retained: bool
    cleanup_status: Literal["completed", "quarantined", "retry_pending"]


def cleanup_parameters(
    attempt: FirebaseCleanupAttempt, intent: CleanupIntentKind
) -> CleanupParameters:
    if intent not in {"full_account", "phone_orphan"}:
        raise ValueError("unsupported cleanup intent kind")
    if attempt.outcome == "protected" and intent != "phone_orphan":
        raise ValueError("only a provisional phone-orphan intent may be protected")
    if attempt.outcome == "identity_retained" and intent != "full_account":
        raise ValueError("only full-account cleanup may settle shared identity retention")
    completed = attempt.outcome in {"deleted", "not_found"}
    retained = attempt.outcome == "identity_retained"
    status: Literal["completed", "quarantined", "retry_pending"] = "retry_pending"
    if completed:
        status = "completed"
    elif retained or attempt.outcome == "quarantined":
        status = "quarantined"
    return {
        "completed": completed,
        "identity_retained": retained,
        "cleanup_status": status,
    }


def authority_refusal(
    error: FirebaseAuthorityError, intent: CleanupIntentKind
) -> FirebaseCleanupAttempt:
    if isinstance(error, SharedFirebaseIdentityRetained) and intent == "full_account":
        return FirebaseCleanupAttempt(
            "identity_retained", classification="firebase_shared_identity_retained"
        )
    return FirebaseCleanupAttempt("retry_pending", classification="firebase_authority_mismatch")
