#!/usr/bin/env python3
"""Synchronize reviewed provider feeds into the existing private catalog mount.

Use the normal backend environment/bootstrap. Dry-run is the default. --apply
publishes approved assets and verified revocations. No owner records are read.
Only aggregate counters and closed error codes are printed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.wallet_artwork_providers import configured_artwork_providers  # noqa: E402
from hushh_mcp.services.wallet_artwork_sync import synchronize_artwork  # noqa: E402


async def run(*, apply: bool, provider_id: str | None) -> tuple[dict, int]:
    providers = configured_artwork_providers()
    if provider_id is not None:
        providers = {key: value for key, value in providers.items() if key == provider_id}
    target = os.getenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", "").strip()
    if not providers or not target:
        return {
            "enabled": False,
            "reason": "provider_or_catalog_unconfigured",
            "providerCount": 0,
        }, 2
    results = []
    for provider in providers.values():
        try:
            results.append(await synchronize_artwork(provider, Path(target), apply=apply))
        except Exception:
            # Exception text may contain provider URLs, responses or credential
            # values. Keep even schema and transport diagnostics aggregate-only.
            results.append({"applied": False, "error": "provider_sync_failed"})
    failed = sum("error" in result for result in results)
    return {
        "enabled": True,
        "dryRun": not apply,
        "providerCount": len(results),
        "failed": failed,
        "results": results,
    }, int(bool(failed))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--provider", dest="provider_id")
    args = parser.parse_args()
    result, code = asyncio.run(run(apply=args.apply, provider_id=args.provider_id))
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
