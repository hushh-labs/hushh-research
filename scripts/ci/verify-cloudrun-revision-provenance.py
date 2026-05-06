#!/usr/bin/env python3
"""Verify that live Cloud Run traffic is served by governed deploy revisions."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

EXPECTED_ENV_VARS = {
    "env": "HUSHH_DEPLOY_ENV",
    "source": "HUSHH_DEPLOY_SOURCE",
    "sha": "HUSHH_DEPLOY_SHA",
    "run_id": "HUSHH_DEPLOY_RUN_ID",
}


def _load_json_file(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _run_gcloud_json(args: list[str]) -> dict[str, Any]:
    result = subprocess.run(  # noqa: S603 - fixed gcloud executable with structured args.
        ["gcloud", *args, "--format=json"],
        check=True,
        text=True,
        capture_output=True,
    )
    parsed = json.loads(result.stdout)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"gcloud returned non-object JSON for {' '.join(args)}")
    return parsed


def _load_revision_fixtures(paths: list[str]) -> dict[str, dict[str, Any]]:
    revisions: dict[str, dict[str, Any]] = {}
    for path in paths:
        payload = _load_json_file(path)
        if not payload:
            continue
        name = str((payload.get("metadata") or {}).get("name") or "").strip()
        if not name:
            raise ValueError(f"{path} does not include metadata.name")
        revisions[name] = payload
    return revisions


def _service_traffic_revisions(service_payload: dict[str, Any]) -> list[dict[str, Any]]:
    status = service_payload.get("status") or {}
    latest_ready = str(status.get("latestReadyRevisionName") or "").strip()
    traffic = status.get("traffic") or []
    revisions: list[dict[str, Any]] = []
    for entry in traffic:
        if not isinstance(entry, dict):
            continue
        percent = int(entry.get("percent") or 0)
        if percent <= 0:
            continue
        revision_name = str(entry.get("revisionName") or "").strip()
        if not revision_name and entry.get("latestRevision"):
            revision_name = latest_ready
        revisions.append(
            {
                "revision": revision_name,
                "percent": percent,
                "latestRevision": bool(entry.get("latestRevision")),
            }
        )
    if not revisions and latest_ready:
        revisions.append({"revision": latest_ready, "percent": 100, "latestRevision": True})
    return revisions


def _revision_env(revision_payload: dict[str, Any]) -> dict[str, str]:
    containers = (revision_payload.get("spec") or {}).get("containers") or []
    env: dict[str, str] = {}
    for container in containers:
        if not isinstance(container, dict):
            continue
        for item in container.get("env") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            if "value" in item:
                env[name] = str(item.get("value") or "")
            elif "valueFrom" in item:
                env[name] = "<secret-or-reference>"
    return env


def _expected_pairs(args: argparse.Namespace) -> dict[str, str]:
    expected = {
        EXPECTED_ENV_VARS["env"]: args.expected_env,
        EXPECTED_ENV_VARS["source"]: args.expected_source,
        EXPECTED_ENV_VARS["sha"]: args.expected_sha,
    }
    if args.expected_run_id:
        expected[EXPECTED_ENV_VARS["run_id"]] = args.expected_run_id
    return expected


def _revision_payload(
    *,
    revision_name: str,
    args: argparse.Namespace,
    fixtures: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if revision_name in fixtures:
        return fixtures[revision_name]
    return _run_gcloud_json(
        [
            "run",
            "revisions",
            "describe",
            revision_name,
            f"--project={args.project}",
            f"--region={args.region}",
        ]
    )


def verify(args: argparse.Namespace) -> dict[str, Any]:
    service_payload = _load_json_file(args.service_json) or _run_gcloud_json(
        [
            "run",
            "services",
            "describe",
            args.service,
            f"--project={args.project}",
            f"--region={args.region}",
        ]
    )
    revision_fixtures = _load_revision_fixtures(args.revision_json)
    expected = _expected_pairs(args)
    traffic_revisions = _service_traffic_revisions(service_payload)

    failures: list[dict[str, Any]] = []
    checked: list[dict[str, Any]] = []

    if not traffic_revisions:
        failures.append({"reason": "no_live_traffic", "service": args.service})

    for traffic in traffic_revisions:
        revision_name = str(traffic.get("revision") or "").strip()
        if not revision_name:
            failures.append({"reason": "traffic_without_revision", "traffic": traffic})
            continue

        revision_payload = _revision_payload(
            revision_name=revision_name,
            args=args,
            fixtures=revision_fixtures,
        )
        env = _revision_env(revision_payload)
        labels = (revision_payload.get("metadata") or {}).get("labels") or {}
        mismatches = []
        for key, expected_value in expected.items():
            actual_value = env.get(key)
            if actual_value != expected_value:
                mismatches.append(
                    {
                        "key": key,
                        "expected": expected_value,
                        "actual": actual_value,
                    }
                )
        checked.append(
            {
                "revision": revision_name,
                "traffic_percent": traffic.get("percent"),
                "env": {key: env.get(key) for key in expected},
                "labels": {
                    key: labels.get(key)
                    for key in (
                        "managed-by",
                        "deploy-env",
                        "deploy-source",
                        "deploy-sha",
                        "github-run-id",
                    )
                },
                "ok": not mismatches,
                "mismatches": mismatches,
            }
        )
        if mismatches:
            failures.append(
                {
                    "reason": "revision_provenance_mismatch",
                    "revision": revision_name,
                    "mismatches": mismatches,
                }
            )

    return {
        "service": args.service,
        "project": args.project,
        "region": args.region,
        "status": "healthy" if not failures else "blocked",
        "ok": not failures,
        "classifications": [] if not failures else ["deploy_authority_drift"],
        "expected": expected,
        "checked_revisions": checked,
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--expected-env", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--expected-run-id", default="")
    parser.add_argument("--report-path", required=True)
    parser.add_argument("--service-json", default="")
    parser.add_argument("--revision-json", action="append", default=[])
    args = parser.parse_args(argv)

    report = verify(args)
    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
