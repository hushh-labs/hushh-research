#!/usr/bin/env python3
"""Create the bounded aggregate metric descriptors for the owned setup script."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def ensure_descriptors(project: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("invalid_project")
    # The runtime owns this allowlist. Provisioning is its projection, not a
    # competing metric registry or a second source of financial information.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "consent-protocol"))
    import google.auth
    import requests
    from google.auth.transport.requests import Request

    from hushh_mcp.services.scope_commerce.monitoring_publisher import METRICS

    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/monitoring"])
    with requests.Session() as session:
        request = Request(session=session)
        credentials.refresh(lambda **kwargs: request(**{**kwargs, "timeout": 5}))
        headers = {"Authorization": "Bearer " + credentials.token}
        base = f"https://monitoring.googleapis.com/v3/projects/{project}/metricDescriptors"
        for name in sorted(METRICS):
            metric_type = "custom.googleapis.com/hussh/scope_commerce/" + name
            response = session.get(base + "/" + metric_type, headers=headers, timeout=5)
            if response.status_code == 200:
                value = response.json()
                if (value.get("metricKind") != "GAUGE" or value.get("valueType") != "INT64"
                        or {label["key"] for label in value.get("labels", [])} != {"service_name"}):
                    raise ValueError("existing_metric_contract_mismatch")
                continue
            if response.status_code != 404:
                raise RuntimeError("metric_descriptor_read_failed")
            response = session.post(base, headers=headers, timeout=5, json={
                "type": metric_type, "metricKind": "GAUGE", "valueType": "INT64", "unit": "1",
                "displayName": "Scope commerce " + name.replace("_", " "),
                "description": "Aggregate financial observation; amounts in micro USD and timestamps in Unix seconds.",
                "labels": [{"key": "service_name", "valueType": "STRING",
                            "description": "Owning backend service; no consumer identifiers."}],
            })
            if response.status_code not in {200, 201, 409}:
                raise RuntimeError("metric_descriptor_create_failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    args = parser.parse_args()
    try:
        ensure_descriptors(args.project)
    except Exception as error:
        print("Scope commerce metric setup failed: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1) from None
