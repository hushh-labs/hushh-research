#!/usr/bin/env python3
"""Scheduled RIA marketplace public investor deck replenisher.

Designed for Cloud Scheduler -> Cloud Run Jobs. The job writes only
official/public-source investor discovery rows into investor_profiles and emits
one JSON log line with run counts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from db.connection import close_pool  # noqa: E402
from hushh_mcp.services.marketplace_investor_replenisher import (  # noqa: E402
    MarketplaceInvestorReplenisher,
)


async def _main() -> int:
    logging.basicConfig(level=logging.INFO)
    try:
        result = await MarketplaceInvestorReplenisher().run()
        print(json.dumps(result.to_log_payload(), sort_keys=True))
        return 0
    finally:
        await close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
