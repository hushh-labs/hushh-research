#!/usr/bin/env python3
"""Fleet-first orphan reconciliation -- REPORT ONLY.

The one check that catches a billing Cloud Run pod with NO registry row. Every
other reconciler is registry-first and so is blind to a live service that has no
row at all (a pod that outlived its account delete). This enumerates the live
fleet and outer-joins the registry on the deterministic service name.

    uv run python scripts/ops/pod_reconcile.py --project hushh-pda-dev --region us-central1

Deletes NOTHING. It names the two abandonment directions and stops. Reclaiming a
Direction-B orphan (deleting billing compute in a possibly customer-owned project)
is founder-gated behind PERSONAL_AGENT_FLEET_RECLAIM_ENABLED and is never done here.
"""

from __future__ import annotations

import argparse
import asyncio

from hushh_mcp.services.gcp_run_client import load_operator_credentials
from hushh_mcp.services.pod_reconcile import classify_fleet_registry_mismatch

POD_LABEL = "app=hussh-one-pod"


def _fleet_service_names(project: str, region: str) -> list[str]:
    import requests  # noqa: F401,PLC0415  (AuthorizedSession wraps requests)
    from google.auth.transport.requests import AuthorizedSession  # noqa: PLC0415

    session = AuthorizedSession(load_operator_credentials())
    base = f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project}"
    r = session.get(f"{base}/services", params={"labelSelector": POD_LABEL}, timeout=120)
    r.raise_for_status()
    return [
        str((svc.get("metadata") or {}).get("name") or "") for svc in (r.json().get("items") or [])
    ]


async def _registry_rows() -> list[dict]:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    # fetch_liveness_candidates returns the provisioned/active rows -- the set the
    # fleet is joined against. (A v2 could widen this to every active status.)
    return await PersonalAgentRegistryRepo().fetch_liveness_candidates(limit=1000)


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet-first orphan reconciliation (report only).")
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    args = ap.parse_args()

    names = _fleet_service_names(args.project, args.region)
    rows = asyncio.run(_registry_rows())
    result = classify_fleet_registry_mismatch(fleet_service_names=names, registry_rows=rows)
    a, b = result["direction_a"], result["direction_b"]

    print(f"fleet_services={len(names)} registry_active={len(rows)}")
    print(f"\nDirection A -- rows claiming a host the fleet lacks (retry these): {len(a)}")
    for d in a:
        print(f"  {d['service']}  hushh_id={d['hushh_id']}  status={d['status']}")
    print(f"\nDirection B -- billing services no active row claims (orphans): {len(b)}")
    for d in b:
        print(f"  {d['service']}")
    print(
        "\nREPORT ONLY -- nothing deleted. Reclaim is founder-gated (PERSONAL_AGENT_FLEET_RECLAIM_ENABLED)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
