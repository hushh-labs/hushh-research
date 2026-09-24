"""Bounded participant projections; private suggestions never cross to B."""

from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_revocation_store import DriveRevocationStore
from hushh_mcp.services.drive_sharing_contract import MAX_FILES, DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID


class DriveSharingProjectionStore(DriveRevocationStore):
    async def list_requests(self, *, user_id, direction, limit=20, offset=0):
        if (
            direction not in {"incoming", "outgoing"}
            or type(limit) is not int
            or not 1 <= limit <= 50
            or type(offset) is not int
            or not 0 <= offset <= 10000
        ):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            rows = (
                connection.execute(
                    text("""
                SELECT request_id,status,revision,created_at,expires_at FROM drive_share_requests
                WHERE (:outgoing=TRUE AND recipient_user_id=:user)
                   OR (:outgoing=FALSE AND user_id=:user)
                UNION ALL
                SELECT request_id,'management_only',revocation_revision,created_at,NULL
                FROM drive_share_management_contexts
                WHERE :outgoing=FALSE AND user_id=:user AND private_request_erased_at IS NOT NULL
                ORDER BY created_at DESC,request_id DESC LIMIT :limit OFFSET :offset
                """),
                    {
                        "user": user_id,
                        "outgoing": direction == "outgoing",
                        "limit": limit + 1,
                        "offset": offset,
                    },
                )
                .mappings()
                .all()
            )
            return {
                "items": [
                    {
                        **self._summary(row, recipient=direction == "outgoing"),
                        "createdAt": row["created_at"].isoformat(),
                        "direction": direction,
                    }
                    for row in rows[:limit]
                ],
                "hasMore": len(rows) > limit,
            }

        return await self._transaction(operation)

    async def delivery_snapshot(self, *, user_id, request_id):
        """Internal only: the service verifies recipient identity before release.

        The request and exact receipts are read under one lock. Status is the
        recorded provider outcome, never a promise about Google's current ACL.
        """
        request_id = str(UUID(request_id))

        def operation(connection):
            request = self._row(
                connection,
                """
                SELECT * FROM drive_share_requests WHERE request_id=:id
                  AND (user_id=:user OR recipient_user_id=:user) FOR SHARE
                """,
                {"id": request_id, "user": user_id},
            )
            if not request:
                context = self._row(
                    connection,
                    """
                    SELECT request_id,user_id,revocation_revision FROM drive_share_management_contexts
                    WHERE request_id=:id AND user_id=:user AND private_request_erased_at IS NOT NULL FOR SHARE
                """,
                    {"id": request_id, "user": user_id},
                )
                if not context:
                    raise DriveSharingError("request_unavailable")
                request = {
                    **context,
                    "status": "management_only",
                    "revision": context["revocation_revision"],
                    "recipient_user_id": None,
                }
            recipient = request["recipient_user_id"] == user_id
            private = self._open_request(request) if request.get("request_envelope") else None
            grants = (
                connection.execute(
                    text("""
                SELECT g.*, r.state AS revoke_state FROM drive_share_permission_operations g
                LEFT JOIN LATERAL (
                  SELECT state FROM drive_share_permission_operations r
                  WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
                  ORDER BY created_at DESC,operation_id DESC LIMIT 1
                ) r ON TRUE
                WHERE g.request_id=:request AND g.kind='grant'
                ORDER BY g.created_at,g.operation_id LIMIT :limit
                """),
                    {"request": request_id, "limit": MAX_FILES + 1},
                )
                .mappings()
                .all()
            )
            if len(grants) > MAX_FILES:
                raise DriveSharingError("sharing_storage_unavailable")
            files = []
            for row in grants:
                removed = row["revoke_state"] in {"succeeded", "absent"}
                delivered = row["state"] in {"succeeded", "preexisting", "present_unattributed"}
                # B sees no private candidates or failed/uncertain file names.
                if recipient and (not delivered or removed):
                    continue
                plan = self._plan(row)
                file_id = plan["file_id"]
                if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                    raise DriveSharingError("sharing_storage_unavailable")
                item = {
                    "name": plan["file_name"],
                    "status": "removed" if removed else row["state"],
                    "revocationStatus": row["revoke_state"],
                    "otherAccessMayRemain": bool(row["revoke_state"]),
                }
                if delivered and not removed:
                    # Construct an approved original-file link, never a retrieved URL.
                    item["openUrl"] = f"https://drive.google.com/file/d/{file_id}/view"
                if not recipient:
                    receipt = self._receipt(row) if row["receipt_envelope"] else {}
                    item.update(
                        {
                            "grantId": str(row["operation_id"]),
                            "manageInGoogle": row["safe_error_code"]
                            == "permission_requires_google_management",
                            "managed": row["state"] == "succeeded"
                            and receipt.get("managed") is True,
                        }
                    )
                files.append(item)
            return {
                "recipient": private["recipient"] if recipient and private else None,
                "result": {
                    **self._summary(request, recipient=recipient),
                    "files": files,
                    "recordedOutcomeOnly": True,
                    "disconnectDoesNotRevoke": True,
                    "otherAccessMayRemain": True,
                },
            }

        return await self._transaction(operation)
