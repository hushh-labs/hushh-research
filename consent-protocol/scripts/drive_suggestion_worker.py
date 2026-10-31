#!/usr/bin/env python3
"""Finite suggestion-worker entrypoint; deploy only after runtime acceptance."""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_modules.log_redaction import install_sensitive_log_filter  # noqa: E402

install_sensitive_log_filter()

from db.connection import close_pool  # noqa: E402
from hushh_mcp.services.drive_suggestion_worker import DriveSuggestionWorker  # noqa: E402


async def main():
    worker = None
    try:
        worker = DriveSuggestionWorker()
        result = await worker.run()
        print(json.dumps(result, sort_keys=True))
        return int(
            bool(result["outcomes"].get("unavailable") or result["outcomes"].get("deadline"))
        )
    except Exception:
        print(
            json.dumps({"schema_version": "drive.suggestions.worker.v1", "status": "unavailable"})
        )
        return 1
    finally:
        if worker is not None:
            worker.service.store.db.engine.dispose()
        await close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
