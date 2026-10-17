"""Participant-scoped keyset history. Metadata is never an access capability."""

import json
import uuid

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.wallet_sharing_sources import PAYMENT, PROFILE


def history(
    service, viewer, *, direction="outgoing", card_type=None, cursor=None, limit=20, grant_id=None
):
    # Import locally to keep storage/history adapters below the service authority.
    from hushh_mcp.services.wallet_card_access_service import WalletCardAccessError, iso, many, one

    if (
        direction not in {"outgoing", "received"}
        or card_type not in {None, "payment", "profile"}
        or not 1 <= limit <= 100
    ):
        raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422)
    side = "owner_user_id" if direction == "outgoing" else "recipient_user_id"
    with service.db.engine.begin() as conn:
        service.require_available(conn)
        installed = one(
            conn, "SELECT to_regclass('public.wallet_profile_access_grants') IS NOT NULL AS ok"
        )["ok"]
        if not installed:
            raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_READY", 503)
        queries = []
        for source in (PAYMENT, PROFILE):
            if card_type and card_type != source.kind:
                continue
            ciphertext = (
                "g.content_ciphertext,g.content_iv,g.content_algorithm"
                if source == PAYMENT
                else "NULL::text AS content_ciphertext,NULL::text AS content_iv,NULL::text AS content_algorithm"
            )
            # Only fixed sharing-source identifiers/fragments; request values are bound.
            queries.append(
                (
                    f"SELECT g.id,g.owner_user_id,g.recipient_user_id,g.card_id,g.created_at,g.expires_at,\n"  # nosec B608
                    f" g.revoked_at,g.verification_required,g.trusted_at_creation,g.permitted_fields,g.verified_at,g.last_accessed_at,'{source.kind}' AS card_type,{ciphertext}\n"
                    f" FROM {source.grants} g WHERE g.{side}=:viewer"
                )
            )
        union = " UNION ALL ".join(queries)
        recipient_count = one(
            conn,
            f"SELECT COUNT(DISTINCT recipient_user_id) AS count FROM ({union}) g",  # nosec B608
            {"viewer": viewer},
        )["count"]
        values = {"viewer": viewer, "limit": limit + 1}
        predicate = ""
        if cursor:
            try:
                kind, identifier = cursor.split(":", 1)
                identifier = str(uuid.UUID(identifier))
            except (ValueError, AttributeError):
                raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422) from None
            anchor = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                f"SELECT id,created_at,card_type FROM ({union}) g WHERE id=CAST(:anchor AS uuid) AND card_type=:kind",  # nosec B608
                {**values, "anchor": identifier, "kind": kind},
            )
            if not anchor:
                raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422)
            values.update(anchor=identifier, kind=kind, created=anchor["created_at"])
            predicate = "WHERE (g.created_at<:created OR (g.created_at=:created AND (g.card_type,g.id)>(:kind,CAST(:anchor AS uuid))))"
        if grant_id:
            predicate = "WHERE g.id=CAST(:grant AS uuid)"
            values["grant"] = grant_id
        rows = many(
            conn,
            # Only fixed sharing-source identifiers/fragments; request values are bound.
            (
                f"SELECT g.*,a.display_name AS recipient_name,b.display_name AS sender_name,\n"  # nosec B608
                f" p.public_person_ref AS recipient_ref,q.public_person_ref AS sender_ref,clock_timestamp() AS server_now\n"
                f" FROM ({union}) g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id\n"
                f" LEFT JOIN actor_identity_cache b ON b.user_id=g.owner_user_id\n"
                f" LEFT JOIN actor_profiles p ON p.user_id=g.recipient_user_id\n"
                f" LEFT JOIN actor_profiles q ON q.user_id=g.owner_user_id {predicate}\n"
                f" ORDER BY g.created_at DESC,g.card_type,g.id LIMIT :limit"
            ),
            values,
        )
        if grant_id and len(rows) != 1:
            raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
        items = []
        # Match create/view/revoke/deletion: graph identities before grant rows.
        lock_connection_graph_users(
            conn,
            user_ids=[
                uid
                for row in rows[:limit]
                for uid in (row["owner_user_id"], row["recipient_user_id"])
            ],
        )
        for row in rows[:limit]:
            source = PROFILE if row["card_type"] == "profile" else PAYMENT
            locked = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                f"SELECT *,clock_timestamp() AS server_now FROM {source.grants} WHERE id=CAST(:id AS uuid) FOR UPDATE",  # nosec B608
                {"id": str(row["id"])},
            )
            if not locked:
                continue
            service._expire(conn, locked, source)
            # Re-read terminal state under lock, including concurrent revocation.
            row.update(
                {
                    key: locked[key]
                    for key in (
                        "revoked_at",
                        "last_accessed_at",
                        "verification_required",
                        "verified_at",
                        "server_now",
                    )
                }
            )
            descriptor = {"displayLabel": "Profile Card", "last4": None}
            if source == PAYMENT:
                payload = json.loads(
                    service.cipher.open(
                        {
                            **row,
                            "conversation_id": row["recipient_user_id"],
                            "sender_user_id": row["owner_user_id"],
                        }
                    )
                )
                descriptor = {
                    "displayLabel": f"{payload['brand'].upper()} •••• {payload['last4']}",
                    "last4": payload["last4"],
                }
            events = many(
                conn,
                "SELECT event_type,created_at,actor_user_id FROM wallet_card_access_audit WHERE COALESCE(grant_id,profile_grant_id)=CAST(:id AS uuid) ORDER BY created_at DESC,id DESC LIMIT 100",
                {"id": str(row["id"])},
            )
            names = {
                "created": "SHARE_CREATED",
                "delivered": "SHARE_DELIVERED",
                "viewed": "SHARE_OPENED",
                "verified": "ACCESS_VERIFIED",
                "denied": "ACCESS_DENIED",
                "expired": "SHARE_EXPIRED",
                "revoked": "SHARE_REVOKED",
            }
            items.append(
                {
                    "id": str(row["id"]),
                    "cardId": row["card_id"],
                    "cardType": source.kind,
                    "source": "owner_manual" if source == PAYMENT else "owner_profile",
                    **descriptor,
                    "senderName": row.get("sender_name") or "A connection",
                    "recipientName": row.get("recipient_name") or "A connection",
                    "senderPersonRef": str(row["sender_ref"]) if row["sender_ref"] else None,
                    "recipientPersonRef": str(row["recipient_ref"])
                    if row["recipient_ref"]
                    else None,
                    "createdAt": iso(row["created_at"]),
                    "expiresAt": iso(row["expires_at"]),
                    "durationMinutes": int(
                        (row["expires_at"] - row["created_at"]).total_seconds() / 60
                    ),
                    # Immutable creation posture, not today's potentially changed membership.
                    "trustedCircle": row["trusted_at_creation"],
                    "method": "trusted_circle"
                    if row["trusted_at_creation"] is True
                    else "standard_connection"
                    if row["trusted_at_creation"] is False
                    else "legacy_unspecified",
                    "permittedFields": row["permitted_fields"],
                    "verificationMethod": "identity_reauthentication"
                    if row["verification_required"]
                    else "trusted_circle"
                    if row["trusted_at_creation"] is True
                    else "legacy_unspecified",
                    "verifiedAt": iso(row["verified_at"]),
                    "status": service._grant_status(row, row["server_now"]),
                    "revokedAt": iso(row["revoked_at"]),
                    "lastAccessedAt": iso(row["last_accessed_at"]),
                    "activity": [
                        {
                            "event": names[e["event_type"]],
                            "at": iso(e["created_at"]),
                            "actor": "owner"
                            if e["actor_user_id"] == row["owner_user_id"]
                            else "recipient",
                            "outcome": "denied" if e["event_type"] == "denied" else "recorded",
                        }
                        for e in events
                    ],
                }
            )
        if grant_id and not items:
            # Account erasure may remove the selected grant before graph locks
            # are acquired. Detail callers must still get a scoped 404.
            raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
        more = len(rows) > limit
        return {
            "items": items,
            "hasMore": more,
            "recipientCount": int(recipient_count),
            "nextCursor": f"{rows[limit - 1]['card_type']}:{rows[limit - 1]['id']}"
            if more
            else None,
            "serverNow": iso(one(conn, "SELECT clock_timestamp() AS now")["now"]),
        }
