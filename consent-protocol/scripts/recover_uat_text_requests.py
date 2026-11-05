#!/usr/bin/env python3
"""Bounded UAT processor recovery; preview by default, no model/payment/ACL I/O."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def recover(*, apply: bool, limit: int, deadline: float) -> dict:
    from sqlalchemy import text

    from hushh_mcp.runtime_providers.managed_text import managed_text_binding, managed_text_policy
    from hushh_mcp.services.drive_owner_allowed import semantic_search_request
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
    from hushh_mcp.services.drive_work_wake import wake_drive_work
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    if not 1 <= limit <= 20 or managed_text_policy() is None:
        raise ValueError("Bounded processor recovery requires the active UAT policy")
    store = DriveOwnerSearchStore()
    target = managed_text_binding()

    # Bounded metadata inspection excludes expired/terminal history, never reads documents.
    def scan(connection):
        return (
            connection.execute(
                text("""SELECT j.user_id,j.client_request_id,j.status,
                               r.revision,r.request_envelope
            FROM drive_owner_search_jobs j JOIN drive_share_requests r
              ON r.request_id=j.client_request_id AND r.user_id=j.user_id
            WHERE (j.status IN ('queued','failed') OR j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp())) AND r.status='pending'
              AND r.access_stop_requested_at IS NULL
              AND j.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
            ORDER BY j.updated_at DESC LIMIT :limit"""),
                {"limit": 200},
            )
            .mappings()
            .all()
        )

    counts = Counter(
        inspected=0, migrated=0, resumed=0, already_current=0, legacy=0, refused=0, out_of_scope=0
    )

    def require_time(stage):
        if time.monotonic() >= deadline:
            print(
                json.dumps(
                    {
                        "uat_processor_recovery": "incomplete",
                        "reason": "application_deadline",
                        "stage": stage,
                        "counts": dict(counts),
                    }
                )
            )
            raise TimeoutError("UAT recovery exhausted its application budget")

    require_time("scan")
    jobs = await store._transaction(scan)
    require_time("scan")
    attempted = 0
    for row in jobs:
        if attempted >= limit:
            break
        require_time("apply" if apply else "preview")
        counts["inspected"] += 1
        private = store.search_cipher.open(
            row["request_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["client_request_id"]),
            purpose="request",
        )

        if not semantic_search_request(private):
            counts["out_of_scope"] += 1
            continue
        if private.get("semantic_model_binding") == target:
            counts["already_current"] += 1
            if row["status"] != "failed":
                continue
            attempted += 1
            if apply:
                require_time("apply")
                try:
                    _, changed = await store.retry_failed_request(
                        user_id=row["user_id"],
                        request_id=str(row["client_request_id"]),
                        request_revision=row["revision"],
                        authority_mode="trusted_auto",
                    )
                    counts["resumed"] += int(changed)
                except DriveReadError:
                    counts["refused"] += 1
            continue
        attempted += 1
        counts["legacy"] += 1
        if apply:
            require_time("apply")
            try:
                changed = await store.migrate_request_processor(
                    user_id=row["user_id"], request_id=str(row["client_request_id"])
                )
                counts["migrated"] += int(changed)
            except DriveReadError:
                counts["refused"] += 1
    # The store rechecks the current authority inside its transaction. Observe
    # completion before reporting the deadline, since cancelling a thread
    # await cannot undo a committed database operation.
    require_time("apply" if apply else "preview")
    if counts["migrated"] or counts["resumed"]:
        await wake_drive_work("suggestions")
        require_time("wake")
    return {
        "uat_processor_recovery": "completed",
        "mode": "apply" if apply else "preview",
        "policy_generation": target["approval_generation"],
        "limit": limit,
        "scan_limit": 200,
        "counts": dict(counts),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    try:
        result = asyncio.run(
            recover(apply=args.apply, limit=args.limit, deadline=time.monotonic() + 90)
        )
    except Exception as error:
        print(json.dumps({"uat_processor_recovery": "failed", "error_type": type(error).__name__}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
