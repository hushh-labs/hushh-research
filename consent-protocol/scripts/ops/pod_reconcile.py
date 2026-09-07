#!/usr/bin/env python3
"""Fleet-first orphan reconciliation -- REPORT ONLY.

The one check that catches a billing Cloud Run pod with NO registry row. Every
other reconciler is registry-first and so is blind to a live service that has no
row at all (a pod that outlived its account delete). This enumerates the live
fleet and outer-joins complete registry host claims on recorded cloud coordinates.

    uv run python scripts/ops/pod_reconcile.py --project hushh-pda-dev --region us-central1

Deletes NOTHING. It names the two abandonment directions and stops. Reclaiming a
Direction-B orphan (deleting billing compute in a possibly customer-owned project)
is founder-gated behind PERSONAL_AGENT_FLEET_RECLAIM_ENABLED and is never done here.
"""

from __future__ import annotations

import argparse
import asyncio

from hushh_mcp.services.pod_reconcile import classify_fleet_registry_mismatch

POD_LABEL = "app=hussh-one-pod"


def _fleet_service_names(project: str, region: str) -> list[str]:
    # Route through GcpRunClient.list_services rather than a hand-rolled GET so a 403
    # (an identity that cannot list the project's services) SURFACES as an error rather
    # than an empty list -- a report that shows a project swept-clean when it was merely
    # unreadable would send an operator hunting for orphans that were never gone (R8).
    from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

    items = GcpRunClient(project=project, region=region).list_services(POD_LABEL)
    return [str((svc.get("metadata") or {}).get("name") or "") for svc in items]


async def _registry_rows() -> list[dict]:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    return await PersonalAgentRegistryRepo().fetch_fleet_inventory()


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet-first orphan reconciliation (report only).")
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    args = ap.parse_args()

    names = _fleet_service_names(args.project, args.region)
    rows = asyncio.run(_registry_rows())
    result = classify_fleet_registry_mismatch(
        fleet_service_names=names,
        registry_rows=rows,
        project=args.project,
        region=args.region,
    )
    a, b = result["direction_a"], result["direction_b"]

    print(f"fleet_services={len(names)} registry_rows={len(rows)}")
    print(f"\nDirection A -- active host claims missing from this fleet observation: {len(a)}")
    for d in a:
        print(f"  {d['service']}  hushh_id={d['hushh_id']}  status={d['status']}")
    print(
        f"\nDirection B -- observed services with no registry claim (review candidates): {len(b)}"
    )
    for d in b:
        print(f"  {d['service']}")
    print(f"\nInactive rows retaining an observed host: {len(result['inactive_claims'])}")
    for d in result["inactive_claims"]:
        print(f"  {d['service']}  status={d['status']}")
    print(f"Unresolved registry claims: {len(result['unresolved'])}")
    if result["unresolved"]:
        print("INCOMPLETE -- unresolved claims suppress orphan conclusions.")
    print(
        "\nREPORT ONLY -- nothing deleted. Reclaim is founder-gated (PERSONAL_AGENT_FLEET_RECLAIM_ENABLED)."
    )
    return 2 if result["unresolved"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
