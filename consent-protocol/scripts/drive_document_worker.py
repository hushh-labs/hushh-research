#!/usr/bin/env python3
"""Cloud Run Job entrypoint. No loop, owner session token or raw-content logs."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_modules.log_redaction import install_sensitive_log_filter  # noqa: E402

install_sensitive_log_filter()

from db.connection import close_pool  # noqa: E402
from hushh_mcp.services.drive_document_worker import DriveDocumentWorker  # noqa: E402


async def main() -> int:
    worker = None
    try:
        worker = DriveDocumentWorker()
        result = await worker.run()
        print(json.dumps(result, sort_keys=True))
        return 1 if result["outcomes"].get("not_ready") or result["outcomes"].get("deadline") else 0
    except Exception:
        print(json.dumps({"schema_version": "drive.worker.v1", "status": "unavailable"}))
        return 1
    finally:
        if worker is not None:
            worker.service.store.db.engine.dispose()
        await close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
