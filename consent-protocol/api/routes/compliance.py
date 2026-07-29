"""
GDPR/CCPA compliance endpoints — Data Portability and Right to Erasure.

Privacy Governance Engine by Abdul Gaffar — Beast Mode initiative.

POST   /compliance/export      — GDPR Art. 20: export all consent events
DELETE /compliance/forget-me   — GDPR Art. 17: hard-delete PII, retain
                                 anonymized tombstone for audit integrity

Authentication
--------------
Both endpoints require a valid Firebase bearer token.  The Firebase UID is
used as the user identifier — users can only access and erase their own data.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, status

from api.middleware import require_firebase_auth
from utils.compliance import (
    ConsentEventRecord,
    ForgetMeReport,
    UserConsentExport,
    compliance_engine,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/compliance", tags=["GDPR Compliance"])

_LABEL = "Privacy Governance Engine by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Stub DB helpers — replace with real ConsentDBService calls in production
# ---------------------------------------------------------------------------


async def _fetch_events_stub(user_id: str) -> list[ConsentEventRecord]:
    """
    Stub: returns empty list for all users.

    Replace with a real DB query in production::

        return await db.get_all_consent_events(user_id)
    """
    logger.info("[%s] (stub) fetch_events user_id=%s", _LABEL, user_id)
    return []


async def _delete_pii_stub(user_id: str) -> None:
    """
    Stub: logs without writing to the DB.

    Replace with a real DB DELETE in production::

        await db.delete_all_consent_records(user_id)
    """
    logger.info("[%s] (stub) delete_pii user_id=%s", _LABEL, user_id)


async def _record_deletion_stub(report: ForgetMeReport) -> None:
    """
    Stub: logs the tombstone without persisting it.

    Replace with a real DB INSERT in production::

        await db.insert_anonymized_tombstone(report.user_id_hash, report.deleted_event_count)
    """
    logger.info("[%s] (stub) record_deletion %s", _LABEL, report.summary())


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/export",
    summary="Export all consent data for the authenticated user (GDPR Art. 20)",
)
async def export_user_data(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict:
    """
    Return a complete, machine-readable export of the authenticated user's
    consent history.

    **Authentication:** Firebase bearer token.

    **Format:** JSON with ``user_id``, ``exported_at`` (ms), ``event_count``,
    and a full ``events`` array.

    Signed: Privacy Governance Engine by Abdul Gaffar
    """
    export: UserConsentExport = await compliance_engine.export_user_data(
        firebase_uid,
        fetch_events=_fetch_events_stub,
    )
    return export.to_dict()


@router.delete(
    "/forget-me",
    status_code=status.HTTP_200_OK,
    summary="Erase all PII for the authenticated user (GDPR Art. 17)",
)
async def forget_me(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict:
    """
    Hard-delete all personally identifiable data for the authenticated user.

    An anonymized tombstone (SHA-256 of user ID, event count, timestamp) is
    retained for system integrity — Zero-Knowledge consistent: the original
    user ID is never stored in the tombstone.

    **Authentication:** Firebase bearer token.

    Signed: Privacy Governance Engine by Abdul Gaffar
    """
    report: ForgetMeReport = await compliance_engine.forget_user(
        firebase_uid,
        fetch_events=_fetch_events_stub,
        delete_pii=_delete_pii_stub,
        record_deletion=_record_deletion_stub,
    )
    return {
        "user_id_hash": report.user_id_hash,
        "deleted_event_count": report.deleted_event_count,
        "anonymized_at": report.anonymized_at,
        "engine": report.engine,
        "summary": report.summary(),
    }
