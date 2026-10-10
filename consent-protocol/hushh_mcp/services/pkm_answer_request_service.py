"""Lifecycle for a paid answer: ask, resolve, approve, answer, deliver.

Ownership split, which is the whole point of this module:

* The **resolver agent** decides which scopes a question needs. That is a
  semantic judgement and this module never substitutes for it; when the stage
  does not run, the request is marked ``resolution_mode='skipped'`` with a
  reason so an absent intelligence is visible in the trace instead of looking
  like a confident resolution.
* **Deterministic code** then narrows, never widens
  (``answer_scope_resolution.validate_resolved_scopes``), enforces the
  connection gate, fixes the terms digest at approval, and gates delivery on a
  verified payment. Those are authority guards, which
  ``backend-semantic-boundary.md`` keeps deterministic by design.

Nothing here decrypts anything. The answer is produced on the owner's unlocked
device and arrives as a sealed envelope; this module stores ciphertext and
revision numbers only.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import text

from hushh_mcp.consent.answer_scope_resolution import (
    canonical_question,
    compute_terms_digest,
    validate_resolved_scopes,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.pkm_answer_payment_service import (
    PkmAnswerPaymentService,
    valid_answer_price_cents,
)

logger = logging.getLogger(__name__)

MIN_QUESTION_CHARS = 8
MAX_QUESTION_CHARS = 2000


class AnswerRequestError(RuntimeError):
    """Safe error code. Never carries SQL, credentials or PKM values."""


class PkmAnswerRequestService(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, resolver=None):
        super().__init__(db)
        # Injected so the semantic stage can be supplied by the agent runtime
        # and replaced in tests. `None` means the stage is unavailable, which
        # is recorded as a skip rather than silently keyword-matched.
        self._resolver = resolver

    # ------------------------------------------------------------------ gate

    @staticmethod
    def _require_active_connection(connection, owner_user_id: str, requester_user_id: str) -> None:
        """Any active connection may ask. No trust tier, no connector setup.

        Mirrors ``DriveSharingStore._relationship``: the presence of an active
        row in ``connections`` is the entire gate, and its absence fails closed.
        """
        if owner_user_id == requester_user_id:
            raise AnswerRequestError("no_self_request")
        row = (
            connection.execute(
                text(
                    """SELECT id FROM connections WHERE status = 'active'
                   AND ((user_a_id = :owner AND user_b_id = :requester)
                     OR (user_a_id = :requester AND user_b_id = :owner))
                   FOR SHARE"""
                ),
                {"owner": owner_user_id, "requester": requester_user_id},
            )
            .mappings()
            .first()
        )
        if row is None:
            raise AnswerRequestError("connection_required")

    # --------------------------------------------------------------- create

    async def create(
        self,
        *,
        requester_user_id: str,
        owner_user_id: str,
        question: str,
        period_start: str | None = None,
        period_end: str | None = None,
    ) -> dict[str, Any]:
        text_question = canonical_question(question)
        if not MIN_QUESTION_CHARS <= len(text_question) <= MAX_QUESTION_CHARS:
            raise AnswerRequestError("invalid_question")
        if bool(period_start) != bool(period_end):
            raise AnswerRequestError("invalid_period")
        if period_start and period_end and period_start > period_end:
            raise AnswerRequestError("invalid_period")

        def insert(connection):
            self._require_active_connection(connection, owner_user_id, requester_user_id)
            row = (
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_requests
                       (owner_user_id, requester_user_id, question, period_start, period_end)
                       VALUES (:owner, :requester, :question, :start, :end)
                       RETURNING request_id"""
                    ),
                    {
                        "owner": owner_user_id,
                        "requester": requester_user_id,
                        "question": text_question,
                        "start": period_start,
                        "end": period_end,
                    },
                )
                .mappings()
                .first()
            )
            return str(row["request_id"])

        request_id = await self._transaction(insert)
        await self.resolve_scopes(request_id=request_id)
        return {"requestId": request_id}

    # -------------------------------------------------------------- resolve

    async def resolve_scopes(self, *, request_id: str) -> dict[str, Any]:
        """Run the semantic resolver, then narrow its proposal deterministically.

        A missing or failing resolver is recorded, not worked around. The owner
        still sees the question and can approve scopes by hand; what must never
        happen is a keyword guess presented as if the agent had judged it.
        """

        def read(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, question, status
                   FROM pkm_answer_requests WHERE request_id = :request""",
                {"request": request_id},
            )
            if request is None:
                raise AnswerRequestError("request_unavailable")
            catalog = (
                connection.execute(
                    text(
                        """SELECT scope_handle, scope_label FROM pkm_scope_registry
                       WHERE user_id = :owner AND visibility_posture = 'consent_required'"""
                    ),
                    {"owner": request["owner_user_id"]},
                )
                .mappings()
                .all()
            )
            return request, [dict(entry) for entry in catalog]

        request, catalog = await self._transaction(read)
        if request["status"] != "pending_resolution":
            raise AnswerRequestError("request_not_resolvable")

        handles = [entry["scope_handle"] for entry in catalog]
        labels = {
            entry["scope_handle"]: entry.get("scope_label") or ""
            for entry in catalog
            if entry.get("scope_label")
        }

        proposed: list[str] = []
        mode = "agent"
        skipped_reason: str | None = None
        if self._resolver is None:
            mode, skipped_reason = "skipped", "resolver_unavailable"
        else:
            try:
                proposed = list(
                    await self._resolver.propose_scopes(
                        question=request["question"], candidate_scopes=handles
                    )
                )
            except Exception as error:  # noqa: BLE001 - a model failure is a skip, not a guess
                mode, skipped_reason = "skipped", "resolver_failed"
                logger.warning(
                    "answer_scope_resolution.skipped request=%s reason=%s error=%s",
                    request_id,
                    skipped_reason,
                    type(error).__name__,
                )

        resolution = validate_resolved_scopes(
            proposed, owner_catalog=handles, catalog_labels=labels
        )
        if resolution.dropped:
            logger.info(
                "answer_scope_resolution.dropped request=%s count=%s reasons=%s",
                request_id,
                len(resolution.dropped),
                sorted({reason for _scope, reason in resolution.dropped}),
            )

        def persist(connection):
            connection.execute(
                text("DELETE FROM pkm_answer_request_scopes WHERE request_id = :request"),
                {"request": request_id},
            )
            for scope in resolution.accepted:
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_request_scopes
                           (request_id, scope, label, approved)
                           VALUES (:request, :scope, :label, FALSE)"""
                    ),
                    {
                        "request": request_id,
                        "scope": scope,
                        "label": resolution.labels.get(scope),
                    },
                )
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'awaiting_owner', resolution_mode = :mode,
                           resolution_skipped_reason = :reason, updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "mode": mode, "reason": skipped_reason},
            )

        await self._transaction(persist)
        return {
            "resolutionMode": mode,
            "skippedReason": skipped_reason,
            "proposedScopes": list(resolution.accepted),
            "droppedCount": len(resolution.dropped),
        }

    async def pending_for_owner(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        """Questions awaiting this owner's review, with the resolved scopes.

        Carries `resolutionMode` so the reviewer can see when the semantic
        stage did not run: an owner approving a hand-picked set after a skip is
        a different act from approving what the resolver judged.
        """

        def read(connection):
            rows = (
                connection.execute(
                    text(
                        """SELECT request_id, requester_user_id, question, period_start,
                              period_end, resolution_mode, resolution_skipped_reason,
                              created_at
                       FROM pkm_answer_requests
                       WHERE owner_user_id = :owner AND status = 'awaiting_owner'
                       ORDER BY created_at"""
                    ),
                    {"owner": owner_user_id},
                )
                .mappings()
                .all()
            )
            out = []
            for row in rows:
                scopes = (
                    connection.execute(
                        text(
                            """SELECT scope, label FROM pkm_answer_request_scopes
                           WHERE request_id = :request ORDER BY scope"""
                        ),
                        {"request": str(row["request_id"])},
                    )
                    .mappings()
                    .all()
                )
                out.append(
                    {
                        "requestId": str(row["request_id"]),
                        "requesterUserId": row["requester_user_id"],
                        "question": row["question"],
                        "periodStart": row["period_start"].isoformat()
                        if row["period_start"]
                        else None,
                        "periodEnd": row["period_end"].isoformat() if row["period_end"] else None,
                        "resolutionMode": row["resolution_mode"],
                        "resolutionSkippedReason": row["resolution_skipped_reason"],
                        "proposedScopes": [
                            {"scope": entry["scope"], "label": entry["label"]} for entry in scopes
                        ],
                    }
                )
            return out

        return await self._transaction(read)

    # -------------------------------------------------------------- approve

    async def approve(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        scopes: list[str],
        amount_cents: int,
    ) -> dict[str, Any]:
        """The owner approves the exact question, the exact scopes and a price.

        The approved set must be a subset of what was put in front of them: an
        owner may narrow the resolution, never widen it past validation.
        """
        if not valid_answer_price_cents(amount_cents):
            raise AnswerRequestError("invalid_price")
        chosen = sorted({str(scope or "").strip().lower() for scope in scopes if scope})
        if not chosen:
            raise AnswerRequestError("no_scopes_approved")

        def write(connection):
            request = self._row(
                connection,
                """SELECT * FROM pkm_answer_requests
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["status"] != "awaiting_owner":
                raise AnswerRequestError("request_not_approvable")
            self._require_active_connection(connection, owner_user_id, request["requester_user_id"])

            offered = {
                row["scope"]
                for row in connection.execute(
                    text("SELECT scope FROM pkm_answer_request_scopes WHERE request_id = :request"),
                    {"request": request_id},
                ).mappings()
            }
            if not set(chosen) <= offered:
                raise AnswerRequestError("scope_not_offered")

            connection.execute(
                text(
                    """UPDATE pkm_answer_request_scopes SET approved = (scope = ANY(:chosen))
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "chosen": chosen},
            )
            digest = compute_terms_digest(
                question=request["question"],
                scopes=chosen,
                owner_user_id=owner_user_id,
                requester_user_id=request["requester_user_id"],
                amount_cents=amount_cents,
            )
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'approved', amount_cents = :amount,
                           terms_digest = :digest, approved_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "amount": amount_cents, "digest": digest},
            )
            return digest

        digest = await self._transaction(write)
        return {"approved": True, "termsDigest": digest, "amountCents": amount_cents}

    async def decline(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        def write(connection):
            request = self._row(
                connection,
                """SELECT status, owner_user_id FROM pkm_answer_requests
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["status"] in {"answered", "declined", "cancelled", "expired"}:
                raise AnswerRequestError("request_not_declinable")
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'declined', declined_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id},
            )
            return request["status"]

        previous = await self._transaction(write)
        # A decline after payment refunds in full, per the product contract.
        if previous == "answering":
            await PkmAnswerPaymentService(self.db).refund(
                request_id=request_id, reason="owner_declined"
            )
        return {"declined": True}

    # --------------------------------------------------------------- answer

    async def claim_answerable(self, *, owner_user_id: str, limit: int = 5) -> list[dict[str, Any]]:
        """Paid, undelivered work for the owner's device sweep.

        Returns the question and the approved scopes only. The device reads its
        own decrypted PKM for the values; the server never sends any.
        """

        def read(connection):
            rows = (
                connection.execute(
                    text(
                        """SELECT r.request_id, r.question, r.period_start, r.period_end,
                              r.requester_user_id, r.terms_digest, r.answer_deadline_at
                       FROM pkm_answer_requests r
                       JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                       LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                       WHERE r.owner_user_id = :owner AND r.status = 'answering'
                         AND o.status = 'paid' AND NOT o.reconciliation_required
                         AND d.request_id IS NULL
                       ORDER BY r.approved_at
                       LIMIT :limit"""
                    ),
                    {"owner": owner_user_id, "limit": max(1, min(int(limit), 25))},
                )
                .mappings()
                .all()
            )
            out = []
            for row in rows:
                scopes = (
                    connection.execute(
                        text(
                            """SELECT scope, label FROM pkm_answer_request_scopes
                           WHERE request_id = :request AND approved"""
                        ),
                        {"request": str(row["request_id"])},
                    )
                    .mappings()
                    .all()
                )
                out.append(
                    {
                        "requestId": str(row["request_id"]),
                        "question": row["question"],
                        "periodStart": row["period_start"].isoformat()
                        if row["period_start"]
                        else None,
                        "periodEnd": row["period_end"].isoformat() if row["period_end"] else None,
                        "approvedScopes": [entry["scope"] for entry in scopes],
                        "scopeLabels": {
                            entry["scope"]: entry["label"] for entry in scopes if entry["label"]
                        },
                        "answerDeadlineAt": (
                            row["answer_deadline_at"].isoformat()
                            if row["answer_deadline_at"]
                            else None
                        ),
                    }
                )
            return out

        return await self._transaction(read)

    async def deliver(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        envelope: dict[str, Any],
        source_revisions: dict[str, Any] | None = None,
        has_content: bool = True,
    ) -> dict[str, Any]:
        """Store the sealed answer the owner's device produced.

        Rejects anything that is not a well-formed ciphertext envelope: answer
        plaintext must never arrive here.
        """
        required = ("ciphertext", "iv", "senderEphemeralPublicKeyJwk", "recipientKeyId")
        if not isinstance(envelope, dict) or any(not envelope.get(field) for field in required):
            raise AnswerRequestError("invalid_envelope")
        if not isinstance(envelope.get("senderEphemeralPublicKeyJwk"), dict):
            raise AnswerRequestError("invalid_envelope")
        if any(key in envelope for key in ("plaintext", "answer", "value")):
            raise AnswerRequestError("invalid_envelope")

        def write(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, status, terms_digest
                   FROM pkm_answer_requests WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["status"] != "answering":
                raise AnswerRequestError("request_not_answerable")
            # The gate, inside the delivery transaction, after the lock.
            PkmAnswerPaymentService.require_paid_answer(connection, request)

            connection.execute(
                text(
                    """INSERT INTO pkm_answer_deliveries
                       (request_id, recipient_key_id, ciphertext, iv,
                        sender_ephemeral_public_key_jwk, source_revisions, has_content)
                       VALUES (:request, :key_id, :ciphertext, :iv,
                               CAST(:jwk AS JSONB), CAST(:revisions AS JSONB), :has_content)
                       ON CONFLICT (request_id) DO NOTHING"""
                ),
                {
                    "request": request_id,
                    "key_id": envelope["recipientKeyId"],
                    "ciphertext": envelope["ciphertext"],
                    "iv": envelope["iv"],
                    "jwk": json.dumps(envelope["senderEphemeralPublicKeyJwk"]),
                    "revisions": json.dumps(source_revisions or {}),
                    "has_content": bool(has_content),
                },
            )
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'answered', answered_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id},
            )
            # Earnings become due only on a real delivery.
            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET owner_earning_status = :earning, updated_at = clock_timestamp()
                       WHERE request_id = :request AND status = 'paid'"""
                ),
                {"request": request_id, "earning": "due" if has_content else "none"},
            )

        await self._transaction(write)
        if not has_content:
            # No charge when the approved scopes yielded nothing.
            await PkmAnswerPaymentService(self.db).refund(
                request_id=request_id, reason="empty_answer"
            )
        return {"delivered": True, "hasContent": bool(has_content)}

    async def fetch_answer(self, *, requester_user_id: str, request_id: str) -> dict[str, Any]:
        def read(connection):
            row = self._row(
                connection,
                """SELECT d.recipient_key_id, d.ciphertext, d.iv,
                          d.sender_ephemeral_public_key_jwk, d.algorithm,
                          d.source_revisions, d.has_content
                   FROM pkm_answer_deliveries d
                   JOIN pkm_answer_requests r ON r.request_id = d.request_id
                   WHERE d.request_id = :request AND r.requester_user_id = :requester""",
                {"request": request_id, "requester": requester_user_id},
            )
            if row is None:
                raise AnswerRequestError("answer_unavailable")
            return row

        row = await self._transaction(read)
        return {
            "recipientKeyId": row["recipient_key_id"],
            "ciphertext": row["ciphertext"],
            "iv": row["iv"],
            "senderEphemeralPublicKeyJwk": row["sender_ephemeral_public_key_jwk"],
            "algorithm": row["algorithm"],
            "sourceRevisions": row["source_revisions"],
            "hasContent": row["has_content"],
        }

    # --------------------------------------------------------------- cancel

    async def cancel(self, *, requester_user_id: str, request_id: str) -> dict[str, Any]:
        """The requester withdraws before delivery and is refunded in full."""

        def write(connection):
            request = self._row(
                connection,
                """SELECT r.status, r.requester_user_id, d.request_id AS delivered
                   FROM pkm_answer_requests r
                   LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                   WHERE r.request_id = :request FOR UPDATE OF r""",
                {"request": request_id},
            )
            if request is None or request["requester_user_id"] != requester_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["delivered"] is not None:
                raise AnswerRequestError("answer_already_delivered")
            if request["status"] in {"answered", "cancelled", "expired", "declined"}:
                raise AnswerRequestError("request_not_cancellable")
            connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'cancelled', cancelled_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id},
            )
            return request["status"]

        previous = await self._transaction(write)
        if previous == "answering":
            await PkmAnswerPaymentService(self.db).refund(
                request_id=request_id, reason="requester_cancelled"
            )
        return {"cancelled": True}

    async def expire_overdue(self, *, limit: int = 20) -> dict[str, Any]:
        """Timeout sweep: a paid answer past its deadline refunds in full.

        This is the backstop that makes the quoted deadline real rather than
        advisory, and it runs on the existing durable drain.
        """

        def claim(connection):
            rows = (
                connection.execute(
                    text(
                        """UPDATE pkm_answer_requests SET status = 'expired',
                           updated_at = clock_timestamp()
                       WHERE request_id IN (
                         SELECT r.request_id FROM pkm_answer_requests r
                         WHERE r.status = 'answering'
                           AND r.answer_deadline_at IS NOT NULL
                           AND r.answer_deadline_at < clock_timestamp()
                           -- NOT EXISTS, not a LEFT JOIN: Postgres refuses
                           -- FOR UPDATE on the nullable side of an outer join.
                           AND NOT EXISTS (
                             SELECT 1 FROM pkm_answer_deliveries d
                             WHERE d.request_id = r.request_id)
                         ORDER BY r.answer_deadline_at
                         LIMIT :limit FOR UPDATE SKIP LOCKED)
                       RETURNING request_id"""
                    ),
                    {"limit": max(1, min(int(limit), 100))},
                )
                .mappings()
                .all()
            )
            return [str(row["request_id"]) for row in rows]

        expired = await self._transaction(claim)
        refunded = 0
        for request_id in expired:
            try:
                await PkmAnswerPaymentService(self.db).refund(
                    request_id=request_id, reason="answer_timeout"
                )
                refunded += 1
            except Exception:  # noqa: BLE001 - a stuck refund retries on the next drain
                logger.warning("answer_timeout_refund_deferred request=%s", request_id)
        return {"expired": len(expired), "refunded": refunded}
