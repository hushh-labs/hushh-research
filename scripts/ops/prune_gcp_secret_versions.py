#!/usr/bin/env python3
"""Read-only Secret Manager version inventory; deletion is not qualified.

Age alone does not establish that a version is unused by serving revisions,
rollback revisions, jobs or aliases. This tool never destroys versions.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

def _get_access_token() -> str:
    res = subprocess.run(
        ["gcloud", "auth", "application-default", "print-access-token"],
        capture_output=True,
        text=True,
        check=True,
    )
    return res.stdout.strip()


def _request_with_retry(req: urllib.request.Request, max_retries: int = 5) -> dict:
    if req.get_method() != "GET":
        raise ValueError("Secret version inventory permits GET only")
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                content = resp.read().decode()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code != 429 and exc.code < 500:
                raise RuntimeError(f"Secret inventory unavailable (HTTP {exc.code})") from None
        except (urllib.error.URLError, TimeoutError):
            pass
        if attempt + 1 < max_retries:
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("Secret inventory unavailable; no complete inventory established")


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
        for v in data.get("versions", []):
            v_num = int(v["name"].split("/")[-1])
            versions.append(v_num)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    versions.sort()
    return versions


def prune_project(project: str, keep: int = 1, dry_run: bool = True, rate: float = 8.0) -> dict[str, int]:
    if not dry_run:
        raise ValueError("Secret version deletion requires qualified reference-aware cleanup")
    if keep < 1 or rate <= 0:
        raise ValueError("keep and rate must be positive")
    token = _get_access_token()

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

    candidates = sum(max(0, len(versions) - keep) for versions in secret_versions.values())
    print(f"[*] Versions beyond newest {keep}: {candidates} (references not checked)", flush=True)
    print(f"[*] Read-only inventory for {project}; all versions retained.", flush=True)
    return {"total_enabled": total_enabled, "destroyed": 0, "remaining": total_enabled}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="hushh-pda-uat", help="GCP project ID (or 'all' for dev, uat, prod)")
    parser.add_argument("--keep", type=int, default=1, help="Number of latest versions to keep")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Read-only (always enabled)")
    parser.add_argument("--rate", type=float, default=8.0, help="Legacy compatibility option; no writes occur")
    args = parser.parse_args()

    if args.project == "all":
        projects = ["hushh-pda-uat", "hushh-pda-dev", "hushh-pda"]
    else:
        projects = [args.project]

    for p in projects:
        print(f"\n=======================================================", flush=True)
        print(f"=== Secret Manager read-only inventory: {p} ===", flush=True)
        print(f"=======================================================", flush=True)
        prune_project(p, keep=args.keep, dry_run=args.dry_run, rate=args.rate)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
