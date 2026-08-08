"""Inspect the per-user Agent One pod fleet in a GCP project.

Read-only. Lists every Cloud Run service labelled ``app=hussh-one-pod`` with the
signals you actually need to manage a fleet: whether it is genuinely serving, which
opaque space it belongs to, what identity it runs as, and how it is reachable.

Usage::

    python scripts/ops/pod_fleet.py [--project hushh-pda-dev] [--region us-central1]

Credentials come from ``GCP_DEPLOY_SA_KEY_B64``, the same operator key
``GcpRunClient`` uses -- this reuses that loader rather than reimplementing it.

On "serving" vs "Ready": Cloud Run's default startup probe is a TCP connect, and
gunicorn binds its port before its workers boot. A pod whose workers crash on import
therefore reports Ready=True and ContainerHealthy=True while returning 503 to every
request (observed in hushh-pda-dev, 2026-08-04). ``GcpBackend.render_deploy_config``
now sets an explicit HTTP startup probe on /health so the condition means what it
says, but a pod created before that change -- or by anything else -- can still be
Ready-but-dead. So this tool reports whether an HTTP startup probe is configured, and
never presents Ready alone as proof that a pod works.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Optional

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))

from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: E402

POD_LABEL = "app=hussh-one-pod"


def _session(credentials: Any) -> requests.Session:
    from google.auth.transport.requests import AuthorizedSession

    return AuthorizedSession(credentials)


def _condition(obj: dict[str, Any], name: str) -> Optional[str]:
    for c in (obj.get("status") or {}).get("conditions") or []:
        if c.get("type") == name:
            return c.get("status")
    return None


def _probe_kind(svc: dict[str, Any]) -> str:
    """What the startup probe actually checks -- 'http', 'tcp (default)', or 'none'."""
    containers = (((svc.get("spec") or {}).get("template") or {}).get("spec") or {}).get(
        "containers"
    ) or []
    if not containers:
        return "none"
    probe = containers[0].get("startupProbe") or {}
    if probe.get("httpGet"):
        return f"http {probe['httpGet'].get('path', '/')}"
    if probe.get("tcpSocket"):
        return "tcp (explicit)"
    return "tcp (default)"


def main() -> int:
    ap = argparse.ArgumentParser(description="List the Agent One pod fleet.")
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = ap.parse_args()

    creds = load_operator_credentials()
    s = _session(creds)
    base = (
        f"https://{args.region}-run.googleapis.com/apis/serving.knative.dev/v1"
        f"/namespaces/{args.project}"
    )
    r = s.get(f"{base}/services", params={"labelSelector": POD_LABEL}, timeout=120)
    if not r.ok:
        print(f"FAILED to list services: http {r.status_code}: {r.text[:400]}")
        return 1

    rows = []
    for svc in r.json().get("items") or []:
        md = svc.get("metadata") or {}
        labels = md.get("labels") or {}
        annotations = md.get("annotations") or {}
        tmpl = ((svc.get("spec") or {}).get("template") or {}) or {}
        tspec = tmpl.get("spec") or {}
        containers = tspec.get("containers") or [{}]
        rows.append(
            {
                "service": md.get("name"),
                "ready": _condition(svc, "Ready"),
                "probe": _probe_kind(svc),
                "spaceId": labels.get("hussh-space-id"),
                "tier": labels.get("hussh-tier"),
                "env": labels.get("hussh-env"),
                "purpose": labels.get("hussh-purpose"),
                "ingress": annotations.get("run.googleapis.com/ingress"),
                "serviceAccount": tspec.get("serviceAccountName"),
                "image": (containers[0].get("image") or "").split("/")[-1],
                "url": ((svc.get("status") or {}).get("url")),
            }
        )

    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    if not rows:
        print(f"no pods labelled {POD_LABEL} in {args.project}/{args.region}")
        return 0

    print(f"{len(rows)} pod(s) in {args.project}/{args.region}\n")
    for row in rows:
        print(f"  {row['service']}")
        print(f"      ready={row['ready']}  probe={row['probe']}  ingress={row['ingress']}")
        print(
            f"      space={row['spaceId']}  tier={row['tier']}  "
            f"env={row['env']}  purpose={row['purpose']}"
        )
        print(f"      identity={row['serviceAccount']}")
        print(f"      image={row['image']}")
        print(f"      url={row['url']}")
    print(
        "\nReady=True proves the startup probe passed, not that the pod serves --"
        "\ncheck probe=http above; a tcp probe can pass on a pod whose workers are dead."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
