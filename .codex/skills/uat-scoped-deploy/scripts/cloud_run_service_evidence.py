#!/usr/bin/env python3
"""Discover Cloud Run service regions before collecting deploy evidence."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any


SAFE_ENV_KEYS = {
    "APP_ENV",
    "HUSHH_ENV",
    "NODE_ENV",
    "NEXT_PUBLIC_APP_ENV",
    "RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS",
    "RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS",
    "RIA_ONBOARDING_PROXY_TIMEOUT_MS",
}


def _gcloud() -> str:
    return os.environ.get("GCLOUD_BIN") or shutil.which("gcloud") or "/Users/ankitkumarsingh/google-cloud-sdk/bin/gcloud"


def _run(args: list[str]) -> Any:
    result = subprocess.run(args, check=False, text=True, capture_output=True)
    if result.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(args)}\n{result.stderr.strip()}")
    return json.loads(result.stdout or "null")


def _list_services(project: str) -> list[dict[str, Any]]:
    return _run([_gcloud(), "run", "services", "list", "--project", project, "--platform", "managed", "--format", "json"])


def _service_location(service: dict[str, Any]) -> str | None:
    return service.get("location") or service.get("metadata", {}).get("labels", {}).get("cloud.googleapis.com/location")


def _describe(project: str, service: str, region: str) -> dict[str, Any]:
    return _run(
        [
            _gcloud(),
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--platform",
            "managed",
            "--format",
            "json",
        ]
    )


def _env_map(service: dict[str, Any]) -> dict[str, str]:
    containers = service.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    env: dict[str, str] = {}
    for container in containers:
        for item in container.get("env", []) or []:
            name = item.get("name", "")
            if name in SAFE_ENV_KEYS and "value" in item:
                env[item.get("name", "")] = item["value"]
    return env


def _summarize(project: str, service_name: str, region_hint: str | None, services: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = [item for item in services if item.get("metadata", {}).get("name") == service_name or item.get("name") == service_name]
    if region_hint:
        candidates = [item for item in candidates if _service_location(item) == region_hint]
    if not candidates:
        available = sorted(
            f"{item.get('metadata', {}).get('name') or item.get('name')}:{_service_location(item) or 'unknown'}"
            for item in services
        )
        raise SystemExit(f"service not found for {project}/{service_name}. available={available}")
    if len(candidates) > 1 and not region_hint:
        regions = [_service_location(item) for item in candidates]
        raise SystemExit(f"multiple regions found for {service_name}; rerun with --region. regions={regions}")

    region = _service_location(candidates[0])
    if not region:
        raise SystemExit(f"could not determine region for {service_name}")
    described = _describe(project, service_name, region)
    metadata = described.get("metadata", {})
    spec = described.get("spec", {})
    status = described.get("status", {})
    labels = metadata.get("labels", {})
    annotations = metadata.get("annotations", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    traffic = status.get("traffic") or spec.get("traffic") or []
    env = _env_map(described)
    return {
        "project": project,
        "service": service_name,
        "region": region,
        "latest_ready_revision": status.get("latestReadyRevisionName"),
        "traffic": traffic,
        "image": containers[0].get("image") if containers else None,
        "timeout": spec.get("template", {}).get("spec", {}).get("timeoutSeconds"),
        "deploy_sha": labels.get("deploy-sha") or labels.get("commit-sha"),
        "github_run_id": labels.get("github-run-id"),
        "client_name": annotations.get("run.googleapis.com/client-name"),
        "env": env,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--service", action="append", required=True)
    parser.add_argument("--region")
    parser.add_argument("--format", choices=["json", "text"], default="json")
    args = parser.parse_args()

    services = _list_services(args.project)
    summaries = [_summarize(args.project, service, args.region, services) for service in args.service]
    if args.format == "json":
        print(json.dumps(summaries, indent=2, sort_keys=True))
        return 0
    for item in summaries:
        print(
            f"{item['project']} {item['service']} {item['region']} "
            f"revision={item['latest_ready_revision']} image={item['image']} "
            f"timeout={item['timeout']} deploy_sha={item['deploy_sha']} run={item['github_run_id']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
