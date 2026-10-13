"""One participant-scoped answer row per request in both consent surfaces."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from hushh_mcp.services.pkm_answer_payment_service import PkmAnswerPaymentService
from hushh_mcp.services.pkm_answer_request_service import PkmAnswerRequestService

BUCKETS = ("incoming_requests", "outgoing_requests", "active_grants", "history", "invites")


class PkmAnswerCenterContributor:
    def __init__(self, requests: PkmAnswerRequestService | None = None) -> None:
        self.requests = requests or PkmAnswerRequestService()

    async def collect(self, user_id: str) -> dict[str, list[dict[str, Any]]]:
        def read(connection):
            rows = (
                connection.execute(
                    text("""SELECT r.request_id,r.owner_user_id,r.requester_user_id,
                r.status,r.created_at,r.question,r.terms_digest,r.composer_consent_digest,
                d.source_revisions, o.status AS payment_status,
                COALESCE(o.amount_cents, r.amount_cents) AS amount_cents,
                r.approved_at < now() - interval '2 minutes' AS preparation_overdue,
                -- The resolver's proposal. Zero means nothing of the owner's
                -- matched the question, so the requester is told the answer is
                -- not there instead of being shown a price that cannot exist.
                (SELECT COUNT(*) FROM pkm_answer_request_scopes s
                   WHERE s.request_id=r.request_id) AS proposed_scope_count,
                -- Whether the owner's device has actually prepared the answer,
                -- and whether the approved information yielded anything. A
                -- proposal count is what the resolver suggested; only this is
                -- evidence that an answer exists to be bought.
                d.request_id IS NOT NULL AS answer_staged,
                d.has_content AS answer_has_content,
                requester_identity.display_name AS requester_label, owner_identity.display_name AS owner_label,
                EXISTS(SELECT 1 FROM connections c WHERE c.status='active' AND
                  ((c.user_a_id=r.owner_user_id AND c.user_b_id=r.requester_user_id) OR
                   (c.user_b_id=r.owner_user_id AND c.user_a_id=r.requester_user_id))) AS connected
                FROM pkm_answer_requests r LEFT JOIN pkm_answer_payment_orders o USING(request_id)
                LEFT JOIN pkm_answer_deliveries d ON d.request_id=r.request_id
                LEFT JOIN actor_identity_cache requester_identity ON requester_identity.user_id=r.requester_user_id
                LEFT JOIN actor_identity_cache owner_identity ON owner_identity.user_id=r.owner_user_id
                WHERE r.owner_user_id=:user OR r.requester_user_id=:user ORDER BY r.created_at DESC"""),
                    {"user": user_id},
                )
                .mappings()
                .all()
            )
            buckets = {key: [] for key in BUCKETS}
            for row in rows:
                owner = row["owner_user_id"] == user_id
                status = row["status"]
                terminal = (
                    status in {"answered", "declined", "cancelled", "expired"}
                    or not row["connected"]
                )
                staged = bool(row["answer_staged"]) and (
                    not row["answer_has_content"]
                    or PkmAnswerPaymentService._has_composed_answer(row, row)
                )
                needs = not terminal and (
                    (
                        owner
                        and (
                            status in {"pending_resolution", "awaiting_owner", "answering"}
                            or (status == "approved" and not staged)
                        )
                    )
                    or (not owner and status == "approved")
                )
                bucket = (
                    "history" if terminal else "incoming_requests" if needs else "outgoing_requests"
                )
                kind = {
                    "history": "history",
                    "incoming_requests": "incoming_request",
                    "outgoing_requests": "outgoing_request",
                }[bucket]
                request = str(row["request_id"])
                buckets[bucket].append(
                    {
                        "id": f"answer_request:{request}",
                        "request_id": request,
                        "kind": kind,
                        "status": status if row["connected"] else "connection_revoked",
                        "action": "ANSWER_REQUEST_REVIEW",
                        "scope": None,
                        "scope_description": "Request scope",
                        "counterpart_type": "person",
                        "counterpart_id": row["requester_user_id"]
                        if owner
                        else row["owner_user_id"],
                        "counterpart_label": (
                            row["requester_label"] if owner else row["owner_label"]
                        )
                        or ("The requester" if owner else "The owner"),
                        "issued_at": int(row["created_at"].timestamp() * 1000),
                        "metadata": {
                            "request_source": "answer_request",
                            "role": "owner" if owner else "requester",
                            "direction": "incoming" if needs else "outgoing",
                            "request_status": status,
                            "payment_status": row["payment_status"],
                            # Both participants already read these through
                            # /state and /payment; the row carries them so the
                            # Feed can name the price and the question without
                            # one request per row. feed_events stays coarse.
                            "question": row["question"],
                            "amount_cents": row["amount_cents"],
                            "proposed_scope_count": int(row["proposed_scope_count"] or 0),
                            "answer_staged": staged,
                            "preparation_overdue": bool(row["preparation_overdue"]),
                            "answer_has_content": (
                                None
                                if row["answer_has_content"] is None
                                else bool(row["answer_has_content"])
                            ),
                        },
                    }
                )
            return buckets

        return await self.requests._transaction(read)
