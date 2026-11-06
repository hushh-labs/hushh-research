#!/usr/bin/env python3
"""Prune historical Secret Manager versions across a project to keep only the latest version(s).
Enforces GCP's 600 write requests per minute quota limit by throttling to ~8 writes/sec.

Usage:
  python3 scripts/ops/prune_gcp_secret_versions.py --project hushh-pda-uat [--keep 1] [--rate 8]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

home = os.path.expanduser("~")
os.environ["PATH"] = f"{home}/google-cloud-sdk/bin:/opt/homebrew/bin:{os.environ.get('PATH', '')}"


class RateLimiter:
    """Thread-safe rate limiter to respect GCP WriteRequestsPerMinute quota (600/min)."""

    def __init__(self, max_per_second: float = 8.0):
        self.interval = 1.0 / max_per_second
        self.lock = threading.Lock()
        self.last_time = time.monotonic()

    def acquire(self) -> None:
        with self.lock:
            now = time.monotonic()
            elapsed = now - self.last_time
            if elapsed < self.interval:
                time.sleep(self.interval - elapsed)
            self.last_time = time.monotonic()


def _get_access_token() -> str:
    res = subprocess.run(
        ["gcloud", "auth", "application-default", "print-access-token"],
        capture_output=True,
        text=True,
        check=True,
    )
    return res.stdout.strip()


def _request_with_retry(req: urllib.request.Request, max_retries: int = 5) -> dict | None:
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req) as resp:
                content = resp.read().decode()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                sleep_time = 1.5 * (attempt + 1)
                time.sleep(sleep_time)
                continue
            err_body = e.read().decode()
            if "already destroyed" in err_body.lower() or "not in state" in err_body.lower():
                return {}
            sys.stderr.write(f"HTTPError {e.code}: {err_body[:100]}\n")
            return None
        except Exception as e:
            time.sleep(1.0 * (attempt + 1))
    return None


def _get_all_secrets(project: str, token: str) -> list[str]:
    secrets = []
    page_token = None
    headers = {"Authorization": f"Bearer {token}"}
    while True:
        url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets?pageSize=500"
        if page_token:
            url += f"&pageToken={page_token}"
        req = urllib.request.Request(url, headers=headers)
        data = _request_with_retry(req)
        if not data:
            break
        for s in data.get("secrets", []):
            name = s["name"].split("/")[-1]
            secrets.append(name)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return secrets


def _get_enabled_versions(project: str, secret: str, token: str) -> list[int]:
    versions = []
    page_token = None
    headers = {"Authorization": f"Bearer {token}"}
    while True:
        url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{secret}/versions?filter=state:ENABLED&pageSize=1000"
        if page_token:
            url += f"&pageToken={page_token}"
        req = urllib.request.Request(url, headers=headers)
        data = _request_with_retry(req)
        if not data:
            break
        for v in data.get("versions", []):
            v_num = int(v["name"].split("/")[-1])
            versions.append(v_num)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    versions.sort()
    return versions


def _destroy_version(project: str, secret: str, version: int, token: str, limiter: RateLimiter) -> bool:
    limiter.acquire()
    url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{secret}/versions/{version}:destroy"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
    data = _request_with_retry(req, max_retries=4)
    return data is not None


def prune_project(project: str, keep: int = 1, dry_run: bool = False, rate: float = 8.0) -> dict[str, int]:
    token = _get_access_token()
    limiter = RateLimiter(max_per_second=rate)

    print(f"[*] Discovering secrets in project: {project}...", flush=True)
    secrets = _get_all_secrets(project, token)
    print(f"[*] Found {len(secrets)} secrets in {project}.", flush=True)

    print("[*] Auditing enabled versions across all secrets...", flush=True)
    secret_versions: dict[str, list[int]] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_get_enabled_versions, project, s, token): s for s in secrets}
        for fut in as_completed(futures):
            s = futures[fut]
            secret_versions[s] = fut.result()

    total_enabled = sum(len(v) for v in secret_versions.values())
    print(f"[*] Total active ENABLED versions currently in {project}: {total_enabled}", flush=True)

    to_destroy: list[tuple[str, int]] = []
    # Sort secrets by count descending so biggest bloated secrets are cleaned first
    sorted_secrets = sorted(secret_versions.items(), key=lambda x: len(x[1]), reverse=True)
    for s, v_list in sorted_secrets:
        if len(v_list) > keep:
            excess = v_list[:-keep]
            for v_num in excess:
                to_destroy.append((s, v_num))

    print(f"[*] Target policy: keep newest {keep} version(s) per secret", flush=True)
    print(f"[*] Total stale versions to destroy: {len(to_destroy)}", flush=True)

    if not to_destroy:
        print(f"[+] Project {project} is already completely clean!", flush=True)
        return {"total_enabled": total_enabled, "destroyed": 0, "remaining": total_enabled}

    if dry_run:
        print(f"[*] Dry run mode enabled for {project}. No versions were destroyed.", flush=True)
        return {"total_enabled": total_enabled, "destroyed": 0, "remaining": total_enabled}

    print(f"[*] Destroying {len(to_destroy)} stale versions (rate-limited to {rate} req/sec)...", flush=True)
    success_count = 0
    fail_count = 0

    with ThreadPoolExecutor(max_workers=12) as ex:
        futures = {
            ex.submit(_destroy_version, project, s, v, token, limiter): (s, v)
            for s, v in to_destroy
        }
        done = 0
        total = len(to_destroy)
        for fut in as_completed(futures):
            done += 1
            if fut.result():
                success_count += 1
            else:
                fail_count += 1
            if done % 200 == 0 or done == total:
                print(f"    Progress [{project}]: {done}/{total} versions processed ({success_count} destroyed, {fail_count} failed)...", flush=True)

    remaining = total_enabled - success_count
    print(f"[+] Cleanup complete for {project}!", flush=True)
    print(f"    Successfully destroyed: {success_count} versions", flush=True)
    if fail_count > 0:
        print(f"    Failed: {fail_count} versions", flush=True)
    print(f"    Remaining active versions: {remaining}", flush=True)
    return {"total_enabled": total_enabled, "destroyed": success_count, "remaining": remaining}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="hushh-pda-uat", help="GCP project ID (or 'all' for dev, uat, prod)")
    parser.add_argument("--keep", type=int, default=1, help="Number of latest versions to keep")
    parser.add_argument("--dry-run", action="store_true", help="Report without destroying")
    parser.add_argument("--rate", type=float, default=8.0, help="Max requests per second (GCP quota is 10/sec)")
    args = parser.parse_args()

    if args.project == "all":
        projects = ["hushh-pda-uat", "hushh-pda-dev", "hushh-pda"]
    else:
        projects = [args.project]

    for p in projects:
        print(f"\n=======================================================", flush=True)
        print(f"=== Running Secret Manager Prune on: {p} ===", flush=True)
        print(f"=======================================================", flush=True)
        prune_project(p, keep=args.keep, dry_run=args.dry_run, rate=args.rate)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
