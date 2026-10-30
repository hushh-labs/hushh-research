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

import asyncio
import json
import logging
import time
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.consent.answer_scope_resolution import (
    canonical_question,
    compute_terms_digest,
    validate_resolved_scopes,
)
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others
from hushh_mcp.services.answer_composition_receipt import (
    COMPOSITION_RECEIPT_KEY,
    COMPOSITION_TERMS_KEY,
    CompositionReceiptError,
    verify_composition_receipt,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.pkm_answer_payment_service import (
    PkmAnswerPaymentService,
    valid_answer_price_cents,
)
from hushh_mcp.services.pkm_answer_work_worker import file_refund

logger = logging.getLogger(__name__)

MIN_QUESTION_CHARS = 8
MAX_QUESTION_CHARS = 2000


class AnswerRequestError(RuntimeError):
    """Safe error code. Never carries SQL, credentials or PKM values."""


def _optional_period_date(value: str | None) -> str | None:
    """Omitted dates are valid; supplied dates must be real ISO calendar dates."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise AnswerRequestError("invalid_period")
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("non-canonical date")
    except ValueError:
        raise AnswerRequestError("invalid_period") from None
    return value


class PkmAnswerRequestService(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, resolver=None, catalog_reader=None):
        super().__init__(db)
        # Injected so the semantic stage can be supplied by the agent runtime
        # and replaced in tests. `None` means the stage is unavailable, which
        # is recorded as a skip rather than silently keyword-matched.
        self._resolver = resolver
        self._catalog_reader = catalog_reader

    async def _catalog(self, requester_user_id: str, owner_user_id: str) -> list[dict[str, Any]]:
        if self._catalog_reader is not None:
            return list(await self._catalog_reader(requester_user_id, owner_user_id))
        from hushh_mcp.services.connections_service import ConnectionsService

        # Canonical consent selectors come from the same safe, complete catalog
        # as the connected profile. Registry handles themselves are opaque IDs.
        async with asyncio.timeout(6):
            entries = await asyncio.to_thread(
                ConnectionsService().get_exact_requestable_scope_entries,
                requester_user_id,
                owner_user_id,
            )
        safe = [
            entry for entry in entries if is_scope_requestable_by_others(entry.get("scope", ""))
        ]
        # Answer-owned selectors, not a new general Consent catalog. These
        # public account fields and optional owner-stated facts need no KYC.
        # Values remain private; preparation proves availability before Pay.
        known = {entry["scope"] for entry in safe}
        for path, label in (
            ("full_name", "Name"),
            ("profile_photo_url", "Profile photo"),
            ("declared_age", "Age (if recorded)"),
            ("sex", "Sex (if provided)"),
            ("date_of_birth", "Date of birth (if recorded)"),
            ("citizenship", "Citizenship (if recorded)"),
        ):
            scope = f"attr.identity.identity_profile.{path}"
            if scope not in known:
                safe.append(
                    {
                        "scope": scope,
                        "domain": "identity",
                        "path": f"identity_profile.{path}",
                        "label": label,
                    }
                )
        # Keep canonical identity facts visible even for large finance catalogs.
        canonical = {
            f"attr.identity.identity_profile.{path}": label
            for path, label in (
                ("full_name", "Name (current saved legal name or canonical account name)"),
                (
                    "declared_age",
                    "Age (current age in years derived from validated date of birth; never date of birth)",
                ),
                ("sex", "Sex (explicitly saved only)"),
                ("profile_photo_url", "Profile photo (authorised canonical photo)"),
            )
        }
        return [
            {**entry, "label": canonical.get(entry["scope"], entry.get("label", ""))}
            for entry in sorted(
                safe, key=lambda entry: (entry["scope"] not in canonical, entry["scope"])
            )
        ]

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

    # ------------------------------------------------------------------ feed

    @staticmethod
    def _feed(
        connection,
        *,
        user_id: str,
        event_type: str,
        request_id: str,
        status: str | None = None,
    ) -> None:
        """Project one answer-lane milestone into the person's Feed.

        Plaintext boundary matches the Drive projection (migration 246): a
        closed event type, the opaque request id and a coarse status. The
        question text, the scopes and the answer never appear here, because
        `feed_events.metadata` is server-readable and this lane's content is
        not.
        """
        started = time.monotonic()
        connection.execute(
            text(
                """INSERT INTO feed_events
                   (user_id, source_domain, event_type, metadata, source_row_id)
                   VALUES (:user, 'consent', :event, CAST(:meta AS JSONB), :row)
                   ON CONFLICT (user_id, source_domain, event_type, source_row_id)
                   WHERE source_row_id IS NOT NULL DO UPDATE
                   SET metadata=EXCLUDED.metadata, created_at=clock_timestamp(), read_at=NULL
                   WHERE feed_events.metadata IS DISTINCT FROM EXCLUDED.metadata"""
            ),
            {
                "user": user_id,
                "event": event_type,
                # The opaque request UUID travels so the Feed row can link to
                # the right card. Still no question, scopes or answer.
                "meta": json.dumps(
                    {"lane": "answer_request", "request_id": request_id, "status": status}
                    if status
                    else {"lane": "answer_request", "request_id": request_id}
                ),
                "row": f"answer_request:{request_id}",
            },
        )

        logger.info(
            "answer.lifecycle request=%s stage=feed_publish duration_ms=%.2f",
            request_id,
            (time.monotonic() - started) * 1000,
        )

    # --------------------------------------------------------------- create

    async def create(
        self,
        *,
        requester_user_id: str,
        owner_user_id: str,
        question: str,
        period_start: str | None = None,
        period_end: str | None = None,
        client_request_id: str | None = None,
    ) -> dict[str, Any]:
        text_question = canonical_question(question)
        if client_request_id is not None:
            try:
                client_request_id = str(UUID(client_request_id))
            except (TypeError, ValueError):
                raise AnswerRequestError("invalid_request_key") from None
        if not MIN_QUESTION_CHARS <= len(text_question) <= MAX_QUESTION_CHARS:
            raise AnswerRequestError("invalid_question")
        period_start = _optional_period_date(period_start)
        period_end = _optional_period_date(period_end)
        if (period_start is None) != (period_end is None):
            raise AnswerRequestError("invalid_period")
        if period_start and period_end and period_start > period_end:
            raise AnswerRequestError("invalid_period")

        started = time.monotonic()

        def insert(connection):
            self._require_active_connection(connection, owner_user_id, requester_user_id)
            row = (
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_requests
                       (request_id, owner_user_id, requester_user_id, question, period_start, period_end)
                       VALUES (COALESCE(CAST(:retry_id AS UUID), gen_random_uuid()), :owner, :requester, :question, :start, :end)
                       ON CONFLICT (request_id) DO NOTHING
                       RETURNING request_id"""
                    ),
                    {
                        "owner": owner_user_id,
                        "retry_id": client_request_id,
                        "requester": requester_user_id,
                        "question": text_question,
                        "start": period_start,
                        "end": period_end,
                    },
                )
                .mappings()
                .first()
            )
            if row is None:
                previous = (
                    connection.execute(
                        text("""SELECT request_id, owner_user_id, requester_user_id,
                    question, period_start, period_end FROM pkm_answer_requests WHERE request_id = CAST(:id AS UUID)"""),
                        {"id": client_request_id},
                    )
                    .mappings()
                    .first()
                )
                if previous is None or (
                    previous["owner_user_id"] != owner_user_id
                    or previous["requester_user_id"] != requester_user_id
                    or previous["question"] != text_question
                    or (
                        str(previous["period_start"])
                        if previous["period_start"] is not None
                        else None
                    )
                    != period_start
                    or (str(previous["period_end"]) if previous["period_end"] is not None else None)
                    != period_end
                ):
                    raise AnswerRequestError("retry_conflict")
                return str(previous["request_id"])
            request_id = str(row["request_id"])
            self._feed(
                connection,
                user_id=owner_user_id,
                event_type="answer_request_received",
                request_id=request_id,
                status="pending_resolution",
            )
            return request_id

        request_id = await self._transaction(insert)
        logger.info(
            "answer.lifecycle request=%s stage=request_create duration_ms=%.2f",
            request_id,
            (time.monotonic() - started) * 1000,
        )
        return {"requestId": request_id}

    async def resolve_pending(self, *, request_id: str | None = None, max_jobs: int = 1) -> None:
        """Claim durable pending rows. Fast wakeups and the existing drain share leases."""

        def claim(connection):
            connection.execute(
                text("""UPDATE pkm_answer_requests
                SET status='awaiting_owner', resolution_mode='skipped',
                    resolution_skipped_reason='resolver_failed', resolution_lease_until=NULL,
                    updated_at=clock_timestamp()
                WHERE status='pending_resolution' AND resolution_attempts>=3
                  AND resolution_lease_until<clock_timestamp()""")
            )
            return [
                str(row[0])
                for row in connection.execute(
                    text("""
                UPDATE pkm_answer_requests SET resolution_lease_until=clock_timestamp()+interval '45 seconds',
                    resolution_attempts=resolution_attempts+1
                WHERE request_id IN (SELECT request_id FROM pkm_answer_requests
                    WHERE status='pending_resolution' AND expires_at>clock_timestamp()
                    AND (:request IS NULL OR request_id=CAST(:request AS uuid))
                    AND (resolution_lease_until IS NULL OR resolution_lease_until<clock_timestamp())
                    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT :limit)
                RETURNING request_id"""),
                    {"request": request_id, "limit": max_jobs},
                )
            ]

        for identifier in await self._transaction(claim):
            try:
                async with asyncio.timeout(30):
                    await self.resolve_scopes(request_id=identifier)
            except Exception:
                # Bounded failure remains visible and explicitly retryable. A
                # killed process is recovered by the next drain after its lease.
                await self._transaction(
                    lambda connection, identifier=identifier: connection.execute(
                        text("""
                    UPDATE pkm_answer_requests SET status='awaiting_owner', resolution_mode='skipped',
                      resolution_skipped_reason='resolver_failed', resolution_lease_until=NULL,
                      updated_at=clock_timestamp() WHERE request_id=:request AND status='pending_resolution'
                """),
                        {"request": identifier},
                    )
                )
                logger.warning("answer.scope_resolution.failed request=%s", identifier)

    async def retry_resolution(self, *, request_id: str, owner_user_id: str) -> None:
        def retry(connection):
            row = self._row(
                connection,
                """SELECT * FROM pkm_answer_requests
                WHERE request_id=:request AND owner_user_id=:owner FOR UPDATE""",
                {"request": request_id, "owner": owner_user_id},
            )
            if row is None or row["status"] != "awaiting_owner" or row["amount_cents"] is not None:
                raise AnswerRequestError("request_not_resolvable")
            self._require_active_connection(connection, owner_user_id, row["requester_user_id"])
            connection.execute(
                text("""UPDATE pkm_answer_requests SET status='pending_resolution',
                resolution_mode=NULL, resolution_skipped_reason=NULL, resolution_lease_until=NULL, resolution_attempts=0,
                updated_at=clock_timestamp() WHERE request_id=:request"""),
                {"request": request_id},
            )
            connection.execute(
                text("DELETE FROM pkm_answer_request_scopes WHERE request_id=:request"),
                {"request": request_id},
            )

        await self._transaction(retry)

    # -------------------------------------------------------------- resolve

    async def resolve_scopes(
        self, *, request_id: str, catalog: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        """Run the semantic resolver, then narrow its proposal deterministically.

        A missing or failing resolver is recorded, not worked around. The owner
        can retry or decline but cannot price unresolved scopes; what must never
        happen is a keyword guess presented as if the agent had judged it.
        """

        def read(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, question, status
                   FROM pkm_answer_requests WHERE request_id = :request""",
                {"request": request_id},
            )
            if request is None:
                raise AnswerRequestError("request_unavailable")
            return request

        started = time.monotonic()
        request = await self._transaction(read)
        if request["status"] != "pending_resolution":
            raise AnswerRequestError("request_not_resolvable")

        if catalog is None:
            catalog = await self._catalog(request["requester_user_id"], request["owner_user_id"])
        handles = [entry["scope"] for entry in catalog]
        labels = {
            entry["scope"]: entry.get("label") or "" for entry in catalog if entry.get("label")
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
                        question=request["question"],
                        candidate_scopes=handles,
                        candidate_labels=labels,
                        user_id=request["owner_user_id"],
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

        # Failure never widens consent: no scopes means retry or decline only.
        resolution = validate_resolved_scopes(
            proposed,
            owner_catalog=handles,
            catalog_labels=labels,
        )
        if resolution.dropped:
            logger.info(
                "answer_scope_resolution.dropped request=%s count=%s reasons=%s",
                request_id,
                len(resolution.dropped),
                sorted({reason for _scope, reason in resolution.dropped}),
            )

        def persist(connection):
            current = self._row(
                connection,
                "SELECT status FROM pkm_answer_requests WHERE request_id=:request FOR UPDATE",
                {"request": request_id},
            )
            if current is None or current["status"] != "pending_resolution":
                raise AnswerRequestError("request_not_resolvable")
            self._require_active_connection(
                connection, request["owner_user_id"], request["requester_user_id"]
            )
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
                           resolution_skipped_reason = :reason, resolution_lease_until = NULL, updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "mode": mode, "reason": skipped_reason},
            )

        await self._transaction(persist)
        logger.info(
            "answer.lifecycle request=%s stage=scope_resolve duration_ms=%.2f outcome=%s",
            request_id,
            (time.monotonic() - started) * 1000,
            mode,
        )
        return {
            "resolutionMode": mode,
            "skippedReason": skipped_reason,
            "proposedScopes": list(resolution.accepted),
            "droppedCount": len(resolution.dropped),
        }

    async def pending_for_owner(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        """Questions awaiting this owner's review, with the resolved scopes.

        Carries `resolutionMode` so unresolved questions offer retry or decline.
        Pricing requires the exact scopes accepted from the semantic resolver.
        """

        def read(connection):
            rows = (
                connection.execute(
                    text(
                        """SELECT request_id, requester_user_id, question, period_start,
                              period_end, resolution_mode, resolution_skipped_reason,
                              created_at
                       FROM pkm_answer_requests
                       WHERE owner_user_id = :owner AND status IN ('awaiting_owner', 'pending_resolution')
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
        model_processing_consent: bool = False,
    ) -> dict[str, Any]:
        """The owner approves the exact question, the exact scopes and a price.

        The approved set must be a subset of what was put in front of them: an
        owner may narrow the resolution, never widen it past validation.
        """
        if not model_processing_consent:
            raise AnswerRequestError("model_processing_consent_required")
        if not valid_answer_price_cents(amount_cents):
            raise AnswerRequestError("invalid_price")
        chosen = sorted({str(scope or "").strip().lower() for scope in scopes if scope})
        if not chosen:
            raise AnswerRequestError("no_scopes_approved")

        request = await self._transaction(
            lambda connection: self._row(
                connection,
                "SELECT requester_user_id FROM pkm_answer_requests WHERE request_id=:request AND owner_user_id=:owner",
                {"request": request_id, "owner": owner_user_id},
            )
        )
        if request is None:
            raise AnswerRequestError("request_unavailable")
        current_catalog = await self._catalog(request["requester_user_id"], owner_user_id)
        current_scopes = {entry["scope"] for entry in current_catalog}
        if not set(chosen).issubset(current_scopes):
            raise AnswerRequestError("scope_not_offered")

        def write(connection):
            request = self._row(
                connection,
                """SELECT * FROM pkm_answer_requests
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["status"] != "awaiting_owner" or request["resolution_mode"] != "agent":
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
                           composer_consent_at = clock_timestamp(),
                           composer_consent_version = 'approved-projection-v1',
                           composer_consent_digest = :digest,
                           updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "amount": amount_cents, "digest": digest},
            )
            self._feed(
                connection,
                user_id=request["requester_user_id"],
                event_type="answer_request_payment_ready",
                request_id=request_id,
                status="approved",
            )
            return digest

        digest = await self._transaction(write)
        return {"approved": True, "termsDigest": digest, "amountCents": amount_cents}

    async def participant_state(self, *, user_id: str, request_id: str) -> dict[str, Any]:
        def read(connection):
            row = self._row(
                connection,
                """SELECT owner_user_id, status, question
                FROM pkm_answer_requests WHERE request_id=:request
                AND (owner_user_id=:user OR requester_user_id=:user)""",
                {"request": request_id, "user": user_id},
            )
            if row is None:
                raise AnswerRequestError("request_unavailable")
            result = {
                "role": "owner" if row["owner_user_id"] == user_id else "requester",
                "requestStatus": row["status"],
                "question": row["question"],
            }
            # Before approval, the proposed selectors are for the owner's
            # review only. After approval, both people may see the exact
            # priced coverage. Labels disclose no PKM values and deliberately
            # make no claim that an omitted fact is absent from memory.
            if row["status"] in {"approved", "answering", "answered"}:
                scopes = (
                    connection.execute(
                        text(
                            """SELECT scope, label, approved FROM pkm_answer_request_scopes
                           WHERE request_id=:request ORDER BY scope"""
                        ),
                        {"request": request_id},
                    )
                    .mappings()
                    .all()
                )
                result["coverage"] = {
                    "included": [
                        {"scope": entry["scope"], "label": entry["label"]}
                        for entry in scopes
                        if entry["approved"]
                    ],
                    "notIncluded": [
                        {"scope": entry["scope"], "label": entry["label"]}
                        for entry in scopes
                        if not entry["approved"]
                    ],
                }
            return result

        return await self._transaction(read)

    async def decline(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        def write(connection):
            request = self._row(
                connection,
                """SELECT status, owner_user_id, requester_user_id
                   FROM pkm_answer_requests WHERE request_id = :request FOR UPDATE""",
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
            self._feed(
                connection,
                user_id=request["requester_user_id"],
                event_type="answer_request_declined",
                request_id=request_id,
                status="declined",
            )
            # The refund obligation is written in the SAME transaction as the
            # decline, so a request can never be declined without the duty to
            # refund it existing beside it. The drain dispatches and retries.
            file_refund(connection, request_id, "owner_declined")
            return request["status"]

        await self._transaction(write)
        return {"declined": True}

    # --------------------------------------------------------------- answer

    async def claim_answerable(self, *, owner_user_id: str, limit: int = 5) -> list[dict[str, Any]]:
        """Approved preparation and historical paid, undelivered owner work.

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
                       LEFT JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                       LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                       WHERE r.owner_user_id = :owner
                         AND (d.request_id IS NULL OR
                              (d.has_content AND
                               (d.source_revisions->>'_composition_terms' IS DISTINCT FROM r.terms_digest)))
                         AND EXISTS (SELECT 1 FROM connections c WHERE c.status='active'
                           AND ((c.user_a_id=r.owner_user_id AND c.user_b_id=r.requester_user_id)
                             OR (c.user_b_id=r.owner_user_id AND c.user_a_id=r.requester_user_id)))
                         AND (
                           -- Staging. The owner has just approved, so their
                           -- device is present and unlocked: the answer is
                           -- prepared now and withheld until payment, and a
                           -- question nothing matches never reaches a price.
                           r.status = 'approved'
                           -- The paid-first path, for a request approved while
                           -- the owner's device could not prepare it.
                           OR (r.status = 'answering'
                               AND o.status = 'paid' AND NOT o.reconciliation_required
                               AND o.stripe_mode IN ('test', 'live')
                               AND r.answer_deadline_at > clock_timestamp())
                         )
                       ORDER BY r.approved_at
                       LIMIT :limit"""
                    ),
                    {
                        "owner": owner_user_id,
                        "limit": max(1, min(int(limit), 25)),
                    },
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
                        "requesterUserId": row["requester_user_id"],
                    }
                )
            # Attach the requester's published ECDH recipient key so the device
            # can seal in one pass. Reuses the marketplace key store (migration
            # 080) rather than standing up a second key plane, and reads it on
            # this same connection instead of the global client.
            identity = (
                self._row(
                    connection,
                    """SELECT display_name, email, COALESCE(NULLIF(custom_photo_url, ''), photo_url) AS photo_url FROM actor_identity_cache
                   WHERE user_id = :owner LIMIT 1""",
                    {"owner": owner_user_id},
                )
                or {}
            )
            ready: list[dict[str, Any]] = []
            for item in out:
                # The owner's own public identity. The requester already sees
                # this on the profile they asked from, so including it in the
                # answer's memory document reveals nothing new -- it just makes
                # the document a record of the person rather than a bag of
                # fields.
                item["ownerIdentity"] = {
                    "displayName": identity.get("display_name"),
                    "email": identity.get("email"),
                    "photoUrl": identity.get("photo_url"),
                }
                key = (
                    connection.execute(
                        text(
                            """SELECT key_id, public_key_jwk, algorithm
                           FROM marketplace_recipient_keys
                           WHERE user_id = :user AND status = 'active'
                           ORDER BY created_at DESC LIMIT 1"""
                        ),
                        {"user": item["requesterUserId"]},
                    )
                    .mappings()
                    .first()
                )
                if not key or not key["key_id"] or not key["public_key_jwk"]:
                    # Not a failure: the sweep retries, exactly as the
                    # marketplace does for RecipientKeyUnavailableError.
                    logger.info(
                        "answer_delivery.recipient_key_unavailable request=%s",
                        item["requestId"],
                    )
                    continue
                item["recipientKey"] = {
                    "keyId": key["key_id"],
                    "publicKeyJwk": key["public_key_jwk"],
                    "algorithm": key["algorithm"],
                }
                ready.append(item)
            return ready

        return await self._transaction(read)

    async def assert_answerable(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        """Confirm this owner may answer this request right now, and return it.

        The same gate as delivery, run before any model work, so the compose
        endpoint cannot be used as a free model call on an unpaid, cancelled
        or someone else's request.
        """

        def read(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, status, question, terms_digest,
                          period_start, period_end, answer_deadline_at, composer_consent_digest
                   FROM pkm_answer_requests WHERE request_id = :request FOR SHARE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            if request["status"] not in {"approved", "answering"}:
                raise AnswerRequestError("request_not_answerable")
            self._require_active_connection(connection, owner_user_id, request["requester_user_id"])
            # A staged answer is prepared before any money moves, so it has no
            # fulfilment clock and nothing to have been paid for yet. Both
            # checks still bind the paid-first path exactly as before.
            if request["status"] == "answering":
                if request["answer_deadline_at"] is None or request[
                    "answer_deadline_at"
                ] <= datetime.now(UTC):
                    raise AnswerRequestError("request_not_answerable")
                PkmAnswerPaymentService.require_paid_answer(connection, request)
            scope_rows = (
                connection.execute(
                    text(
                        """SELECT scope, label, approved FROM pkm_answer_request_scopes
                       WHERE request_id=:request ORDER BY scope"""
                    ),
                    {"request": request_id},
                )
                .mappings()
                .all()
            )
            return {
                "requestId": str(request["request_id"]),
                "termsDigest": request["terms_digest"],
                "question": request["question"],
                "modelProcessingConsented": request["composer_consent_digest"]
                == request["terms_digest"],
                "approvedScopes": [r["scope"] for r in scope_rows if r["approved"]],
                # The writer derives safe labels from these validated scope
                # IDs. Registry labels may be user-authored and must not enter
                # the model's instructions.
                "omittedScopes": [r["scope"] for r in scope_rows if not r["approved"]],
                "period": (
                    {
                        "start": request["period_start"].isoformat(),
                        "end": request["period_end"].isoformat(),
                    }
                    if request["period_start"] and request["period_end"]
                    else None
                ),
            }

        return await self._transaction(read)

    async def deliver(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        envelope: dict[str, Any],
        source_revisions: dict[str, Any] | None = None,
        has_content: bool = True,
        composition_receipt: str | None = None,
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
        if source_revisions is not None and (
            not isinstance(source_revisions, dict)
            or len(source_revisions) > 100
            or any(
                not isinstance(key, str)
                or len(key) > 200
                or key.startswith("_")
                or (value is not None and (type(value) is not int or not 0 <= value <= 2**53 - 1))
                for key, value in source_revisions.items()
            )
        ):
            raise AnswerRequestError("invalid_envelope")

        def write(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, status, terms_digest, answer_deadline_at,
                          composer_consent_digest
                   FROM pkm_answer_requests WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["owner_user_id"] != owner_user_id:
                raise AnswerRequestError("request_unavailable")
            staging = request["status"] == "approved"
            if request["status"] not in {"approved", "answering"}:
                raise AnswerRequestError("request_not_answerable")
            # The gate, inside the delivery transaction, after the lock.
            self._require_active_connection(connection, owner_user_id, request["requester_user_id"])
            if not staging:
                if request["answer_deadline_at"] is None or request[
                    "answer_deadline_at"
                ] <= datetime.now(UTC):
                    raise AnswerRequestError("request_not_answerable")
                PkmAnswerPaymentService.require_paid_answer(connection, request)

            recipient = self._row(
                connection,
                """SELECT key_id FROM marketplace_recipient_keys
                WHERE user_id=:requester AND key_id=:key AND status='active' FOR SHARE""",
                {"requester": request["requester_user_id"], "key": envelope["recipientKeyId"]},
            )
            if recipient is None:
                raise AnswerRequestError("invalid_envelope")
            revisions = dict(source_revisions or {})
            if has_content:
                if request["composer_consent_digest"] != request["terms_digest"]:
                    raise AnswerRequestError("model_processing_consent_required")
                try:
                    verify_composition_receipt(
                        composition_receipt,
                        request_id=request_id,
                        owner_user_id=owner_user_id,
                        terms_digest=request["terms_digest"],
                    )
                except CompositionReceiptError:
                    raise AnswerRequestError("composition_receipt_required") from None
                revisions[COMPOSITION_RECEIPT_KEY] = composition_receipt
                revisions[COMPOSITION_TERMS_KEY] = request["terms_digest"]
            connection.execute(
                text(
                    """INSERT INTO pkm_answer_deliveries
                       (request_id, recipient_key_id, ciphertext, iv,
                        sender_ephemeral_public_key_jwk, source_revisions, has_content)
                       VALUES (:request, :key_id, :ciphertext, :iv,
                               CAST(:jwk AS JSONB), CAST(:revisions AS JSONB), :has_content)
                       ON CONFLICT (request_id) DO UPDATE SET
                         recipient_key_id=EXCLUDED.recipient_key_id,
                         ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
                         sender_ephemeral_public_key_jwk=EXCLUDED.sender_ephemeral_public_key_jwk,
                         source_revisions=EXCLUDED.source_revisions,
                         has_content=EXCLUDED.has_content,
                         created_at=clock_timestamp()
                       WHERE pkm_answer_deliveries.has_content
                         AND ((pkm_answer_deliveries.source_revisions->>'_composition_terms'
                              IS DISTINCT FROM EXCLUDED.source_revisions->>'_composition_terms'
                              AND EXCLUDED.source_revisions ? '_composition_receipt')
                           OR (NOT EXCLUDED.has_content
                               AND NOT pkm_answer_deliveries.source_revisions ? '_composition_receipt'))"""
                ),
                {
                    "request": request_id,
                    "key_id": envelope["recipientKeyId"],
                    "ciphertext": envelope["ciphertext"],
                    "iv": envelope["iv"],
                    "jwk": json.dumps(envelope["senderEphemeralPublicKeyJwk"]),
                    "revisions": json.dumps(revisions),
                    "has_content": bool(has_content),
                },
            )
            stored = self._row(
                connection,
                "SELECT has_content, source_revisions FROM pkm_answer_deliveries WHERE request_id=:request",
                {"request": request_id},
            )
            stored_has_content = bool(stored["has_content"])
            if stored_has_content and not PkmAnswerPaymentService._has_composed_answer(
                stored, request
            ):
                # A duplicate empty delivery must never release a legacy
                # success envelope which has not yet been repaired by Gemini.
                raise AnswerRequestError("composition_receipt_required")
            if staging:
                # Prepared, sealed to the requester's key, and withheld. The
                # request stays `approved`: nothing is owed, nothing is owned,
                # and `fetch_answer` refuses anything that is not `answered`.
                # Settlement releases it, so no second owner action and no
                # second unlock stand between a verified payment and the answer.
                self._feed(
                    connection,
                    user_id=request["requester_user_id"],
                    event_type=(
                        "answer_request_payment_ready"
                        if stored_has_content
                        else "answer_request_declined"
                    ),
                    request_id=request_id,
                    status="staged" if stored_has_content else "empty",
                )
                return stored_has_content
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
                {"request": request_id, "earning": "due" if stored_has_content else "none"},
            )
            if not stored_has_content:
                # No charge when the approved scopes yielded nothing. Filed
                # here so the refund cannot be lost between the delivery
                # commit and a separate provider call.
                file_refund(connection, request_id, "empty_answer")
            self._feed(
                connection,
                user_id=request["requester_user_id"],
                event_type="answer_delivered",
                request_id=request_id,
                status="answered" if stored_has_content else "empty",
            )
            return stored_has_content

        stored_has_content = await self._transaction(write)
        return {"delivered": True, "hasContent": stored_has_content}

    async def fetch_answer(self, *, requester_user_id: str, request_id: str) -> dict[str, Any]:
        def read(connection):
            row = self._row(
                connection,
                """SELECT d.recipient_key_id, d.ciphertext, d.iv,
                          d.sender_ephemeral_public_key_jwk, d.algorithm,
                          d.source_revisions, d.has_content,
                          r.request_id, r.status, r.terms_digest
                   FROM pkm_answer_deliveries d
                   JOIN pkm_answer_requests r ON r.request_id = d.request_id
                   WHERE d.request_id = :request AND r.requester_user_id = :requester
                   FOR SHARE OF r""",
                {"request": request_id, "requester": requester_user_id},
            )
            if row is None:
                raise AnswerRequestError("answer_unavailable")
            # The envelope is staged before payment so the requester is never
            # asked to buy an answer that does not exist. It is sealed to their
            # own key, so withholding it is this gate and nothing else: without
            # it, staging would hand away the answer for free.
            if row["status"] != "answered":
                raise AnswerRequestError("answer_unavailable")
            PkmAnswerPaymentService.require_paid_answer(connection, row)
            return row

        row = await self._transaction(read)
        return {
            "recipientKeyId": row["recipient_key_id"],
            "ciphertext": row["ciphertext"],
            "iv": row["iv"],
            "senderEphemeralPublicKeyJwk": row["sender_ephemeral_public_key_jwk"],
            "algorithm": row["algorithm"],
            "sourceRevisions": {
                key: value
                for key, value in row["source_revisions"].items()
                if key not in {COMPOSITION_RECEIPT_KEY, COMPOSITION_TERMS_KEY}
            },
            "hasContent": row["has_content"],
        }

    # --------------------------------------------------------------- cancel

    async def cancel(self, *, requester_user_id: str, request_id: str) -> dict[str, Any]:
        """The requester withdraws before delivery and is refunded in full."""

        def write(connection):
            request = self._row(
                connection,
                """SELECT r.status, r.requester_user_id
                   FROM pkm_answer_requests r
                   WHERE r.request_id = :request FOR UPDATE OF r""",
                {"request": request_id},
            )
            if request is None or request["requester_user_id"] != requester_user_id:
                raise AnswerRequestError("request_unavailable")
            # A sealed pre-payment envelope is staged, not delivered. Only
            # settlement's release transition ends the cancellation window.
            if request["status"] == "answered":
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
            file_refund(connection, request_id, "requester_cancelled")
            return request["status"]

        await self._transaction(write)
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
            # File each refund in the SAME transaction as the expiry. A
            # request cannot be marked expired without the duty to refund it
            # existing beside it; the drain dispatches and retries that duty.
            filed = 0
            for row in rows:
                filed += file_refund(connection, str(row["request_id"]), "answer_timeout")
            return len(rows), filed

        expired, filed = await self._transaction(claim)
        return {"expired": expired, "refunds_filed": filed}
