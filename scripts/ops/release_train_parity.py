#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Compute the 4-dimension Release Train & Environment Parity Matrix.

Enforces the bidirectional release-train discipline across Dev, UAT, and Main:
1. Code Parity: exact ahead/behind counts across dev, uat, and main, failing
   closed before upward promotion whenever upstream (uat or main) has commits
   not yet back-synced into dev.
2. Schema Parity: database migration watermarks per lane plus fail-closed
   detection of duplicate migration sequence numbers across lanes.
3. Calendar Release Trains: tracks YYYY.MM.N train tags, deployed lane tags,
   and pod release versions to recommend the next sequential train cut.
4. Runtime Capability Flags & Live Provenance (optional --live-cloud): reads
   Cloud Run service metadata (never printing secret payloads) across Dev, UAT,
   and Production to expose dark-code drift or unsafe Dev-simulation leakage.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

MIGRATIONS_PREFIX = "consent-protocol/db/migrations/"
MIGRATION_RE = re.compile(r"^(\d+)_(.+)\.sql$")
TRAIN_TAG_RE = re.compile(r"^train/(\d{4}\.\d{2})\.(\d+)$")

TRACKED_CAPABILITY_KEYS: tuple[str, ...] = (
    "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED",
    "HUSSH_SANDBOX_EDGE_PUBLIC_URL",
    "HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET",
    "HUSSH_HOSTED_POD_TIER_ENABLED",
    "HUSSH_USER_GCP_LIVE",
    "HUSSH_USER_GCP_SUBSTRATE_APPLY",
    "HUSSH_POD_FILES_ENABLED",
    "HUSSH_TRUSTED_DEVICE_ENABLED",
    "PERSONAL_AGENT_ENABLED",
    "HUSHH_DEV_SIMULATION_ENABLED",
)

DEFAULT_CLOUD_LANES: dict[str, dict[str, str]] = {
    "dev": {"project": "hushh-pda-dev", "region": "us-central1"},
    "uat": {"project": "hushh-pda-uat", "region": "us-central1"},
    "production": {"project": "hushh-pda", "region": "us-central1"},
}


def _git(repo_root: Path, args: list[str], *, check: bool = True) -> str:
    proc = subprocess.run(  # noqa: S603 - repository-controlled git inspection
        ["git", "-C", str(repo_root), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def _rev_exists(repo_root: Path, ref: str) -> bool:
    proc = subprocess.run(  # noqa: S603 - repository-controlled git inspection
        ["git", "-C", str(repo_root), "rev-parse", "--verify", "--quiet", ref],
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode == 0


def _commits_between(
    repo_root: Path, base_ref: str, head_ref: str, *, limit: int = 10
) -> dict[str, Any]:
    raw_count = _git(
        repo_root,
        ["rev-list", "--no-merges", "--count", f"{base_ref}..{head_ref}"],
    ).strip()
    count = int(raw_count or "0")
    sample_raw = _git(
        repo_root,
        [
            "log",
            "--no-merges",
            f"-n{limit}",
            "--date=short",
            "--pretty=format:%ad %h %s",
            f"{base_ref}..{head_ref}",
        ],
    ).strip()
    samples = (
        [line for line in sample_raw.splitlines() if line.strip()] if sample_raw else []
    )
    return {"count": count, "samples": samples}


def _list_migrations(repo_root: Path, ref: str) -> dict[str, dict[str, Any]]:
    raw = _git(
        repo_root,
        ["ls-tree", "-r", ref, MIGRATIONS_PREFIX],
        check=False,
    )
    entries: dict[str, dict[str, Any]] = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        meta, rel_path = line.split("\t", 1)
        parts = meta.split()
        blob_sha = parts[2] if len(parts) >= 3 else ""
        if not rel_path.startswith(MIGRATIONS_PREFIX):
            continue
        name = rel_path[len(MIGRATIONS_PREFIX) :]
        if "/" in name:
            # Skip parked/rollback subtrees; only canonical root migrations count.
            continue
        match = MIGRATION_RE.match(name)
        if not match:
            continue
        seq = int(match.group(1))
        entries[name] = {"seq": seq, "name": name, "blob": blob_sha}
    return entries


def compute_schema_parity(
    repo_root: Path,
    *,
    dev_ref: str,
    uat_ref: str,
    main_ref: str,
) -> dict[str, Any]:
    lane_migrations = {
        "dev": _list_migrations(repo_root, dev_ref),
        "uat": _list_migrations(repo_root, uat_ref),
        "main": _list_migrations(repo_root, main_ref),
    }

    watermarks: dict[str, int] = {}
    by_seq: dict[int, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for lane, items in lane_migrations.items():
        watermarks[lane] = max((item["seq"] for item in items.values()), default=0)
        for item in items.values():
            by_seq[item["seq"]][lane].append(item)

    collisions: list[dict[str, Any]] = []
    for seq in sorted(by_seq):
        lane_map = by_seq[seq]
        unique_names = {item["name"] for items in lane_map.values() for item in items}
        unique_blobs = {item["blob"] for items in lane_map.values() for item in items}
        if len(unique_names) > 1 or len(unique_blobs) > 1:
            collisions.append(
                {
                    "seq": seq,
                    "kind": "duplicate_sequence_number"
                    if len(unique_names) > 1
                    else "divergent_sql_body",
                    "lanes": {
                        lane: [item["name"] for item in items]
                        for lane, items in sorted(lane_map.items())
                    },
                }
            )

    dev_names = set(lane_migrations["dev"])
    uat_names = set(lane_migrations["uat"])
    main_names = set(lane_migrations["main"])

    return {
        "watermarks": watermarks,
        "dev_only": sorted(dev_names - uat_names),
        "uat_only_not_in_dev": sorted(uat_names - dev_names),
        "main_only_not_in_dev": sorted(main_names - dev_names),
        "collisions": collisions,
        "collision_count": len(collisions),
    }


def _read_pod_release_version(repo_root: Path, ref: str) -> str:
    raw = _git(repo_root, ["show", f"{ref}:deploy/pod-release.json"], check=False)
    if not raw.strip():
        return ""
    try:
        payload = json.loads(raw)
        return str(payload.get("version") or "")
    except json.JSONDecodeError:
        return ""


def compute_calendar_trains(
    repo_root: Path,
    *,
    dev_ref: str,
    uat_ref: str,
    main_ref: str,
    now_utc: dt.datetime | None = None,
) -> dict[str, Any]:
    tags_raw = _git(repo_root, ["tag", "--sort=-creatordate"], check=False)
    tags = [line.strip() for line in tags_raw.splitlines() if line.strip()]

    latest_deployed: dict[str, str] = {}
    for lane, prefix in (
        ("dev", "deployed/dev/"),
        ("uat", "deployed/uat/"),
        ("production", "deployed/production"),
    ):
        for tag in tags:
            if tag.startswith(prefix):
                latest_deployed[lane] = tag
                break
        else:
            latest_deployed[lane] = ""

    now = now_utc or dt.datetime.now(dt.timezone.utc)
    month_prefix = now.strftime("%Y.%m")
    train_numbers_this_month: list[int] = []
    latest_train_tag = ""
    for tag in tags:
        match = TRAIN_TAG_RE.match(tag)
        if not match:
            continue
        if not latest_train_tag:
            latest_train_tag = tag
        if match.group(1) == month_prefix:
            train_numbers_this_month.append(int(match.group(2)))

    pod_versions = {
        "dev": _read_pod_release_version(repo_root, dev_ref),
        "uat": _read_pod_release_version(repo_root, uat_ref),
        "main": _read_pod_release_version(repo_root, main_ref),
    }
    pod_seq_floor = 0
    pod_re = re.compile(rf"^{re.escape(month_prefix)}-[a-z]+\.(\d+)$")
    for version in pod_versions.values():
        m = pod_re.match(version)
        if m:
            pod_seq_floor = max(pod_seq_floor, int(m.group(1)))

    highest_seq = max(train_numbers_this_month + [pod_seq_floor], default=0)
    next_train = f"{month_prefix}.{highest_seq + 1}"

    return {
        "latest_train_tag": latest_train_tag,
        "recommended_next_train": next_train,
        "recommended_tag": f"train/{next_train}",
        "latest_deployed_tags": latest_deployed,
        "pod_release_versions": pod_versions,
    }


def _describe_cloud_run_service(
    *,
    project: str,
    region: str,
    service: str,
    env: dict[str, str],
) -> dict[str, Any] | None:
    proc = subprocess.run(  # noqa: S603 - read-only gcloud describe
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            f"--project={project}",
            f"--region={region}",
            "--format=json",
        ],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def parse_cloud_run_capabilities(service_doc: dict[str, Any] | None) -> dict[str, Any]:
    if not service_doc:
        return {
            "present": False,
            "revision": "",
            "commit_sha": "",
            "flags": {key: "absent" for key in TRACKED_CAPABILITY_KEYS},
        }
    status = service_doc.get("status") or {}
    spec = ((service_doc.get("spec") or {}).get("template") or {}).get("spec") or {}
    labels = (
        ((service_doc.get("spec") or {}).get("template") or {}).get("metadata") or {}
    ).get("labels") or {}
    containers = spec.get("containers") or [{}]
    env_list = containers[0].get("env") or []
    env_map: dict[str, str] = {}
    for entry in env_list:
        name = str(entry.get("name") or "")
        if not name:
            continue
        if "value" in entry:
            env_map[name] = str(entry["value"])
        else:
            env_map[name] = "<secret>"
    flags = {key: env_map.get(key, "absent") for key in TRACKED_CAPABILITY_KEYS}
    return {
        "present": True,
        "revision": str(status.get("latestReadyRevisionName") or ""),
        "commit_sha": str(labels.get("deploy-sha") or labels.get("commit-sha") or ""),
        "flags": flags,
    }


def collect_live_cloud_parity(
    *,
    lanes: dict[str, dict[str, str]] | None = None,
    fetcher: Any = None,
) -> dict[str, Any]:
    lane_cfg = lanes or DEFAULT_CLOUD_LANES
    env = dict(os.environ)
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"
    if not env.get("CLOUDSDK_AUTH_ACCESS_TOKEN") and fetcher is None:
        tok_proc = subprocess.run(  # noqa: S603 - read-only ADC token fetch
            ["gcloud", "auth", "application-default", "print-access-token"],
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )
        if tok_proc.returncode == 0 and tok_proc.stdout.strip():
            env["CLOUDSDK_AUTH_ACCESS_TOKEN"] = tok_proc.stdout.strip()

    describe = fetcher or (
        lambda project, region, service: _describe_cloud_run_service(
            project=project, region=region, service=service, env=env
        )
    )

    result: dict[str, Any] = {"lanes": {}, "safety_violations": []}
    for lane_name, cfg in lane_cfg.items():
        project = cfg["project"]
        region = cfg["region"]
        backend_doc = describe(project, region, "consent-protocol")
        webapp_doc = describe(project, region, "hushh-webapp")
        edge_doc = describe(project, region, "sandbox-edge-gateway")
        backend_caps = parse_cloud_run_capabilities(backend_doc)
        webapp_caps = parse_cloud_run_capabilities(webapp_doc)
        edge_present = bool(edge_doc)
        lane_summary = {
            "project": project,
            "backend_revision": backend_caps["revision"],
            "webapp_revision": webapp_caps["revision"],
            "sandbox_edge_gateway_present": edge_present,
            "flags": backend_caps["flags"],
        }
        result["lanes"][lane_name] = lane_summary
        if lane_name in ("uat", "production"):
            sim_val = str(
                backend_caps["flags"].get("HUSHH_DEV_SIMULATION_ENABLED", "absent")
            ).lower()
            if sim_val not in ("absent", "", "false", "0"):
                result["safety_violations"].append(
                    f"HUSHH_DEV_SIMULATION_ENABLED must never be active on {lane_name} (found {sim_val})"
                )
    return result


def build_parity_report(
    repo_root: Path,
    *,
    dev_ref: str = "origin/dev",
    uat_ref: str = "origin/uat",
    main_ref: str = "origin/main",
    include_live_cloud: bool = False,
    require_clean_upstream: bool = False,
    live_cloud_fetcher: Any = None,
    now_utc: dt.datetime | None = None,
) -> dict[str, Any]:
    for label, ref in (("dev", dev_ref), ("uat", uat_ref), ("main", main_ref)):
        if not _rev_exists(repo_root, ref):
            raise RuntimeError(f"Required git ref for {label} not found: {ref}")

    code_parity = {
        "refs": {
            "dev": _git(repo_root, ["rev-parse", "--short=10", dev_ref]).strip(),
            "uat": _git(repo_root, ["rev-parse", "--short=10", uat_ref]).strip(),
            "main": _git(repo_root, ["rev-parse", "--short=10", main_ref]).strip(),
        },
        "uat_ahead_of_dev": _commits_between(repo_root, dev_ref, uat_ref),
        "main_ahead_of_dev": _commits_between(repo_root, dev_ref, main_ref),
        "main_ahead_of_uat": _commits_between(repo_root, uat_ref, main_ref),
        "dev_ahead_of_uat": _commits_between(repo_root, uat_ref, dev_ref),
    }
    schema_parity = compute_schema_parity(
        repo_root, dev_ref=dev_ref, uat_ref=uat_ref, main_ref=main_ref
    )
    trains = compute_calendar_trains(
        repo_root, dev_ref=dev_ref, uat_ref=uat_ref, main_ref=main_ref, now_utc=now_utc
    )

    blockers: list[str] = []
    if schema_parity["collision_count"] > 0:
        for col in schema_parity["collisions"]:
            blockers.append(
                f"Migration sequence collision at {col['seq']} ({col['kind']}): {col['lanes']}"
            )
    if require_clean_upstream:
        if code_parity["uat_ahead_of_dev"]["count"] > 0:
            blockers.append(
                f"Upstream UAT has {code_parity['uat_ahead_of_dev']['count']} commit(s) not yet back-synced into Dev. Back-sync UAT -> Dev first."
            )
        if code_parity["main_ahead_of_dev"]["count"] > 0:
            blockers.append(
                f"Upstream Main has {code_parity['main_ahead_of_dev']['count']} commit(s) not yet back-synced into Dev. Back-sync Main -> Dev first."
            )

    live_cloud = None
    if include_live_cloud:
        live_cloud = collect_live_cloud_parity(fetcher=live_cloud_fetcher)
        blockers.extend(live_cloud["safety_violations"])

    return {
        "status": "blocked" if blockers else "ready",
        "blockers": blockers,
        "code_parity": code_parity,
        "schema_parity": schema_parity,
        "calendar_trains": trains,
        "live_cloud": live_cloud,
    }


def format_text_report(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"Release Train Parity Status: {report['status'].upper()}")
    code = report["code_parity"]
    refs = code["refs"]
    lines.append("")
    lines.append("1. Code Parity (Merge-Only Ancestry)")
    lines.append(f"   Refs: dev={refs['dev']}  uat={refs['uat']}  main={refs['main']}")
    lines.append(
        f"   UAT ahead of Dev (must back-sync first): {code['uat_ahead_of_dev']['count']}"
    )
    lines.append(
        f"   Main ahead of Dev (must back-sync first): {code['main_ahead_of_dev']['count']}"
    )
    lines.append(f"   Main ahead of UAT: {code['main_ahead_of_uat']['count']}")
    lines.append(
        f"   Dev ahead of UAT (pending promotion): {code['dev_ahead_of_uat']['count']}"
    )

    schema = report["schema_parity"]
    lines.append("")
    lines.append("2. Schema Parity (Database Migrations)")
    lines.append(
        f"   Watermarks: dev={schema['watermarks']['dev']}  uat={schema['watermarks']['uat']}  main={schema['watermarks']['main']}"
    )
    lines.append(
        f"   UAT-only migrations not in Dev: {len(schema['uat_only_not_in_dev'])}"
    )
    lines.append(f"   Dev-only migrations not in UAT: {len(schema['dev_only'])}")
    lines.append(f"   Sequence collisions: {schema['collision_count']}")
    for col in schema["collisions"]:
        lines.append(f"     COLLISION {col['seq']} ({col['kind']}): {col['lanes']}")

    trains = report["calendar_trains"]
    lines.append("")
    lines.append("3. Calendar Release Trains")
    lines.append(f"   Latest train tag: {trains['latest_train_tag'] or '(none yet)'}")
    lines.append(
        f"   Recommended next train: {trains['recommended_next_train']} ({trains['recommended_tag']})"
    )
    lines.append(
        "   Deployed tags: "
        + ", ".join(
            f"{k}={v or 'none'}" for k, v in trains["latest_deployed_tags"].items()
        )
    )

    if report.get("live_cloud"):
        lines.append("")
        lines.append("4. Runtime Capability Flags & Live Cloud Provenance")
        for lane_name, info in report["live_cloud"]["lanes"].items():
            flags = info["flags"]
            lines.append(
                f"   [{lane_name}] backend={info['backend_revision'] or 'none'} "
                f"webapp={info['webapp_revision'] or 'none'} "
                f"edge_gateway={'present' if info['sandbox_edge_gateway_present'] else 'absent'} "
                f"sandbox_cutover={flags['HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED']} "
                f"byoc_live={flags['HUSSH_USER_GCP_LIVE']} "
                f"dev_sim={flags['HUSHH_DEV_SIMULATION_ENABLED']}"
            )

    if report["blockers"]:
        lines.append("")
        lines.append("Blockers:")
        for blocker in report["blockers"]:
            lines.append(f"   - {blocker}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compute the 4-dimension Release Train & Environment Parity Matrix."
    )
    parser.add_argument("--repo-root", default=None, help="Git repository root.")
    parser.add_argument("--dev-ref", default="origin/dev", help="Dev git ref.")
    parser.add_argument("--uat-ref", default="origin/uat", help="UAT git ref.")
    parser.add_argument("--main-ref", default="origin/main", help="Main git ref.")
    parser.add_argument(
        "--live-cloud",
        action="store_true",
        help="Also query Cloud Run service posture across Dev, UAT, and Production.",
    )
    parser.add_argument(
        "--require-clean-upstream",
        action="store_true",
        help="Exit non-zero if UAT or Main has commits not yet back-synced into Dev, or on any migration collision.",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--json", action="store_true", dest="as_json", help="Emit JSON output."
    )
    group.add_argument(
        "--text", action="store_true", dest="as_text", help="Emit human text output."
    )
    args = parser.parse_args(argv)

    repo_root = (
        Path(args.repo_root).resolve()
        if args.repo_root
        else Path(__file__).resolve().parents[2]
    )
    report = build_parity_report(
        repo_root,
        dev_ref=args.dev_ref,
        uat_ref=args.uat_ref,
        main_ref=args.main_ref,
        include_live_cloud=args.live_cloud,
        require_clean_upstream=args.require_clean_upstream,
    )
    if args.as_json:
        sys.stdout.write(json.dumps(report, indent=2) + "\n")
    else:
        sys.stdout.write(format_text_report(report))
    return 1 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
