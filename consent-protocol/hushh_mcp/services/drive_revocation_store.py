"""Explicit owner review for removal of recorded, current individual Viewer ACLs.

Revocation does not require a retained document index or an active relationship
with the recipient. It does require the same verified Google issuer after
reconnection. Google exposes grantee IDs, not immutable grant-instance IDs;
the disclosure therefore authorizes removal of the current matching direct ACL.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore, DocumentReviewAuthority
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_sharing_contract import MAX_FILES, DriveSharingError

REVOCATION_ACTION = {
    "action_id": "documents.revoke_shared_access",
    "version": 1,
    "execution_policy": "confirm_required",
    "activation_policy": "trusted_activation_required",
    "disclosure": "remove-current-recorded-direct-viewer-v1",
}


class DriveRevocationStore(DrivePermissionStore):
    def _request_source_kind(self, connection, user_id, request_id):
        grant = self._row(
            connection,
            """SELECT * FROM drive_share_permission_operations
               WHERE user_id=:user AND request_id=:request AND kind='grant' AND state='succeeded'
               ORDER BY created_at DESC LIMIT 1""",
            {"user": user_id, "request": request_id},
        )
        if grant:
            return self._plan(grant).get("source_kind")
        bulk = self._row(
            connection,
            """SELECT share_id FROM drive_bulk_shares
               WHERE user_id=:user AND origin_request_id=:request LIMIT 1""",
            {"user": user_id, "request": request_id},
        )
        return "live" if bulk else None

    def _management(self, connection, user_id, generation, request_id, *, stop_review=False):
        self._owner_gate(connection, user_id)
        context = self._management_context(connection, user_id, request_id)
        if stop_review:
            # Stopping future grants is allowed even while Drive is
            # disconnected. Actual ACL deletion waits for the same Google
            # issuer to reconnect and is never reported as completed early.
            return context
        if self._request_source_kind(connection, user_id, request_id) == "live":
            DriveLivePreferences(db=self.db).live_active(
                connection, user_id=user_id, generation=generation, management=True
            )
        else:
            self._active(connection, user_id, generation)
            # New grants may be disabled while an owner still removes recorded ACLs.
            self._selection_policy(connection, user_id, feature="google_drive_connection")
        return context

    def _receipt(self, row):
        if not row.get("receipt_envelope"):
            raise DriveSharingError("permission_not_managed")
        return self.sharing_cipher.open(
            row["receipt_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["operation_id"]),
            purpose="permission-receipt",
        )

    def _revocable(self, connection, *, user_id, request_id):
        if connection.execute(
            text("""
            SELECT EXISTS(SELECT 1 FROM drive_share_permission_operations WHERE user_id=:user
              AND request_id=:request AND kind='revoke' AND state IN ('queued','dispatching','unknown'))
        """),
            {"user": user_id, "request": request_id},
        ).scalar_one():
            raise DriveSharingError("revocation_pending")
        rows = (
            connection.execute(
                text("""
            SELECT g.* FROM drive_share_permission_operations g
            WHERE g.user_id=:user AND g.request_id=:request AND g.kind='grant' AND g.state='succeeded'
              AND NOT EXISTS (SELECT 1 FROM drive_share_permission_operations r
                WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
                  AND r.state IN ('queued','dispatching','unknown','succeeded','absent'))
            ORDER BY g.operation_id LIMIT :limit FOR UPDATE OF g
        """),
                {"user": user_id, "request": request_id, "limit": MAX_FILES + 1},
            )
            .mappings()
            .all()
        )
        if len(rows) > MAX_FILES:
            raise DriveSharingError("no_revocable_permissions")
        terms = []
        for item in rows:
            row = dict(item)
            receipt, plan = self._receipt(row), self._plan(row)
            created, issuer = receipt.get("created"), receipt.get("issuer")
            if (
                receipt.get("managed") is not True
                or not isinstance(created, dict)
                or not isinstance(issuer, dict)
                or not issuer.get("subject")
                or not issuer.get("oauthClientId")
                or not created.get("permission_id")
                or created.get("email", "").casefold() != plan["recipient"]["email"].casefold()
            ):
                raise DriveSharingError("permission_not_managed")
            terms.append(
                {
                    "grant_operation_id": str(row["operation_id"]),
                    "document_id": str(row["document_id"]),
                    "review_revision": row["review_revision"],
                    "file_lock_hmac": row["file_lock_hmac"],
                    "file_id": plan["file_id"],
                    "file_name": plan["file_name"],
                    "permission_id": created["permission_id"],
                    "recipient_email": created["email"],
                    "issuer": issuer,
                    "source_kind": plan.get("source_kind", "indexed"),
                }
            )
        return terms

    def _bulk_counts(self, connection, *, user_id, request_id):
        row = self._row(
            connection,
            """SELECT count(*) AS total,
              count(*) FILTER (WHERE e.state='succeeded') AS succeeded,
              count(*) FILTER (WHERE e.state IN ('queued','dispatching','unknown')) AS pending,
              max(e.updated_at) AS latest
              FROM drive_bulk_share_effects e
              JOIN drive_bulk_shares b ON b.share_id=e.share_id
              WHERE b.user_id=:user AND b.origin_request_id=:request""",
            {"user": user_id, "request": request_id},
        )
        return {
            "total": row["total"],
            "succeeded": row["succeeded"],
            "pending": row["pending"],
            "latest": row["latest"].isoformat() if row["latest"] else None,
        }

    @staticmethod
    def _paid_frozen_batch(connection, *, user_id, request_id):
        """A paid request can be stopped before approval creates any effects."""
        return connection.execute(
            text("""SELECT EXISTS (
              SELECT 1 FROM drive_share_requests r
              JOIN drive_request_payment_orders o ON o.request_id=r.request_id
              JOIN drive_bulk_shares b ON b.origin_request_id=r.request_id
                AND b.user_id=r.user_id AND b.origin_request_revision=r.revision
              JOIN drive_bulk_share_recipients recipient ON recipient.share_id=b.share_id
                AND recipient.recipient_user_id=r.recipient_user_id
              WHERE r.request_id=:request AND r.user_id=:user
                AND r.status='pending' AND r.payment_required=TRUE
                AND r.access_stop_requested_at IS NULL
                AND r.expires_at>clock_timestamp()
                AND o.status='paid' AND o.reconciliation_required=FALSE
                AND b.progressive_batch=TRUE AND b.status='review_ready'
                AND b.approved_at IS NULL AND b.expires_at>clock_timestamp()
                AND b.file_count>0 AND b.recipient_count=1
            )"""),
            {"user": user_id, "request": request_id},
        ).scalar_one()

    @staticmethod
    def _revoke_authority(user_id, request_id, revision, generation, grants, bulk=None):
        terms = {
            "owner": user_id,
            "request": request_id,
            "revision": revision,
            "generation": generation,
            "grants": grants,
            "bulk": bulk,
        }
        return DocumentReviewAuthority(
            user_id=user_id,
            request_id=request_id,
            revision=revision,
            action_contract=REVOCATION_ACTION,
            slots={"revocation": terms},
            resource_binding=terms,
        )

    async def prepare_revocation(self, *, user_id, generation, request_id):
        """Vault Owner only. Private response must not enter a cache or tool history."""
        request_id = str(UUID(request_id))

        def operation(connection):
            request = self._management(
                connection, user_id, generation, request_id, stop_review=True
            )
            active = self._row(
                connection,
                """SELECT access_stop_requested_at FROM drive_share_requests
                  WHERE request_id=:request AND user_id=:user""",
                {"request": request_id, "user": user_id},
            )
            if active and active["access_stop_requested_at"] is not None:
                raise DriveSharingError("revocation_pending")
            grants = self._revocable(connection, user_id=user_id, request_id=request_id)
            bulk = self._bulk_counts(connection, user_id=user_id, request_id=request_id)
            if (
                not grants
                and not bulk["total"]
                and not self._paid_frozen_batch(connection, user_id=user_id, request_id=request_id)
            ):
                raise DriveSharingError("no_revocable_permissions")
            revision = request["revocation_revision"] + 1
            connection.execute(
                text("""
                UPDATE drive_share_management_contexts SET revocation_revision=:revision WHERE request_id=:request
            """),
                {"revision": revision, "request": request_id},
            )
            authority = self._revoke_authority(
                user_id, request_id, revision, generation, grants, bulk
            )
            directive = ActionDirectiveStore(
                connection=connection, hmac_key=self.authority_key
            ).issue_document_review_in_transaction(authority)
            return {
                "requestId": request_id,
                "revision": revision,
                "generation": generation,
                "directiveId": directive.directive_id,
                "expiresAt": directive.expires_at.isoformat(),
                "reviewDigest": self.sharing_cipher.digest(
                    "revocation", authority.resource_binding
                ),
                "disclosure": REVOCATION_ACTION["disclosure"],
                "otherAccessMayRemain": True,
                "affectedCount": len(grants) + bulk["succeeded"],
                "pendingCount": bulk["pending"],
                "files": [
                    {
                        "grantId": grant["grant_operation_id"],
                        "name": grant["file_name"],
                        "recipientEmail": grant["recipient_email"],
                    }
                    for grant in grants
                ],
            }

        return await self._transaction(operation)

    async def confirm_revocation(
        self,
        *,
        user_id,
        generation,
        request_id,
        revision,
        directive_id,
        review_digest,
        grant_ids,
        confirmed,
    ):
        if confirmed is not True:
            raise DriveSharingError("confirmation_required")
        request_id = str(UUID(request_id))

        def operation(connection):
            request = self._management(
                connection, user_id, generation, request_id, stop_review=True
            )
            if request["revocation_revision"] != revision:
                raise DriveSharingError("review_changed")
            grants = self._revocable(connection, user_id=user_id, request_id=request_id)
            bulk = self._bulk_counts(connection, user_id=user_id, request_id=request_id)
            if (
                not grants
                and not bulk["total"]
                and not self._paid_frozen_batch(connection, user_id=user_id, request_id=request_id)
            ):
                raise DriveSharingError("no_revocable_permissions")
            authority = self._revoke_authority(
                user_id, request_id, revision, generation, grants, bulk
            )
            if (
                len(grant_ids) != len(set(grant_ids))
                or set(grant_ids) != {g["grant_operation_id"] for g in grants}
                or review_digest
                != self.sharing_cipher.digest("revocation", authority.resource_binding)
            ):
                raise DriveSharingError("review_changed")
            ledger = ActionDirectiveStore(connection=connection, hmac_key=self.authority_key)
            confirmed_receipt = ledger.confirm_document_review_in_transaction(
                directive_id=directive_id, authority=authority, trusted_activation=True
            )
            batch = ledger.claim_document_review_in_transaction(
                directive_id=directive_id, authority=authority, receipt=confirmed_receipt.receipt
            )
            # This transition precedes all later provider removals. A grant
            # already dispatched may still settle; the removal sweep discovers
            # its receipt and cleans it up after the fact.
            connection.execute(
                text("""UPDATE drive_share_requests
                  SET access_stop_requested_at=COALESCE(access_stop_requested_at,clock_timestamp()),
                    updated_at=clock_timestamp()
                  WHERE request_id=:request AND user_id=:user"""),
                {"request": request_id, "user": user_id},
            )
            ids = []
            for grant in grants:
                identifier = str(uuid4())
                envelope = self.sharing_cipher.seal(
                    {**grant, "revocation_revision": revision, "request_stop": True},
                    user_id=user_id,
                    resource_id=identifier,
                    purpose="permission-plan",
                )
                connection.execute(
                    text("""
                    INSERT INTO drive_share_permission_operations(operation_id,user_id,request_id,
                      review_revision,batch_id,document_id,connection_generation,file_lock_hmac,kind,
                      parent_operation_id,plan_envelope)
                    VALUES (:id,:user,:request,:review,:batch,:document,:generation,:lock,'revoke',
                      :parent,CAST(:plan AS jsonb))
                """),
                    {
                        "id": identifier,
                        "user": user_id,
                        "request": request_id,
                        "review": grant["review_revision"],
                        "batch": batch,
                        "document": grant["document_id"],
                        "generation": generation,
                        "lock": grant["file_lock_hmac"],
                        "parent": grant["grant_operation_id"],
                        "plan": json.dumps(envelope),
                    },
                )
                ids.append(identifier)
            return {
                "requestId": request_id,
                "revocationStatus": "pending",
                "operationIds": ids,
                "bulkPending": bulk["succeeded"] + bulk["pending"],
                "otherAccessMayRemain": True,
            }

        return await self._transaction(operation)

    def _grant_authority(self, connection, initial):
        if initial["kind"] == "grant":
            return super()._grant_authority(connection, initial)
        current_generation = self._row(
            connection,
            """SELECT connection_generation FROM user_external_connector_connections
              WHERE user_id=:user AND connector_id='google_drive'""",
            {"user": initial["user_id"]},
        )
        if not current_generation:
            raise DriveSharingError("reconnect_required")
        request = self._management(
            connection,
            initial["user_id"],
            current_generation["connection_generation"],
            str(initial["request_id"]),
        )
        plan = self._plan(initial)
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        parent = self._permission(
            connection, initial["user_id"], str(initial["parent_operation_id"]), lock=True
        )
        if (
            request["revocation_revision"] != plan["revocation_revision"]
            or not plan.get("request_stop")
            and (now - initial["created_at"]).total_seconds() > 300
            or not parent
            or parent["kind"] != "grant"
            or parent["state"] != "succeeded"
            or self._receipt(parent).get("managed") is not True
        ):
            raise DriveSharingError("approval_superseded")
        return plan

    async def claim_revoke(self, *, user_id, operation_id):
        return await self._claim_queued(user_id=user_id, operation_id=operation_id, kind="revoke")

    async def materialize_late_legacy(self, *, limit=25):
        """Catch a Google create that settled after the owner confirmed Stop."""
        if type(limit) is not int or not 1 <= limit <= MAX_FILES:
            raise ValueError("invalid legacy removal bound")

        def operation(connection):
            rows = connection.execute(
                text("""SELECT g.*,m.revocation_revision
                  FROM drive_share_permission_operations g
                  JOIN drive_share_requests request ON request.request_id=g.request_id
                    AND request.user_id=g.user_id
                  JOIN drive_share_management_contexts m ON m.request_id=g.request_id
                    AND m.user_id=g.user_id
                  WHERE g.kind='grant' AND g.state='succeeded'
                    AND request.access_stop_requested_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM drive_share_permission_operations r
                      WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
                        AND r.state IN ('queued','dispatching','unknown','succeeded','absent'))
                  ORDER BY g.updated_at,g.operation_id LIMIT :limit FOR UPDATE OF g SKIP LOCKED"""),
                {"limit": limit},
            ).mappings()
            count = 0
            for item in rows:
                grant = dict(item)
                receipt, plan = self._receipt(grant), self._plan(grant)
                created, issuer = receipt.get("created"), receipt.get("issuer")
                if (
                    receipt.get("managed") is not True
                    or not isinstance(created, dict)
                    or not isinstance(issuer, dict)
                    or not created.get("permission_id")
                    or created.get("email", "").casefold() != plan["recipient"]["email"].casefold()
                ):
                    continue
                removal = str(uuid4())
                terms = {
                    "grant_operation_id": str(grant["operation_id"]),
                    "document_id": str(grant["document_id"]),
                    "review_revision": grant["review_revision"],
                    "file_lock_hmac": grant["file_lock_hmac"],
                    "file_id": plan["file_id"],
                    "file_name": plan["file_name"],
                    "permission_id": created["permission_id"],
                    "recipient_email": created["email"],
                    "issuer": issuer,
                    "source_kind": plan.get("source_kind", "indexed"),
                    "revocation_revision": grant["revocation_revision"],
                    "request_stop": True,
                }
                envelope = self.sharing_cipher.seal(
                    terms,
                    user_id=grant["user_id"],
                    resource_id=removal,
                    purpose="permission-plan",
                )
                connection.execute(
                    text("""INSERT INTO drive_share_permission_operations
                      (operation_id,user_id,request_id,review_revision,batch_id,
                       document_id,connection_generation,file_lock_hmac,kind,
                       parent_operation_id,plan_envelope)
                      VALUES (:id,:user,:request,:review,:batch,:document,:generation,
                       :lock,'revoke',:parent,CAST(:plan AS jsonb))
                      ON CONFLICT DO NOTHING"""),
                    {
                        "id": removal,
                        "user": grant["user_id"],
                        "request": grant["request_id"],
                        "review": grant["review_revision"],
                        "batch": f"request-stop:{grant['revocation_revision']}",
                        "document": grant["document_id"],
                        "generation": grant["connection_generation"],
                        "lock": grant["file_lock_hmac"],
                        "parent": grant["operation_id"],
                        "plan": json.dumps(envelope),
                    },
                )
                count += 1
            return count

        return await self._transaction(operation)
