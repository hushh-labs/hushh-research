"""Transactional metadata capture and provider receipts; no provider access here.

Postgres owns delivery state. A future queue adapter may replace wake-up/leases,
but must preserve transactional source admission, uniqueness and erasure fences.
"""

from __future__ import annotations

import json
import os
from datetime import datetime

from sqlalchemy import text

from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
from hushh_mcp.services.hubspot_company_client import CompanyCrmError
from hushh_mcp.services.hubspot_company_contract import activity_payload, expiry, receipt_key


def capture_enabled() -> bool:
    return (
        os.getenv("ONE_HUBSPOT_SYNC_ENABLED") == "true"
        and os.getenv("ENVIRONMENT") == "production"
        and os.getenv("GOOGLE_CLOUD_PROJECT") == "hushh-pda"
    )


def reserve_contact(conn, user_id: str):
    owner_hash = account_deletion_user_hash(user_id)
    conn.execute(
        text("""INSERT INTO one_company_crm_deliveries
      (item_id,owner_user_id,owner_hash,kind) VALUES (:id,:uid,:hash,'contact')
      ON CONFLICT(item_id) DO UPDATE SET
        state=CASE WHEN one_company_crm_deliveries.state IN ('sent','blocked') THEN 'pending'
                   ELSE one_company_crm_deliveries.state END,
        next_attempt_at=LEAST(one_company_crm_deliveries.next_attempt_at,NOW()),updated_at=NOW()
      WHERE NOT one_company_crm_deliveries.cleanup_requested"""),
        {"id": receipt_key("contact", owner_hash), "uid": user_id, "hash": owner_hash},
    )


def capture_contact(conn, user_id: str):
    if capture_enabled():
        reserve_contact(conn, user_id)


def capture_activity(
    conn,
    *,
    user_id: str,
    event_id: str,
    generation: str,
    agent_id: str,
    action_id: str,
    source: str,
    phase: str,
    observed_at: datetime,
):
    if not capture_enabled():
        return
    payload = activity_payload(
        agent_id=agent_id, action_id=action_id, source=source, phase=phase, observed_at=observed_at
    )
    conn.execute(
        text("""INSERT INTO one_company_crm_deliveries
      (item_id,owner_user_id,owner_hash,kind,generation,payload,observed_at,expires_at)
      VALUES (:id,:uid,:hash,'activity',CAST(:generation AS UUID),CAST(:payload AS JSONB),:at,:expiry)
      ON CONFLICT(item_id) DO NOTHING"""),
        {
            "id": receipt_key("activity", event_id),
            "uid": user_id,
            "hash": account_deletion_user_hash(user_id),
            "generation": generation,
            "payload": json.dumps(payload),
            "at": observed_at,
            "expiry": expiry(observed_at),
        },
    )
    reserve_contact(conn, user_id)


def erase_in_transaction(conn, user_id: str, *, permanent: bool, table_exists=None):
    # Called under existing account lifecycle locks. The permanent path already
    # recorded a tombstone, so migration201 permits owner detachment.
    exists = (
        table_exists("one_company_crm_deliveries")
        if table_exists
        else conn.execute(text("SELECT to_regclass('public.one_company_crm_deliveries')")).scalar()
    )
    if not exists:
        return
    conn.execute(
        text("""UPDATE one_company_crm_deliveries SET
        cleanup_requested=TRUE,payload='{}'::JSONB,generation=NULL,state='cleanup',
        owner_user_id=CASE WHEN :permanent THEN NULL ELSE owner_user_id END,
        next_attempt_at=NOW(),updated_at=NOW()
      WHERE owner_user_id=:uid AND (:permanent OR kind<>'contact')"""),
        {"uid": user_id, "permanent": permanent},
    )


def reserve_summary(conn, *, user_id: str, generation: str | None, now: datetime):
    owner_hash = account_deletion_user_hash(user_id)
    item_id = receipt_key("summary", f"{owner_hash}:{generation or 'registration'}")
    conn.execute(
        text("""INSERT INTO one_company_crm_deliveries
      (item_id,owner_user_id,owner_hash,kind,generation,expires_at)
      VALUES (:id,:uid,:hash,'summary',CAST(:generation AS UUID),:expiry)
      ON CONFLICT(item_id) DO UPDATE SET
        state=CASE WHEN one_company_crm_deliveries.state='sent' THEN 'pending'
                   ELSE one_company_crm_deliveries.state END,
        next_attempt_at=LEAST(one_company_crm_deliveries.next_attempt_at,NOW()),
        expires_at=:expiry,updated_at=NOW()
      WHERE NOT one_company_crm_deliveries.cleanup_requested"""),
        {
            "id": item_id,
            "uid": user_id,
            "hash": owner_hash,
            "generation": generation,
            "expiry": expiry(now),
        },
    )


def reserve_dispatch(conn, row, portal_id):
    result = conn.execute(
        text("""UPDATE one_company_crm_deliveries
      SET state='sending',attempts=attempts+1,updated_at=NOW(),portal_id=:portal,
        remote_outcome_unknown=CASE WHEN cleanup_requested THEN remote_outcome_unknown
          ELSE remote_outcome_unknown OR (remote_note_id IS NULL AND kind<>'contact')
            OR (kind='contact' AND remote_contact_id IS NULL) END
      WHERE item_id=:id AND (portal_id IS NULL OR portal_id=:portal)
      RETURNING item_id"""),
        {"portal": portal_id, "id": row["item_id"]},
    )
    if not result.fetchone():
        raise CompanyCrmError("company_receipt_portal_mismatch")


def settle(conn, row, *, note_id=None, contact_id=None, email_hash=None):
    conn.execute(
        text("""UPDATE one_company_crm_deliveries SET
      remote_note_id=COALESCE(:note,remote_note_id),
      remote_contact_id=COALESCE(:contact,remote_contact_id),
      owned_email_hash=COALESCE(:email_hash,owned_email_hash),
      state=CASE WHEN cleanup_requested THEN 'cleanup' ELSE 'sent' END,
      remote_outcome_unknown=FALSE,
      next_attempt_at=NOW(),updated_at=NOW() WHERE item_id=:id"""),
        {
            "id": row["item_id"],
            "note": note_id,
            "contact": contact_id,
            "email_hash": email_hash,
        },
    )


def record_failure(conn, row, uncertain):
    conn.execute(
        text("""UPDATE one_company_crm_deliveries SET
      remote_outcome_unknown=:uncertain,
      state=CASE WHEN :uncertain THEN 'unknown' WHEN cleanup_requested THEN 'cleanup'
                 ELSE 'blocked' END,
      next_attempt_at=NOW()+make_interval(secs=>LEAST(3600,30*GREATEST(1,attempts))),
      updated_at=NOW() WHERE item_id=:id"""),
        {"id": row["item_id"], "uncertain": uncertain},
    )
