"""
GDPR/CCPA Compliance Engine — Data Portability and Right to Erasure.

Privacy Governance Engine by Abdul Gaffar — Beast Mode initiative.

Provides two core GDPR operations:

Data Portability (Art. 20)
    Aggregates all consent events for a user into a machine-readable JSON
    export via ``ComplianceEngine.export_user_data()``.

Right to Erasure (Art. 17)
    Hard-deletes all PII for a user via ``ComplianceEngine.forget_user()``.
    A SHA-256 anonymized tombstone is retained for audit integrity —
    Zero-Knowledge consistent (no plaintext UID in the tombstone).

Architecture
------------
    Caller
        │  export_user_data(user_id, fetch_events)
        │  forget_user(user_id, fetch_events, delete_pii, record_deletion)
        ↓
    ComplianceEngine (stateless)
        │  Resolves events via fetch_events(user_id)
        │  Delegates writes to delete_pii / record_deletion
        ↓
    UserConsentExport / ForgetMeReport (returned to caller)

All DB access is injected as async callables — fully testable without a
live database connection.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

_LABEL = "Privacy Governance Engine by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------


@dataclass
class ConsentEventRecord:
    """A single consent event as stored for a user."""

    consent_id: str
    brand_id: str
    action: str  # "GRANT" | "REVOKE"
    updated_at: int  # Unix epoch milliseconds
    metadata: Optional[dict[str, Any]] = None


@dataclass
class UserConsentExport:
    """
    Complete data export for a user — GDPR Art. 20 (Data Portability).

    ``to_dict()`` returns a JSON-serialisable representation suitable for
    direct API response or file download.
    """

    user_id: str
    exported_at: int  # Unix epoch milliseconds
    event_count: int
    events: list[ConsentEventRecord] = field(default_factory=list)
    engine: str = _LABEL

    def to_dict(self) -> dict[str, Any]:
        return {
            "user_id": self.user_id,
            "exported_at": self.exported_at,
            "event_count": self.event_count,
            "engine": self.engine,
            "events": [
                {
                    "consent_id": e.consent_id,
                    "brand_id": e.brand_id,
                    "action": e.action,
                    "updated_at": e.updated_at,
                    "metadata": e.metadata,
                }
                for e in self.events
            ],
        }


@dataclass
class ForgetMeReport:
    """
    Result of a Right-to-Erasure request — GDPR Art. 17.

    ``user_id_hash`` is the SHA-256 digest of the original user ID.  The
    plaintext UID is never stored in the tombstone — Zero-Knowledge consistent.
    """

    user_id_hash: str  # SHA-256(user_id) — anonymized, non-reversible
    deleted_event_count: int
    anonymized_at: int  # Unix epoch milliseconds
    engine: str = _LABEL

    def summary(self) -> str:
        return (
            f"[{self.engine}] user_hash={self.user_id_hash[:16]}... "
            f"deleted={self.deleted_event_count} at={self.anonymized_at}"
        )


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class ComplianceEngine:
    """
    GDPR/CCPA compliance operations with dependency-injected DB access.

    Privacy Governance Engine by Abdul Gaffar — stateless, fully testable
    without a live database connection (all DB access is injected).
    """

    async def export_user_data(
        self,
        user_id: str,
        *,
        fetch_events: Callable[[str], Awaitable[list[ConsentEventRecord]]],
    ) -> UserConsentExport:
        """
        Aggregate all consent events for ``user_id`` (GDPR Art. 20).

        Parameters
        ----------
        user_id : str
            Firebase UID of the requesting user.
        fetch_events : async callable(user_id) -> list[ConsentEventRecord]
            Returns all consent events stored for this user.

        Returns
        -------
        UserConsentExport
        """
        events = await fetch_events(user_id)
        export = UserConsentExport(
            user_id=user_id,
            exported_at=int(time.time() * 1000),
            event_count=len(events),
            events=events,
        )
        logger.info(
            "[%s] export user_id=%s event_count=%d",
            _LABEL,
            user_id,
            len(events),
        )
        return export

    async def forget_user(
        self,
        user_id: str,
        *,
        fetch_events: Callable[[str], Awaitable[list[ConsentEventRecord]]],
        delete_pii: Callable[[str], Awaitable[None]],
        record_deletion: Callable[[ForgetMeReport], Awaitable[None]],
    ) -> ForgetMeReport:
        """
        Hard-delete a user's PII and log an anonymized tombstone (GDPR Art. 17).

        Parameters
        ----------
        user_id : str
            Firebase UID of the user requesting erasure.
        fetch_events : async callable(user_id) -> list[ConsentEventRecord]
            Fetch the current event count before deletion (for the report).
        delete_pii : async callable(user_id) -> None
            Wipes all PII records tied to this user in the database.
        record_deletion : async callable(ForgetMeReport) -> None
            Persists the anonymized tombstone for audit trail.

        Returns
        -------
        ForgetMeReport
            Contains the SHA-256 hash of the user ID, the count of deleted
            events, and the anonymisation timestamp.
        """
        events = await fetch_events(user_id)
        deleted_count = len(events)

        await delete_pii(user_id)

        report = ForgetMeReport(
            user_id_hash=hashlib.sha256(user_id.encode()).hexdigest(),
            deleted_event_count=deleted_count,
            anonymized_at=int(time.time() * 1000),
        )
        await record_deletion(report)

        logger.info(
            "[%s] forget user_hash=%s deleted=%d",
            _LABEL,
            report.user_id_hash[:16],
            deleted_count,
        )
        return report


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

compliance_engine = ComplianceEngine()
