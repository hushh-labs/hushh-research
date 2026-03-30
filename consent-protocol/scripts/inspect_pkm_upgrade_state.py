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
    latest_run = upgrade_status.get("run") if isinstance(upgrade_status, dict) else None
    latest_steps = latest_run.get("steps") if isinstance(latest_run, dict) else None
    effective_truth = None
    if isinstance(normalized_manifest, dict):
        effective_truth = {
            "domain": args.domain,
            "manifest_domain_contract_version": normalized_manifest.get("domain_contract_version"),
            "manifest_readable_summary_version": normalized_manifest.get(
                "readable_summary_version"
            ),
            "manifest_upgraded_at": normalized_manifest.get("upgraded_at"),
        }
    version_truth = None
    if isinstance(upgrade_status, dict):
        version_truth = {
            "stored_model_version": upgrade_status.get("stored_model_version"),
            "effective_model_version": upgrade_status.get("effective_model_version"),
            "reported_model_version": upgrade_status.get("model_version"),
            "target_model_version": upgrade_status.get("target_model_version"),
            "upgrade_status": upgrade_status.get("upgrade_status"),
        }

    print("=== RAW MANIFEST ===")
    print(json.dumps(raw_manifest, indent=2, default=str))
    print("\n=== NORMALIZED MANIFEST ===")
    print(json.dumps(normalized_manifest, indent=2, default=str))
    print("\n=== EFFECTIVE MANIFEST TRUTH ===")
    print(json.dumps(effective_truth, indent=2, default=str))
    print("\n=== VERSION TRUTH ===")
    print(json.dumps(version_truth, indent=2, default=str))
    print("\n=== UPGRADE STATUS ===")
    print(json.dumps(upgrade_status, indent=2, default=str))
    print("\n=== LATEST RUN ===")
    print(json.dumps(latest_run, indent=2, default=str))
    print("\n=== LATEST STEPS ===")
    print(json.dumps(latest_steps, indent=2, default=str))
    print("\n=== LAST ERROR CONTEXT ===")
    print(json.dumps((latest_run or {}).get("error_context"), indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
