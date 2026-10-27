"""Issued delivery reconciliation and erasure inventory, independent of intake."""

import asyncio
import time
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.document_delivery.service import DocumentDeliveryService
from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore, delivery_summary


def fence_erasure(connection, *, request_id):
    if (
        connection.execute(text("SELECT to_regclass('document_delivery_contracts')")).scalar()
        is None
    ):
        return
    contract = (
        connection.execute(
            text("SELECT * FROM document_delivery_contracts WHERE request_id=:request FOR UPDATE"),
            {"request": request_id},
        )
        .mappings()
        .first()
    )
    if contract is None:
        return
    # Fence new releases before recording irreversible disclosures, then retain
    # only opaque financial counts and object cleanup custody after cascade.
    connection.execute(
        text("""UPDATE document_delivery_contracts SET status='erasing',
      hosted_revoked_at=COALESCE(hosted_revoked_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE request_id=:request"""),
        {"request": request_id},
    )
    summary = delivery_summary(connection, str(request_id))
    connection.execute(
        text("""UPDATE document_delivery_financial_bindings SET confirmed_count=:confirmed,
      unsettled_count=:unsettled,erased_at=clock_timestamp() WHERE request_id=:request"""),
        {"request": request_id, **summary},
    )
    connection.execute(
        text("""UPDATE drive_request_payment_obligations SET
      delivery_confirmed_at_erasure=(delivery_confirmed_at_erasure OR :confirmed>0),
      delivery_unsettled_at_erasure=(delivery_unsettled_at_erasure OR :unsettled>0)
      WHERE request_id=:request"""),
        {"request": request_id, **summary},
    )
    DocumentDeliveryStore._enqueue_cleanup(connection, str(request_id))


async def _sync_revocations(store, max_jobs):
    stops = await store._transaction(
        lambda connection: [
            dict(row)
            for row in connection.execute(
                text("""SELECT
      request_id,owner_user_id FROM document_delivery_contracts WHERE drive_revoke_status='pending'
      ORDER BY updated_at,request_id LIMIT :limit"""),
                {"limit": max_jobs},
            ).mappings()
        ]
    )
    for stop in stops:

        def sync(connection, stop=stop):
            from hushh_mcp.services.document_delivery.drive_bridge import (
                sync_revocation,
            )

            request, contract = store._locked(
                connection,
                request_id=str(stop["request_id"]),
                actor=stop["owner_user_id"],
                owner_only=True,
            )
            return sync_revocation(store, connection, request=request, contract=contract)

        await store._transaction(sync)


class DocumentDeliveryWorker:
    def __init__(self, service=None):
        self.service = service or DocumentDeliveryService()

    async def run(self, *, max_jobs=8, deadline_seconds=35):
        if type(max_jobs) is not int or not 1 <= max_jobs <= 20 or not 1 <= deadline_seconds <= 540:
            raise ValueError("invalid document delivery worker bounds")
        counts = Counter()
        started = time.monotonic()
        store = self.service.store
        try:
            async with asyncio.timeout(deadline_seconds):
                if not await store._transaction(store.schema_ready):
                    return {
                        "schema_version": "document.delivery.worker.v1",
                        "outcomes": {"unavailable": 1},
                    }
                await _sync_revocations(store, max_jobs)
                rows = await store._transaction(
                    lambda connection: [
                        dict(row)
                        for row in connection.execute(
                            text("""SELECT
                  c.request_id,c.recipient_user_id FROM document_delivery_contracts c
                  JOIN drive_request_payment_orders o ON o.request_id=c.request_id
                  WHERE o.status='paid' AND o.reconciliation_required=FALSE
                    AND c.status IN ('approved','released') AND c.access_expires_at>clock_timestamp()
                  ORDER BY c.updated_at,c.request_id LIMIT :limit"""),
                            {"limit": max_jobs},
                        ).mappings()
                    ]
                )
                for row in rows:
                    try:
                        await store.release(
                            request_id=str(row["request_id"]), actor=row["recipient_user_id"]
                        )
                        counts["released"] += 1
                    except DeliveryError:
                        counts["held"] += 1
                    finally:

                        def rotate(connection, row=row):
                            try:
                                store._locked(
                                    connection,
                                    request_id=str(row["request_id"]),
                                    actor=row["recipient_user_id"],
                                )
                            except DeliveryError:
                                return
                            connection.execute(
                                text(
                                    "UPDATE document_delivery_contracts SET updated_at=clock_timestamp() WHERE request_id=:request"
                                ),
                                {"request": row["request_id"]},
                            )

                        await store._transaction(rotate)
                result = await self.service.cleanup(limit=max_jobs)
                counts.update(result["outcomes"])
                from .background_service import run_remaining

                await run_remaining(
                    self.service, counts, max_jobs, deadline_seconds - (time.monotonic() - started)
                )
        except TimeoutError:
            counts["deadline"] += 1
        except Exception:
            counts["unavailable"] += 1
        return {"schema_version": "document.delivery.worker.v1", "outcomes": dict(counts)}


def erase_participant_custody(connection, *, user_id, exists):
    params = {"user": user_id}
    if exists(connection, "document_delivery_contracts"):
        # Normally removed by the request cascade above. Explicit participant
        # cleanup also declares both UID roles to the erasure inventory.
        connection.execute(
            text(
                "DELETE FROM document_delivery_contracts WHERE owner_user_id=:user OR recipient_user_id=:user"
            ),
            params,
        )
        connection.execute(
            text("DELETE FROM document_delivery_key_challenges WHERE user_id=:user"), params
        )
        connection.execute(
            text("DELETE FROM document_delivery_activity WHERE actor_user_id=:user"), params
        )
    if exists(connection, "document_delivery_public_keys"):
        # Both account reset and deletion enter through this transaction.
        # Remove the participant's historical public directory only after the
        # request cascades have retained opaque money/object obligations.
        connection.execute(
            text("DELETE FROM document_delivery_public_keys WHERE user_id=:user"), params
        )

    if exists(connection, "drive_packet_heads"):
        # Reset retains the connector's generation fence, so its FK cannot
        # erase packet keys/manifests. Remove this owner's packet family after
        # the request/financial erasure above has preserved its minimal ledger.
        connection.execute(text("DELETE FROM drive_packet_heads WHERE user_id=:user"), params)
