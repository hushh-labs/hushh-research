"""Finite company CRM drain. Run under Scheduler, never on a person's login path.

The source is the existing product ledger and registered-account projection.
Only receipt metadata survives account erasure, until external cleanup is proven.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from typing import TypedDict

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services import hubspot_company_projection as projection
from hushh_mcp.services import hubspot_company_store as store
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
)
from hushh_mcp.services.hubspot_company_client import CompanyCrmError, HubSpotCompanyClient
from hushh_mcp.services.hubspot_company_contract import (
    contact_properties,
    receipt_key,
)
from hushh_mcp.services.hubspot_company_store import (
    reserve_summary,
)
from hushh_mcp.services.plg_audience import _identity

LOCK_KEY = 433001


class RunCounts(TypedDict):
    processed: int
    deferred: int
    busy: bool
    mapping_blocked: bool
    failure_codes: dict[str, int]


def check_lane():
    if os.getenv("ENVIRONMENT") != "production" or os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda":
        raise CompanyCrmError("company_sync_wrong_environment")


class HubSpotCompanySync:
    def __init__(self, client: HubSpotCompanyClient, *, connect=get_db_connection):
        self.client = client
        self.connect = connect

    _check_lane = staticmethod(check_lane)

    def _active_owner(self, conn, uid: str) -> bool:
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[uid])
        return bool(
            conn.execute(
                text("""SELECT EXISTS(SELECT 1 FROM actor_profiles
          WHERE user_id=:uid) AND NOT EXISTS(SELECT 1 FROM account_deletion_tombstones
          WHERE user_id_hash=:hash)"""),
                {"uid": uid, "hash": account_deletion_user_hash(uid)},
            ).scalar()
        )

    def _scan_accounts(self):
        return projection.scan_accounts(self.connect, self._active_owner)

    def _maintenance(self):
        return projection.maintenance(self.connect)

    def _scan_activity(self):
        return projection.scan_activity(self.connect, self._active_owner, self._transaction_bounds)

    def _rows(self, *, cleanup: bool, limit: int):
        return projection.due_rows(self.connect, cleanup=cleanup, limit=limit)

    def _reserve_dispatch(self, row):
        with self.connect() as conn:
            store.reserve_dispatch(conn, row, self.client.portal_id)

    def _settle(self, conn, row, *, note_id=None, contact_id=None, email_hash=None):
        store.settle(conn, row, note_id=note_id, contact_id=contact_id, email_hash=email_hash)

    def _failure(self, row, error: CompanyCrmError):
        with self.connect() as conn:
            store.record_failure(conn, row, error.uncertain or row["remote_outcome_unknown"])

    def _cleanup(self, conn, row):
        if row["kind"] == "contact":
            # Also resolves an unknown contact-create outcome by the stable hash.
            found = self.client.clear_owned_contact(
                row["owner_hash"], row["owned_email_hash"], row["remote_contact_id"]
            )
            if not found and row["remote_outcome_unknown"]:
                raise CompanyCrmError("company_contact_cleanup_unconfirmed", uncertain=True)
        else:
            note_id = row["remote_note_id"] or self.client.find_note(row["item_id"])
            if note_id:
                self.client.delete_note(note_id)
            elif row["remote_outcome_unknown"]:
                # Search indexing can lag. Missing is not proof an unknown POST
                # failed; retain an opaque cleanup obligation, never recreate it.
                raise CompanyCrmError("company_cleanup_unconfirmed", uncertain=True)
        conn.execute(
            text("DELETE FROM one_company_crm_deliveries WHERE item_id=:id"), {"id": row["item_id"]}
        )

    _fetch_record = staticmethod(projection.fetch_record)

    def _sync_contact(self, conn, row, record):
        identity = (
            conn.execute(
                text("""SELECT display_name,email,email_verified,phone_number,
          phone_verified,updated_at FROM actor_identity_cache WHERE user_id=:uid"""),
                {"uid": row["owner_user_id"]},
            )
            .mappings()
            .first()
        )
        identity = _identity(record, dict(identity) if identity else None, None)
        properties = contact_properties(record, row["owner_hash"])

        def prepare_create(email_hash):
            if row["state"] == "unknown":
                raise CompanyCrmError("company_contact_outcome_unknown", uncertain=True)
            # Commit the intended email ownership before the remote request. A
            # lost response must still allow erasing only our unchanged value.
            conn.execute(
                text("""UPDATE one_company_crm_deliveries SET
                  owned_email_hash=COALESCE(owned_email_hash,:hash) WHERE item_id=:id"""),
                {"hash": email_hash, "id": row["item_id"]},
            )
            # Commit on this connection rather than waiting for a second
            # connection's shared lock behind a queued deletion writer.
            conn.commit()
            self._transaction_bounds(conn)
            if not self._active_owner(conn, row["owner_user_id"]):
                raise CompanyCrmError("company_owner_unavailable")
            if (
                conn.execute(
                    text(
                        "SELECT cleanup_requested FROM one_company_crm_deliveries WHERE item_id=:id"
                    ),
                    {"id": row["item_id"]},
                ).scalar()
                is not False
            ):
                raise CompanyCrmError("company_owner_unavailable")
            latest = (
                conn.execute(
                    text("""SELECT display_name,email,email_verified,phone_number,
              phone_verified,updated_at FROM actor_identity_cache WHERE user_id=:uid"""),
                    {"uid": row["owner_user_id"]},
                )
                .mappings()
                .first()
            )
            latest = _identity(record, dict(latest) if latest else None, None)
            if (latest["email"], latest["emailVerified"]) != (
                identity["email"],
                identity["emailVerified"],
            ):
                raise CompanyCrmError("company_identity_changed")

        contact_id, owned_email = self.client.ensure_contact(
            properties,
            email=identity["email"],
            verified_email=identity["emailVerified"],
            prepare_create=prepare_create,
        )
        self._settle(conn, row, contact_id=contact_id, email_hash=owned_email)
        generation = conn.execute(
            text("SELECT generation FROM one_product_activity_epochs WHERE user_id=:uid"),
            {"uid": row["owner_user_id"]},
        ).scalar()
        reserve_summary(
            conn,
            user_id=row["owner_user_id"],
            generation=str(generation) if generation else None,
            now=datetime.now(UTC),
        )
        return contact_id

    _note_content = staticmethod(projection.note_content)

    @staticmethod
    def _transaction_bounds(conn):
        conn.execute(text("SET LOCAL lock_timeout='1s'"))
        conn.execute(text("SET LOCAL statement_timeout='4s'"))
        conn.execute(text("SET LOCAL idle_in_transaction_session_timeout='20s'"))

    def _dispatch(self, row):
        # Firebase network lookup must not hold account-erasure barriers.
        record = (
            self._fetch_record(row["owner_user_id"])
            if row["kind"] == "contact" and not row["cleanup_requested"]
            else None
        )
        self.client.deadline = time.monotonic() + 12
        self._reserve_dispatch(row)
        with self.connect() as conn:
            self._transaction_bounds(conn)
            if row["owner_user_id"]:
                active = self._active_owner(conn, row["owner_user_id"])
            else:
                active = False
            current = (
                conn.execute(
                    text("SELECT * FROM one_company_crm_deliveries WHERE item_id=:id"),
                    {"id": row["item_id"]},
                )
                .mappings()
                .first()
            )
            if not current:
                return
            current = dict(current)
            current["state"] = row["state"]
            if current["cleanup_requested"]:
                # Preserve pre-reservation uncertainty for safe reconciliation.
                self._cleanup(conn, current)
                return
            if not active:
                raise CompanyCrmError("company_owner_unavailable")
            if current["kind"] == "contact":
                self._sync_contact(conn, current, record)
                return
            generation = conn.execute(
                text("SELECT generation FROM one_product_activity_epochs WHERE user_id=:uid"),
                {"uid": current["owner_user_id"]},
            ).scalar()
            if generation != current["generation"] or current["expires_at"] <= datetime.now(UTC):
                raise CompanyCrmError("company_epoch_or_retention_changed")
            contact = conn.execute(
                text("""SELECT remote_contact_id FROM one_company_crm_deliveries
              WHERE item_id=:id AND NOT cleanup_requested AND state='sent'"""),
                {"id": receipt_key("contact", current["owner_hash"])},
            ).scalar()
            if not contact:
                raise CompanyCrmError("company_contact_pending")
            timestamp, body = self._note_content(conn, current)
            note_id = current["remote_note_id"] or self.client.find_note(current["item_id"])
            if note_id and current["kind"] == "summary":
                self.client.update_note(note_id, timestamp, body)
            elif not note_id:
                if row["remote_outcome_unknown"]:
                    raise CompanyCrmError("company_note_outcome_unknown", uncertain=True)
                note_id = self.client.create_note(str(contact), timestamp, body)
            self._settle(conn, current, note_id=note_id, contact_id=str(contact))

    def run(self, *, budget_seconds=100, limit=50) -> RunCounts:
        self._check_lane()
        self.client.deadline = None
        self.client.verify_portal()
        mapping_ready = True
        try:
            self.client.verify_mapping()
        except CompanyCrmError:
            # Mapping drift blocks new deliveries, never erasure of known notes.
            mapping_ready = False
        end = time.monotonic() + min(max(budget_seconds, 1), 120)
        counts: RunCounts = {
            "processed": 0,
            "deferred": 0,
            "busy": False,
            "mapping_blocked": not mapping_ready,
            "failure_codes": {},
        }
        with self.connect() as lock:
            if not lock.execute(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": LOCK_KEY}
            ).scalar():
                return {**counts, "busy": True}
            lock.commit()
            try:
                self._maintenance()
                enabled = os.getenv("ONE_HUBSPOT_SYNC_ENABLED") == "true" and mapping_ready
                if enabled:
                    self._scan_accounts()
                    self._scan_activity()
                # Cleanup remains live even after collection/delivery is disabled.
                for cleanup in (True, False) if enabled else (True,):
                    for row in self._rows(cleanup=cleanup, limit=min(max(limit, 1), 100)):
                        if time.monotonic() >= end:
                            return counts
                        try:
                            self._dispatch(row)
                            counts["processed"] += 1
                        except CompanyCrmError as error:
                            self._failure(row, error)
                            counts["deferred"] += 1
                            code = str(error)
                            counts["failure_codes"][code] = counts["failure_codes"].get(code, 0) + 1
            finally:
                lock.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": LOCK_KEY})
        return counts
