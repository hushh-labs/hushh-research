"""Call a per-user pod as an authorized invoker.

A pod has **no** ``allUsers`` binding, so opening its URL in a browser returns
403 — that is the containment property working, not a fault. Reaching one
requires a Google **ID token whose audience is the pod's own URL**, minted from
the operator service account (``GCP_DEPLOY_SA_KEY_B64``). This is the same
mechanism the hub uses when it proxies to a pod, so what this tool proves is
what the hub can do.

Usage::

    python scripts/ops/pod_curl.py <pod-url> [path]            # default /pod/info
    python scripts/ops/pod_curl.py <pod-url> /health
    python scripts/ops/pod_curl.py --name one-pod-devsim01     # resolve via the fleet

The token is minted, used, and discarded — it is never printed and never
written to disk.

Note on the first call: a pod rendered before ``minScale=1`` can cold-start for
tens of seconds. A timeout on the first request is usually a cold start, not a
dead pod — retry before concluding anything (a pod reported as dead here was
healthy in 0.7 s on the second attempt).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from typing import Any, Optional

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))

_SA_KEY_ENV = "GCP_DEPLOY_SA_KEY_B64"


def _id_token(audience: str) -> str:
    """An ID token bound to THIS pod's URL. Audience-bound, so it cannot be
    replayed against another service."""
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    raw = os.getenv(_SA_KEY_ENV, "")
    if not raw:
        raise SystemExit(f"{_SA_KEY_ENV} is not set; see CLAUDE.md - it is present in-session")
    info = json.loads(base64.b64decode(raw))
    creds = service_account.IDTokenCredentials.from_service_account_info(
        info, target_audience=audience
    )
    creds.refresh(Request())
    return str(creds.token)


def _resolve(name: str, project: str, region: str) -> Optional[str]:
    """Look the pod's URL up in the fleet rather than having it typed in."""
    from google.auth.transport.requests import AuthorizedSession

    from hushh_mcp.services.gcp_run_client import load_operator_credentials

    session: Any = AuthorizedSession(load_operator_credentials())
    base = f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project}"
    response = session.get(f"{base}/services", timeout=30)
    response.raise_for_status()
    for service in response.json().get("items", []):
        if (service.get("metadata") or {}).get("name") == name:
            return ((service.get("status") or {}).get("url")) or None
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Call a pod as an authorized invoker")
    parser.add_argument("url", nargs="?", default="", help="pod URL (or use --name)")
    parser.add_argument("path", nargs="?", default="/pod/info")
    parser.add_argument("--name", default="", help="Cloud Run service name to resolve")
    parser.add_argument("--project", default="hushh-pda-dev")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()

    url = args.url.rstrip("/")
    path = args.path
    # With --name the URL positional is absent, so a lone "/health" lands in `url`.
    # Treat any positional that is path-shaped as the path it obviously is.
    if url.startswith("/"):
        path = args.url
        url = ""
    if not url and args.name:
        url = (_resolve(args.name, args.project, args.region) or "").rstrip("/")
        if not url:
            raise SystemExit(f"no service named {args.name} in {args.project}/{args.region}")
    if not url:
        raise SystemExit("give a pod URL or --name")

    response = requests.get(
        f"{url}{path}",
        headers={"Authorization": f"Bearer {_id_token(url)}"},
        timeout=args.timeout,
    )
    print(f"{response.status_code}  {url}{path}")
    try:
        print(json.dumps(response.json(), indent=2))
    except Exception:  # noqa: BLE001 - a non-JSON body is still worth seeing
        print(response.text[:2000])
    return 0 if response.status_code < 400 else 1


if __name__ == "__main__":
    raise SystemExit(main())
