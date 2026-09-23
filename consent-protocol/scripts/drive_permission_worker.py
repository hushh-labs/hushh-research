#!/usr/bin/env python3
"""Finite permission-worker entrypoint. Deployment/scheduling is a release gate."""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_modules.log_redaction import install_sensitive_log_filter  # noqa: E402

install_sensitive_log_filter()

from api.utils.firebase_admin import ensure_firebase_auth_admin  # noqa: E402
from db.connection import close_pool  # noqa: E402
from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker  # noqa: E402


async def main():
    worker = None
    try:
        configured, _ = ensure_firebase_auth_admin()
        if not configured:
            raise RuntimeError("identity unavailable")
        worker = DrivePermissionWorker()
        result = await worker.run()
        print(json.dumps(result, sort_keys=True))
        return int(
            bool(result["outcomes"].get("unavailable") or result["outcomes"].get("deadline"))
        )
    except Exception:
        print(
            json.dumps({"schema_version": "drive.permissions.worker.v1", "status": "unavailable"})
        )
        return 1
    finally:
        if worker is not None:
            worker.executor.store.db.engine.dispose()
        await close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
