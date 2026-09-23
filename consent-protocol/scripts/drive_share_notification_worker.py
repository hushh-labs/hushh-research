#!/usr/bin/env python3
"""Finite metadata-only Drive-share push outbox entrypoint.

Scheduling this process is a release/acceptance decision. It does not retain an
owner session, decrypt a Drive-sharing envelope, or claim a push was received.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_modules.log_redaction import install_sensitive_log_filter  # noqa: E402

install_sensitive_log_filter()

from db.connection import close_pool  # noqa: E402
from hushh_mcp.services.drive_share_notification_worker import (  # noqa: E402
    DriveShareNotificationWorker,
)


async def main() -> int:
    worker = None
    try:
        worker = DriveShareNotificationWorker()
        result = await worker.run()
        print(json.dumps(result, sort_keys=True))
        return int(
            bool(result["outcomes"].get("unavailable") or result["outcomes"].get("deadline"))
        )
    except Exception:
        print(
            json.dumps(
                {"schema_version": "drive.share_notifications.worker.v1", "status": "unavailable"}
            )
        )
        return 1
    finally:
        if worker is not None:
            worker.store.db.engine.dispose()
        await close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
