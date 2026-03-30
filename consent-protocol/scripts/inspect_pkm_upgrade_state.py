from __future__ import annotations

import argparse
import asyncio
import json

from api.routes.pkm_routes_shared import _normalize_manifest_response_payload
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.pkm_upgrade_service import get_pkm_upgrade_service


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect raw + normalized PKM manifest state and upgrade status for a user."
    )
    parser.add_argument("--user-id", required=True, help="Target user id")
    parser.add_argument(
        "--domain",
        default="financial",
        help="PKM domain to inspect (default: financial)",
    )
    args = parser.parse_args()

    pkm_service = get_pkm_service()
    upgrade_service = get_pkm_upgrade_service()

    raw_manifest = await pkm_service.get_domain_manifest(args.user_id, args.domain)
    normalized_manifest = (
        _normalize_manifest_response_payload(raw_manifest) if raw_manifest is not None else None
    )
    upgrade_status = await upgrade_service.build_status(args.user_id)

    print("=== RAW MANIFEST ===")
    print(json.dumps(raw_manifest, indent=2, default=str))
    print("\n=== NORMALIZED MANIFEST ===")
    print(json.dumps(normalized_manifest, indent=2, default=str))
    print("\n=== UPGRADE STATUS ===")
    print(json.dumps(upgrade_status, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
