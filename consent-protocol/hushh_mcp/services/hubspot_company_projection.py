"""Bounded reads from canonical identity and activity sources; no delivery authority."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.hubspot_company_client import CompanyCrmError
from hushh_mcp.services.hubspot_company_contract import activity_note, summary_note
from hushh_mcp.services.hubspot_company_store import capture_activity, reserve_contact
from hushh_mcp.services.plg_audience import _registered


def scan_accounts(connect, active_owner):
    with connect() as conn:
        cursor = conn.execute(
            text("SELECT owner_cursor FROM one_company_crm_cursor WHERE destination='hubspot'")
        ).scalar()
    with connect() as conn:
        conn.execute(text("SET LOCAL lock_timeout='1s'"))
        # Traverse immutable application owners, including replacement accounts.
        # Firebase UID -> latest owner resolution is never valid for a job.
        owners = list(
            conn.execute(
                text("""SELECT user_id FROM actor_profiles
          WHERE user_id>COALESCE(:cursor,'') ORDER BY user_id LIMIT 25"""),
                {"cursor": cursor},
            ).scalars()
        )
        for owner in owners:
            if active_owner(conn, owner):
                reserve_contact(conn, owner)
        conn.execute(
            text("""UPDATE one_company_crm_cursor SET owner_cursor=:cursor,
          updated_at=NOW() WHERE destination='hubspot'"""),
            {"cursor": owners[-1] if len(owners) == 25 else None},
        )


def maintenance(connect):
    with connect() as conn:
        conn.execute(text("SET LOCAL statement_timeout='4s'"))
        conn.execute(text("SET LOCAL lock_timeout='1s'"))
        # A previous process lost its response/commit. Reconcile before another
        # create. The session lock proves there is no live competing worker.
        conn.execute(
            text("""UPDATE one_company_crm_deliveries SET state='unknown'
          WHERE state='sending'""")
        )

        conn.execute(
            text("""UPDATE one_company_crm_deliveries d SET
          cleanup_requested=TRUE,payload='{}'::JSONB,generation=NULL,
          state='cleanup',next_attempt_at=NOW(),updated_at=NOW()
          WHERE NOT cleanup_requested AND kind<>'contact' AND (
            expires_at<=NOW() OR owner_user_id IS NULL OR NOT EXISTS(
              SELECT 1 FROM one_product_activity_epochs e WHERE e.user_id=d.owner_user_id
              AND e.generation IS NOT DISTINCT FROM d.generation)
            AND NOT (d.generation IS NULL AND NOT EXISTS(
              SELECT 1 FROM one_product_activity_epochs e WHERE e.user_id=d.owner_user_id)))""")
        )


def scan_activity(connect, active_owner, transaction_bounds):
    # Copy bounded accepted metadata from the existing seven-day ledger.
    # This runs off the login/observation path and shares its epoch fences.
    with connect() as conn:
        transaction_bounds(conn)
        rows = list(
            conn.execute(
                text("""SELECT o.* FROM one_product_activity_observations o
          JOIN one_product_activity_epochs e ON e.user_id=o.user_id AND e.generation=o.generation
          JOIN actor_profiles a ON a.user_id=o.user_id
          WHERE o.expires_at>NOW() AND NOT EXISTS (
            SELECT 1 FROM account_deletion_tombstones t
            WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(o.user_id,'UTF8')),'hex'))
          AND NOT EXISTS (SELECT 1 FROM one_company_crm_deliveries d WHERE
            d.item_id=encode(sha256(convert_to('one-company-crm:v1:activity:'||o.event_id,'UTF8')),'hex'))
          ORDER BY o.observed_at,o.event_id LIMIT 100""")
            ).mappings()
        )
        for row in rows:
            if active_owner(conn, row["user_id"]):
                if not conn.execute(
                    text("""SELECT EXISTS(
                  SELECT 1 FROM one_product_activity_observations o
                  JOIN one_product_activity_epochs e ON e.user_id=o.user_id AND e.generation=o.generation
                  WHERE o.event_id=:event AND o.generation=CAST(:generation AS UUID))"""),
                    {"event": row["event_id"], "generation": str(row["generation"])},
                ).scalar():
                    continue
                capture_activity(
                    conn,
                    user_id=row["user_id"],
                    event_id=row["event_id"],
                    generation=str(row["generation"]),
                    agent_id=row["agent_id"],
                    action_id=row["action_id"],
                    source=row["source"],
                    phase=row["phase"],
                    observed_at=row["observed_at"],
                )


def due_rows(connect, *, cleanup: bool, limit: int):
    with connect() as conn:
        rows = conn.execute(
            text("""SELECT * FROM (
            SELECT d.*,ROW_NUMBER() OVER (
              PARTITION BY kind ORDER BY next_attempt_at,observed_at,item_id) AS delivery_slot
            FROM one_company_crm_deliveries d
          WHERE next_attempt_at<=NOW() AND cleanup_requested=:cleanup
            AND state IN ('pending','unknown','cleanup','blocked')
          ) AS due
          ORDER BY delivery_slot,
            CASE kind WHEN 'contact' THEN 0 WHEN 'activity' THEN 1 ELSE 2 END,
            observed_at,item_id LIMIT :limit"""),
            {"cleanup": cleanup, "limit": limit},
        )
        return [dict(row) for row in rows.mappings()]


def fetch_record(user_id):
    from firebase_admin import auth
    from firebase_admin.exceptions import FirebaseError

    from api.utils.firebase_admin import get_firebase_auth_app
    from hushh_mcp.services.account_generation_service import (
        AccountGenerationRefused,
        AccountGenerationService,
    )

    app = get_firebase_auth_app()
    if app is None or app.project_id != "hushh-pda":
        raise CompanyCrmError("company_identity_source_unavailable")
    try:
        identity = AccountGenerationService.firebase_identity_for_owner(user_id)
        record = auth.get_user(identity, app=app)
    except auth.UserNotFoundError:
        # Firebase absence alone does not grant CRM erasure authority.
        raise CompanyCrmError("company_identity_source_missing") from None
    except (AccountGenerationRefused, FirebaseError):
        raise CompanyCrmError("company_identity_read_unavailable") from None
    if not _registered(record):
        raise CompanyCrmError("company_identity_ineligible")
    return record


def note_content(conn, row):
    if row["kind"] == "activity":
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return activity_note(row["item_id"], payload)
    rows = (
        conn.execute(
            text("""SELECT payload->>'agentId' AS agent,
      payload->>'phase' AS phase,COUNT(*) AS count,MAX(observed_at) AS last_at
      FROM one_company_crm_deliveries WHERE owner_user_id=:uid AND kind='activity'
        AND NOT cleanup_requested AND expires_at>NOW()
      GROUP BY payload->>'agentId',payload->>'phase'"""),
            {"uid": row["owner_user_id"]},
        )
        .mappings()
        .all()
    )
    completed = conn.execute(
        text("SELECT setup_completed FROM vault_keys WHERE user_id=:uid"),
        {"uid": row["owner_user_id"]},
    ).scalar()
    last_at = max((r["last_at"] for r in rows), default=None)
    return summary_note(
        row["item_id"],
        counts={f"{r['agent']} / {r['phase']}": r["count"] for r in rows},
        last_at=last_at,
        setup_completed=completed,
        as_of=datetime.now(UTC),
    )
