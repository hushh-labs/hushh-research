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
    def _management(self, connection, user_id, generation, request_id):
        self._participant_gate(connection, user_id, request_id)
        self._active(connection, user_id, generation)
        # New grants may be disabled while an owner still removes recorded ACLs.
        self._selection_policy(connection, user_id, feature="google_drive_connection")
        return self._request(connection, user_id, request_id)

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
        if not rows or len(rows) > MAX_FILES:
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
                }
            )
        return terms

    @staticmethod
    def _revoke_authority(user_id, request_id, revision, generation, grants):
        terms = {
            "owner": user_id,
            "request": request_id,
            "revision": revision,
            "generation": generation,
            "grants": grants,
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
            request = self._management(connection, user_id, generation, request_id)
            grants = self._revocable(connection, user_id=user_id, request_id=request_id)
            revision = request["revocation_revision"] + 1
            connection.execute(
                text("""
                UPDATE drive_share_requests SET revocation_revision=:revision WHERE request_id=:request
            """),
                {"revision": revision, "request": request_id},
            )
            authority = self._revoke_authority(user_id, request_id, revision, generation, grants)
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
            request = self._management(connection, user_id, generation, request_id)
            if request["revocation_revision"] != revision:
                raise DriveSharingError("review_changed")
            grants = self._revocable(connection, user_id=user_id, request_id=request_id)
            authority = self._revoke_authority(user_id, request_id, revision, generation, grants)
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
            ids = []
            for grant in grants:
                identifier = str(uuid4())
                envelope = self.sharing_cipher.seal(
                    {**grant, "revocation_revision": revision},
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
                "otherAccessMayRemain": True,
            }

        return await self._transaction(operation)

    def _grant_authority(self, connection, initial):
        if initial["kind"] == "grant":
            return super()._grant_authority(connection, initial)
        request = self._management(
            connection,
            initial["user_id"],
            initial["connection_generation"],
            str(initial["request_id"]),
        )
        plan = self._plan(initial)
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        parent = self._permission(
            connection, initial["user_id"], str(initial["parent_operation_id"]), lock=True
        )
        if (
            request["revocation_revision"] != plan["revocation_revision"]
            or (now - initial["created_at"]).total_seconds() > 300
            or not parent
            or parent["kind"] != "grant"
            or parent["state"] != "succeeded"
            or self._receipt(parent).get("managed") is not True
        ):
            raise DriveSharingError("approval_superseded")
        return plan

    async def claim_revoke(self, *, user_id, operation_id):
        return await self._claim_queued(user_id=user_id, operation_id=operation_id, kind="revoke")
